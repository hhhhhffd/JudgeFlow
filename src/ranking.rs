//! Pure ranking engine (SPEC §5). All comparisons use exact rationals;
//! values are rounded half-up to hundredths only when producing output.

use std::cmp::Reverse;
use std::collections::HashMap;

use num_bigint::BigInt;
use num_rational::BigRational;
use num_traits::ToPrimitive;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Official,
    Provisional,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Input {
    /// Team ids in display order.
    pub teams: Vec<String>,
    /// Criteria in display order.
    pub criteria: Vec<CriterionInput>,
    /// Judges in display order.
    pub judges: Vec<JudgeInput>,
    /// Scores referencing unknown teams, criteria or judges are ignored.
    pub scores: Vec<ScoreInput>,
    pub quorum: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CriterionInput {
    pub id: String,
    pub max_x100: i64,
    pub weight: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JudgeInput {
    pub id: String,
    pub is_active: bool,
    pub submitted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScoreInput {
    pub judge_id: String,
    pub team_id: String,
    pub criterion_id: String,
    pub value_x100: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ranking {
    pub mode: Mode,
    pub quorum: u32,
    pub rows: Vec<Row>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Row {
    pub rank: Option<u32>,
    pub tie: bool,
    pub team_id: String,
    pub score_x100: Option<i64>,
    pub sheets: u32,
    pub meets_quorum: bool,
    pub criteria: Vec<CriterionAvg>,
    pub judges: Vec<JudgeScore>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CriterionAvg {
    pub criterion_id: String,
    pub avg_x100: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JudgeScore {
    pub judge_id: String,
    pub score_x100: i64,
}

/// Team row before ranking; `exact` keeps the unrounded score used for ordering.
struct Scored {
    row: Row,
    exact: Option<BigRational>,
}

/// Computes the ranking of `input.teams` according to `mode`.
///
/// Output rows are ordered: ranked teams (best first, ties in team order),
/// then teams without any included sheet in team order.
pub fn compute(input: &Input, mode: Mode) -> Ranking {
    let scores: HashMap<(&str, &str, &str), i64> = input
        .scores
        .iter()
        .map(|s| {
            (
                (
                    s.judge_id.as_str(),
                    s.team_id.as_str(),
                    s.criterion_id.as_str(),
                ),
                s.value_x100,
            )
        })
        .collect();

    let weight_sum: i64 = input.criteria.iter().map(|c| c.weight).sum();

    let mut scored: Vec<Scored> = input
        .teams
        .iter()
        .map(|team_id| {
            let mut judge_scores = Vec::new();
            let mut exact_scores = Vec::new();
            let mut value_sums = vec![0i64; input.criteria.len()];

            for judge in input
                .judges
                .iter()
                .filter(|j| j.is_active && (mode == Mode::Provisional || j.submitted))
            {
                let values: Option<Vec<i64>> = input
                    .criteria
                    .iter()
                    .map(|c| {
                        scores
                            .get(&(judge.id.as_str(), team_id.as_str(), c.id.as_str()))
                            .copied()
                    })
                    .collect();
                // An incomplete sheet is excluded; a missing score is never 0.
                let Some(values) = values else { continue };
                if input.criteria.is_empty() || weight_sum == 0 {
                    continue;
                }

                let weighted: BigRational = input
                    .criteria
                    .iter()
                    .zip(&values)
                    .map(|(c, &v)| ratio(c.weight * v, c.max_x100))
                    .sum();
                let judge_score = weighted * BigRational::from_integer(BigInt::from(100))
                    / BigRational::from_integer(BigInt::from(weight_sum));

                for (sum, v) in value_sums.iter_mut().zip(&values) {
                    *sum += v;
                }
                judge_scores.push(JudgeScore {
                    judge_id: judge.id.clone(),
                    score_x100: to_hundredths(&judge_score),
                });
                exact_scores.push(judge_score);
            }

            let sheets = exact_scores.len() as u32;
            let exact = (sheets > 0).then(|| {
                let total: BigRational = exact_scores.into_iter().sum();
                total / BigRational::from_integer(BigInt::from(sheets))
            });
            let criteria = input
                .criteria
                .iter()
                .zip(&value_sums)
                .map(|(c, &sum)| CriterionAvg {
                    criterion_id: c.id.clone(),
                    avg_x100: (sheets > 0).then(|| round_half_up(&ratio(sum, i64::from(sheets)))),
                })
                .collect();

            Scored {
                row: Row {
                    rank: None,
                    tie: false,
                    team_id: team_id.clone(),
                    score_x100: exact.as_ref().map(to_hundredths),
                    sheets,
                    meets_quorum: sheets >= input.quorum,
                    criteria,
                    judges: judge_scores,
                },
                exact,
            }
        })
        .collect();

    // Stable sort keeps team order among equals and among unscored teams.
    scored.sort_by(|a, b| match (&a.exact, &b.exact) {
        (Some(x), Some(y)) => (
            Reverse(a.row.meets_quorum),
            Reverse(x),
            Reverse(a.row.sheets),
        )
            .cmp(&(
                Reverse(b.row.meets_quorum),
                Reverse(y),
                Reverse(b.row.sheets),
            )),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });

    let key = |s: &Scored| (s.row.meets_quorum, s.exact.clone(), s.row.sheets);
    let mut ranks: Vec<Option<u32>> = Vec::with_capacity(scored.len());
    for (i, s) in scored.iter().enumerate() {
        ranks.push(match (&s.exact, i.checked_sub(1)) {
            (None, _) => None,
            (Some(_), Some(prev)) if key(&scored[prev]) == key(s) => ranks[prev],
            (Some(_), _) => Some(i as u32 + 1),
        });
    }
    let mut rows: Vec<Row> = scored.into_iter().map(|s| s.row).collect();
    for (row, rank) in rows.iter_mut().zip(&ranks) {
        row.rank = *rank;
    }
    for i in 0..rows.len() {
        let shares = |j: usize| rows[i].rank.is_some() && rows[j].rank == rows[i].rank;
        rows[i].tie = (i > 0 && shares(i - 1)) || (i + 1 < rows.len() && shares(i + 1));
    }

    Ranking {
        mode,
        quorum: input.quorum,
        rows,
    }
}

fn ratio(numer: i64, denom: i64) -> BigRational {
    BigRational::new(BigInt::from(numer), BigInt::from(denom))
}

/// Converts a 0..=100 score to hundredths, rounded half-up.
fn to_hundredths(score: &BigRational) -> i64 {
    round_half_up(&(score * BigRational::from_integer(BigInt::from(100))))
}

/// Rounds a non-negative rational to the nearest integer, halves up.
fn round_half_up(value: &BigRational) -> i64 {
    (value + ratio(1, 2))
        .floor()
        .to_integer()
        .to_i64()
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn criterion(id: &str, max_x100: i64, weight: i64) -> CriterionInput {
        CriterionInput {
            id: id.into(),
            max_x100,
            weight,
        }
    }

    fn judge(id: &str, is_active: bool, submitted: bool) -> JudgeInput {
        JudgeInput {
            id: id.into(),
            is_active,
            submitted,
        }
    }

    fn score(judge: &str, team: &str, criterion: &str, value_x100: i64) -> ScoreInput {
        ScoreInput {
            judge_id: judge.into(),
            team_id: team.into(),
            criterion_id: criterion.into(),
            value_x100,
        }
    }

    fn input(
        teams: &[&str],
        criteria: Vec<CriterionInput>,
        judges: Vec<JudgeInput>,
        scores: Vec<ScoreInput>,
    ) -> Input {
        Input {
            teams: teams.iter().map(|t| t.to_string()).collect(),
            criteria,
            judges,
            scores,
            quorum: 1,
        }
    }

    fn ranks(r: &Ranking) -> Vec<(&str, Option<u32>, bool)> {
        r.rows
            .iter()
            .map(|row| (row.team_id.as_str(), row.rank, row.tie))
            .collect()
    }

    #[test]
    fn empty_input() {
        let r = compute(&input(&[], vec![], vec![], vec![]), Mode::Official);
        assert_eq!(r.rows, vec![]);
        assert_eq!(r.mode, Mode::Official);
    }

    #[test]
    fn team_without_sheets_has_no_rank() {
        let i = input(
            &["a", "b"],
            vec![criterion("c", 1000, 1)],
            vec![judge("j", true, true)],
            vec![],
        );
        let r = compute(&i, Mode::Official);
        assert_eq!(ranks(&r), vec![("a", None, false), ("b", None, false)]);
        assert_eq!(r.rows[0].score_x100, None);
        assert_eq!(r.rows[0].sheets, 0);
        assert!(!r.rows[0].meets_quorum);
        assert_eq!(r.rows[0].criteria[0].avg_x100, None);
    }

    #[test]
    fn missing_score_is_not_zero() {
        let i = input(
            &["a", "b"],
            vec![criterion("c1", 1000, 1), criterion("c2", 1000, 1)],
            vec![judge("j", true, true)],
            vec![
                score("j", "a", "c1", 1000),
                // team a is missing c2: sheet is incomplete
                score("j", "b", "c1", 500),
                score("j", "b", "c2", 500),
            ],
        );
        let r = compute(&i, Mode::Official);
        assert_eq!(ranks(&r), vec![("b", Some(1), false), ("a", None, false)]);
        assert_eq!(r.rows[0].score_x100, Some(5000));
        assert_eq!(r.rows[1].sheets, 0);
    }

    #[test]
    fn weights_and_different_max_values() {
        // c1: 5/10 weight 3, c2: 100/100 weight 1 -> (3*0.5 + 1*1) / 4 = 62.5
        let i = input(
            &["a"],
            vec![criterion("c1", 1000, 3), criterion("c2", 10000, 1)],
            vec![judge("j", true, true)],
            vec![score("j", "a", "c1", 500), score("j", "a", "c2", 10000)],
        );
        let r = compute(&i, Mode::Official);
        assert_eq!(r.rows[0].score_x100, Some(6250));
        assert_eq!(
            r.rows[0].judges,
            vec![JudgeScore {
                judge_id: "j".into(),
                score_x100: 6250
            }]
        );
        let avgs: Vec<_> = r.rows[0].criteria.iter().map(|c| c.avg_x100).collect();
        assert_eq!(avgs, vec![Some(500), Some(10000)]);
    }

    #[test]
    fn official_vs_provisional() {
        let i = input(
            &["a"],
            vec![criterion("c", 1000, 1)],
            vec![
                judge("done", true, true),
                judge("pending", true, false),
                judge("inactive", false, true),
            ],
            vec![
                score("done", "a", "c", 1000),
                score("pending", "a", "c", 500),
                score("inactive", "a", "c", 0),
            ],
        );
        let official = compute(&i, Mode::Official);
        assert_eq!(official.rows[0].sheets, 1);
        assert_eq!(official.rows[0].score_x100, Some(10000));

        let provisional = compute(&i, Mode::Provisional);
        assert_eq!(provisional.rows[0].sheets, 2);
        assert_eq!(provisional.rows[0].score_x100, Some(7500));
        let ids: Vec<_> = provisional.rows[0]
            .judges
            .iter()
            .map(|j| j.judge_id.as_str())
            .collect();
        assert_eq!(ids, vec!["done", "pending"]);
    }

    #[test]
    fn quorum_outranks_higher_score() {
        let mut i = input(
            &["lone", "pair"],
            vec![criterion("c", 1000, 1)],
            vec![judge("j1", true, true), judge("j2", true, true)],
            vec![
                score("j1", "lone", "c", 1000),
                score("j1", "pair", "c", 600),
                score("j2", "pair", "c", 600),
            ],
        );
        i.quorum = 2;
        let r = compute(&i, Mode::Official);
        assert_eq!(
            ranks(&r),
            vec![("pair", Some(1), false), ("lone", Some(2), false)]
        );
        assert!(r.rows[0].meets_quorum);
        assert!(!r.rows[1].meets_quorum);
        assert_eq!(r.quorum, 2);
    }

    #[test]
    fn more_sheets_break_equal_score() {
        let i = input(
            &["a", "b"],
            vec![criterion("c", 1000, 1)],
            vec![judge("j1", true, true), judge("j2", true, true)],
            vec![
                score("j1", "a", "c", 500),
                score("j1", "b", "c", 500),
                score("j2", "b", "c", 500),
            ],
        );
        let r = compute(&i, Mode::Official);
        assert_eq!(
            ranks(&r),
            vec![("b", Some(1), false), ("a", Some(2), false)]
        );
    }

    #[test]
    fn exact_tie_that_floats_would_split() {
        // a: 1/3 + 1/3 -> mean 1/3. b: 1/6 and 1/2 -> mean 1/3. Equal only in exact arithmetic.
        let i = input(
            &["a", "b"],
            vec![criterion("c", 300, 1)],
            vec![judge("j1", true, true), judge("j2", true, true)],
            vec![
                score("j1", "a", "c", 100),
                score("j2", "a", "c", 100),
                score("j1", "b", "c", 50),
                score("j2", "b", "c", 150),
            ],
        );
        let r = compute(&i, Mode::Official);
        assert_eq!(ranks(&r), vec![("a", Some(1), true), ("b", Some(1), true)]);
        assert_eq!(r.rows[0].score_x100, Some(3333));
    }

    #[test]
    fn tie_not_split_by_rounding_and_not_merged_by_it() {
        // 1/3*100 = 33.333.. vs 33.3349..: both round to 3333/3333 but exact values differ.
        let i = input(
            &["a", "b"],
            vec![criterion("c", 3_000_000, 1)],
            vec![judge("j", true, true)],
            vec![
                score("j", "a", "c", 1_000_000),
                score("j", "b", "c", 1_000_001),
            ],
        );
        let r = compute(&i, Mode::Official);
        assert_eq!(r.rows[0].score_x100, r.rows[1].score_x100);
        assert_eq!(
            ranks(&r),
            vec![("b", Some(1), false), ("a", Some(2), false)]
        );
    }

    #[test]
    fn competition_ranking_1_1_3() {
        let i = input(
            &["a", "b", "c", "d"],
            vec![criterion("c", 1000, 1)],
            vec![judge("j", true, true)],
            vec![
                score("j", "a", "c", 900),
                score("j", "b", "c", 500),
                score("j", "c", "c", 900),
            ],
        );
        let r = compute(&i, Mode::Official);
        assert_eq!(
            ranks(&r),
            vec![
                ("a", Some(1), true),
                ("c", Some(1), true),
                ("b", Some(3), false),
                ("d", None, false)
            ]
        );
    }

    #[test]
    fn rounding_is_half_up() {
        // single criterion, max 20000: value 1 -> 100 * 1/20000 = 0.005 -> 0.5 hundredths -> 1.
        let i = input(
            &["a", "b"],
            vec![criterion("c", 20000, 1)],
            vec![judge("j", true, true)],
            vec![score("j", "a", "c", 1), score("j", "b", "c", 3)],
        );
        let r = compute(&i, Mode::Official);
        // b: 0.015 -> 1.5 hundredths -> 2; a: 0.5 -> 1
        assert_eq!(r.rows[0].score_x100, Some(2));
        assert_eq!(r.rows[1].score_x100, Some(1));

        // per-criterion average 2.5 hundredths -> 3
        let i = input(
            &["a"],
            vec![criterion("c", 1000, 1)],
            vec![judge("j1", true, true), judge("j2", true, true)],
            vec![score("j1", "a", "c", 2), score("j2", "a", "c", 3)],
        );
        let r = compute(&i, Mode::Official);
        assert_eq!(r.rows[0].criteria[0].avg_x100, Some(3));
    }

    #[test]
    fn unknown_references_are_ignored() {
        let i = input(
            &["a"],
            vec![criterion("c", 1000, 1)],
            vec![judge("j", true, true)],
            vec![
                score("j", "a", "c", 1000),
                score("j", "ghost", "c", 1000),
                score("j", "a", "ghost", 0),
                score("ghost", "a", "c", 0),
            ],
        );
        let r = compute(&i, Mode::Official);
        assert_eq!(r.rows.len(), 1);
        assert_eq!(r.rows[0].sheets, 1);
        assert_eq!(r.rows[0].score_x100, Some(10000));
    }

    #[test]
    fn judges_ordered_by_input_order() {
        let i = input(
            &["a"],
            vec![criterion("c", 1000, 1)],
            vec![judge("z", true, true), judge("a", true, true)],
            vec![score("a", "a", "c", 1000), score("z", "a", "c", 0)],
        );
        let r = compute(&i, Mode::Official);
        let ids: Vec<_> = r.rows[0]
            .judges
            .iter()
            .map(|j| j.judge_id.as_str())
            .collect();
        assert_eq!(ids, vec!["z", "a"]);
    }

    #[test]
    fn mode_serializes_lowercase() {
        assert_eq!(
            serde_json::to_string(&Mode::Official).unwrap(),
            "\"official\""
        );
        assert_eq!(
            serde_json::to_string(&Mode::Provisional).unwrap(),
            "\"provisional\""
        );
    }

    #[test]
    fn ranking_roundtrips_through_json() {
        let i = input(
            &["a"],
            vec![criterion("c", 1000, 1)],
            vec![judge("j", true, true)],
            vec![score("j", "a", "c", 700)],
        );
        let r = compute(&i, Mode::Provisional);
        let back: Ranking = serde_json::from_str(&serde_json::to_string(&r).unwrap()).unwrap();
        assert_eq!(back, r);
    }
}
