//! Pairwise mode (SPEC §13), pure and free of IO.
//!
//! Two independent parts:
//! * [`compute`] ranks teams from judges' pairwise comparisons with a Bradley–Terry model;
//! * [`next_pairs`] deterministically picks the next pairs a judge should compare.

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::ranking::{JudgeScore, Mode, Ranking, Row};

const MAX_ITERATIONS: usize = 10_000;
const CONVERGENCE: f64 = 1e-12;
/// Scores closer than this (after quantization) share a rank.
const TIE_RESOLUTION: f64 = 1e9;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Winner {
    A,
    B,
    Tie,
}

/// A decided comparison. Undecided (open) pairs must not be passed in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComparisonInput {
    pub judge_id: String,
    pub team_a: String,
    pub team_b: String,
    pub winner: Winner,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JudgeInput {
    pub id: String,
    pub is_active: bool,
    pub submitted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Input {
    /// Team ids in display order.
    pub teams: Vec<String>,
    /// Comparisons referencing unknown teams or judges, or a team against itself, are ignored.
    pub comparisons: Vec<ComparisonInput>,
    /// Judges in display order.
    pub judges: Vec<JudgeInput>,
    pub quorum: u32,
}

/// Explainability counters. `ranking::Row` has no such fields, so the caller merges
/// these into its own row representation by `team_id`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TeamStats {
    pub team_id: String,
    pub wins: u32,
    pub losses: u32,
    pub ties: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairwiseRanking {
    /// Rows are ordered like `ranking::compute`: ranked teams best first, then unranked
    /// teams in input order. `criteria` is empty and `track_id` is `None` (set by the caller).
    pub ranking: Ranking,
    /// One entry per input team, in input order.
    pub stats: Vec<TeamStats>,
}

fn round_half_up(x: f64) -> i64 {
    (x + 0.5).floor() as i64
}

/// Ranks the teams of one group. `score_x100` is 100·s/(s+1) for the Bradley–Terry strength `s`.
pub fn compute(input: &Input, mode: Mode) -> PairwiseRanking {
    let team_index: HashMap<&str, usize> = input
        .teams
        .iter()
        .enumerate()
        .map(|(i, t)| (t.as_str(), i))
        .collect();
    let judge_index: HashMap<&str, usize> = input
        .judges
        .iter()
        .enumerate()
        .map(|(i, j)| (j.id.as_str(), i))
        .collect();

    let n = input.teams.len();
    let mut wins = vec![0u32; n];
    let mut losses = vec![0u32; n];
    let mut ties = vec![0u32; n];
    let mut sheets = vec![0u32; n];
    // Unordered pair (lo, hi) -> number of comparisons between them.
    let mut pair_counts: BTreeMap<(usize, usize), f64> = BTreeMap::new();
    // Half-win totals (virtual tie added later).
    let mut credit = vec![0.0f64; n];
    // Per team, per judge index: (points, comparisons) for the win rate.
    let mut judge_tally: Vec<BTreeMap<usize, (f64, u32)>> = vec![BTreeMap::new(); n];

    for c in &input.comparisons {
        let (Some(&a), Some(&b), Some(&j)) = (
            team_index.get(c.team_a.as_str()),
            team_index.get(c.team_b.as_str()),
            judge_index.get(c.judge_id.as_str()),
        ) else {
            continue;
        };
        let judge = &input.judges[j];
        let counted = judge.is_active && (mode == Mode::Provisional || judge.submitted);
        if a == b || !counted {
            continue;
        }
        let (pa, pb) = match c.winner {
            Winner::A => {
                wins[a] += 1;
                losses[b] += 1;
                (1.0, 0.0)
            }
            Winner::B => {
                wins[b] += 1;
                losses[a] += 1;
                (0.0, 1.0)
            }
            Winner::Tie => {
                ties[a] += 1;
                ties[b] += 1;
                (0.5, 0.5)
            }
        };
        credit[a] += pa;
        credit[b] += pb;
        sheets[a] += 1;
        sheets[b] += 1;
        *pair_counts.entry((a.min(b), a.max(b))).or_insert(0.0) += 1.0;
        for (team, points) in [(a, pa), (b, pb)] {
            let tally = judge_tally[team].entry(j).or_insert((0.0, 0));
            tally.0 += points;
            tally.1 += 1;
        }
    }

    let ranked: Vec<usize> = (0..n).filter(|&i| sheets[i] > 0).collect();
    let strengths = bradley_terry(n, &ranked, &pair_counts, &credit);

    // Quantized probability: equal after rounding to 1e-9 means tied.
    let key = |i: usize| (strengths[i] / (strengths[i] + 1.0) * TIE_RESOLUTION).round() as i64;
    let mut order = ranked.clone();
    order.sort_by(|&x, &y| {
        let meets = |i: usize| sheets[i] >= input.quorum;
        meets(y)
            .cmp(&meets(x))
            .then(key(y).cmp(&key(x)))
            .then(sheets[y].cmp(&sheets[x]))
    });

    let mut rows = Vec::with_capacity(n);
    let mut rank = 0u32;
    for (pos, &i) in order.iter().enumerate() {
        let same = |k: usize| {
            (sheets[k] >= input.quorum, key(k), sheets[k])
                == (sheets[i] >= input.quorum, key(i), sheets[i])
        };
        let tied_prev = pos > 0 && same(order[pos - 1]);
        if !tied_prev {
            rank = pos as u32 + 1;
        }
        let tied_next = order.get(pos + 1).is_some_and(|&k| same(k));
        rows.push(make_row(
            input,
            i,
            Some(rank),
            tied_prev || tied_next,
            Some(round_half_up(
                10_000.0 * strengths[i] / (strengths[i] + 1.0),
            )),
            sheets[i],
            &judge_tally[i],
        ));
    }
    for i in (0..n).filter(|&i| sheets[i] == 0) {
        rows.push(make_row(input, i, None, false, None, 0, &judge_tally[i]));
    }

    PairwiseRanking {
        ranking: Ranking {
            mode,
            quorum: input.quorum,
            rows,
        },
        stats: (0..n)
            .map(|i| TeamStats {
                team_id: input.teams[i].clone(),
                wins: wins[i],
                losses: losses[i],
                ties: ties[i],
            })
            .collect(),
    }
}

fn make_row(
    input: &Input,
    team: usize,
    rank: Option<u32>,
    tie: bool,
    score_x100: Option<i64>,
    sheets: u32,
    tally: &BTreeMap<usize, (f64, u32)>,
) -> Row {
    Row {
        rank,
        tie,
        team_id: input.teams[team].clone(),
        score_x100,
        raw_score_x100: None,
        sheets,
        meets_quorum: sheets >= input.quorum,
        criteria: Vec::new(),
        judges: tally
            .iter()
            .map(|(&j, &(points, count))| JudgeScore {
                judge_id: input.judges[j].id.clone(),
                score_x100: round_half_up(10_000.0 * points / f64::from(count)),
            })
            .collect(),
        track_id: None,
        wins: None,
        losses: None,
        ties: None,
    }
}

/// MM iteration for Bradley–Terry with ties as half wins. Every ranked team also has one
/// virtual tie against a virtual team of strength 1, which keeps strengths finite and positive.
/// Strengths are renormalized to geometric mean 1 after each sweep. Teams outside `ranked` get 1.
fn bradley_terry(
    n: usize,
    ranked: &[usize],
    pair_counts: &BTreeMap<(usize, usize), f64>,
    credit: &[f64],
) -> Vec<f64> {
    let mut neighbours: Vec<Vec<(usize, f64)>> = vec![Vec::new(); n];
    for (&(a, b), &count) in pair_counts {
        neighbours[a].push((b, count));
        neighbours[b].push((a, count));
    }

    let mut s = vec![1.0f64; n];
    for _ in 0..MAX_ITERATIONS {
        let mut next = s.clone();
        for &i in ranked {
            let denom: f64 = neighbours[i]
                .iter()
                .map(|&(j, count)| count / (s[i] + s[j]))
                .sum::<f64>()
                + 1.0 / (s[i] + 1.0);
            next[i] = (credit[i] + 0.5) / denom;
        }
        let log_mean = ranked.iter().map(|&i| next[i].ln()).sum::<f64>() / ranked.len() as f64;
        let scale = log_mean.exp();
        let mut max_change = 0.0f64;
        for &i in ranked {
            next[i] /= scale;
            max_change = max_change.max((next[i] - s[i]).abs() / s[i]);
        }
        s = next;
        if max_change < CONVERGENCE {
            break;
        }
    }
    s
}

fn unordered<'a>(a: &'a str, b: &'a str) -> (&'a str, &'a str) {
    if a <= b { (a, b) } else { (b, a) }
}

/// Picks up to `want` new pairs for one judge, deterministically.
///
/// * `groups`: eligible teams for this judge, in team order, one list per track; pairs never
///   cross groups.
/// * `all_comparisons`: every existing pair (decided or open, all judges), used for balancing.
/// * `judge_seen`: pairs this judge already has (unordered match).
/// * `want`: how many pairs to create; the caller passes `count - open_count`.
///
/// Among unseen pairs it minimizes (times compared overall, sum of both teams' comparison
/// counts); remaining ties go to the earliest pair in team order. Counts are updated after each
/// pick so a batch spreads load. The first team of a returned pair is `team_a`: the pair's
/// original order when its overall count is even, swapped when odd (position-bias control).
pub fn next_pairs(
    groups: &[Vec<String>],
    all_comparisons: &[(String, String)],
    judge_seen: &[(String, String)],
    want: usize,
) -> Vec<(String, String)> {
    let mut pair_counts: HashMap<(&str, &str), usize> = HashMap::new();
    let mut team_counts: HashMap<&str, usize> = HashMap::new();
    for (a, b) in all_comparisons {
        *pair_counts.entry(unordered(a, b)).or_insert(0) += 1;
        *team_counts.entry(a.as_str()).or_insert(0) += 1;
        *team_counts.entry(b.as_str()).or_insert(0) += 1;
    }
    let mut seen: HashSet<(&str, &str)> = judge_seen.iter().map(|(a, b)| unordered(a, b)).collect();

    let mut picked = Vec::new();
    while picked.len() < want {
        let mut best: Option<((usize, usize), &str, &str)> = None;
        for group in groups {
            for (i, a) in group.iter().enumerate() {
                for b in &group[i + 1..] {
                    let pair = unordered(a, b);
                    if a == b || seen.contains(&pair) {
                        continue;
                    }
                    let cost = (
                        pair_counts.get(&pair).copied().unwrap_or(0),
                        team_counts.get(a.as_str()).copied().unwrap_or(0)
                            + team_counts.get(b.as_str()).copied().unwrap_or(0),
                    );
                    if best.is_none_or(|(best_cost, _, _)| cost < best_cost) {
                        best = Some((cost, a, b));
                    }
                }
            }
        }
        let Some(((times, _), a, b)) = best else {
            break;
        };
        let pair = unordered(a, b);
        seen.insert(pair);
        *pair_counts.entry(pair).or_insert(0) += 1;
        *team_counts.entry(a).or_insert(0) += 1;
        *team_counts.entry(b).or_insert(0) += 1;
        picked.push(if times % 2 == 0 {
            (a.to_string(), b.to_string())
        } else {
            (b.to_string(), a.to_string())
        });
    }
    picked
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(x: &str) -> String {
        x.to_string()
    }

    fn judge(id: &str, is_active: bool, submitted: bool) -> JudgeInput {
        JudgeInput {
            id: s(id),
            is_active,
            submitted,
        }
    }

    fn cmp(judge_id: &str, a: &str, b: &str, winner: Winner) -> ComparisonInput {
        ComparisonInput {
            judge_id: s(judge_id),
            team_a: s(a),
            team_b: s(b),
            winner,
        }
    }

    fn input(teams: &[&str], comparisons: Vec<ComparisonInput>) -> Input {
        Input {
            teams: teams.iter().map(|t| s(t)).collect(),
            comparisons,
            judges: vec![judge("j1", true, true)],
            quorum: 1,
        }
    }

    fn row<'a>(r: &'a PairwiseRanking, team: &str) -> &'a Row {
        r.ranking.rows.iter().find(|x| x.team_id == team).unwrap()
    }

    #[test]
    fn clear_winner_chain_orders_teams() {
        let inp = input(
            &["C", "B", "A"],
            vec![
                cmp("j1", "A", "B", Winner::A),
                cmp("j1", "B", "C", Winner::A),
                cmp("j1", "A", "C", Winner::A),
            ],
        );
        let r = compute(&inp, Mode::Official);
        let order: Vec<_> = r.ranking.rows.iter().map(|x| x.team_id.as_str()).collect();
        assert_eq!(order, ["A", "B", "C"]);
        let ranks: Vec<_> = r.ranking.rows.iter().map(|x| x.rank).collect();
        assert_eq!(ranks, [Some(1), Some(2), Some(3)]);
        assert!(
            r.ranking
                .rows
                .iter()
                .all(|x| !x.tie && x.criteria.is_empty())
        );
        assert!(row(&r, "A").score_x100 > row(&r, "B").score_x100);
        assert!(row(&r, "B").score_x100 > row(&r, "C").score_x100);
        let a = r.stats.iter().find(|x| x.team_id == "A").unwrap();
        assert_eq!((a.wins, a.losses, a.ties), (2, 0, 0));
        assert_eq!(
            row(&r, "A").judges,
            [JudgeScore {
                judge_id: s("j1"),
                score_x100: 10_000
            }]
        );
    }

    #[test]
    fn symmetric_results_tie_at_fifty() {
        let inp = input(
            &["A", "B"],
            vec![
                cmp("j1", "A", "B", Winner::A),
                cmp("j1", "A", "B", Winner::B),
            ],
        );
        let r = compute(&inp, Mode::Official);
        for x in &r.ranking.rows {
            assert_eq!((x.rank, x.tie, x.score_x100), (Some(1), true, Some(5000)));
        }
    }

    #[test]
    fn ties_count_half() {
        let tied = input(&["A", "B"], vec![cmp("j1", "A", "B", Winner::Tie)]);
        let r = compute(&tied, Mode::Official);
        assert_eq!(row(&r, "A").score_x100, Some(5000));
        assert!(row(&r, "A").tie);
        let a = r.stats.iter().find(|x| x.team_id == "A").unwrap();
        assert_eq!((a.wins, a.losses, a.ties), (0, 0, 1));
        assert_eq!(row(&r, "A").judges[0].score_x100, 5000);

        // One win + one tie beats a lone win only against the same opponent's record.
        let mixed = input(
            &["A", "B"],
            vec![
                cmp("j1", "A", "B", Winner::A),
                cmp("j1", "A", "B", Winner::Tie),
            ],
        );
        let r = compute(&mixed, Mode::Official);
        assert_eq!(row(&r, "A").rank, Some(1));
        assert_eq!(row(&r, "B").rank, Some(2));
        assert_eq!(row(&r, "A").judges[0].score_x100, 7500);
    }

    #[test]
    fn filters_inactive_and_unsubmitted_judges() {
        let mut inp = input(&["A", "B"], vec![]);
        inp.judges = vec![
            judge("done", true, true),
            judge("draft", true, false),
            judge("off", false, true),
        ];
        inp.comparisons = vec![
            cmp("done", "A", "B", Winner::A),
            cmp("draft", "B", "A", Winner::A),
            cmp("off", "B", "A", Winner::A),
            cmp("ghost", "B", "A", Winner::A),
        ];
        let official = compute(&inp, Mode::Official);
        assert_eq!(row(&official, "A").sheets, 1);
        assert_eq!(row(&official, "A").rank, Some(1));
        let provisional = compute(&inp, Mode::Provisional);
        assert_eq!(row(&provisional, "A").sheets, 2);
        assert_eq!(row(&provisional, "B").sheets, 2);
        assert!(row(&provisional, "A").tie);
    }

    #[test]
    fn quorum_orders_before_score() {
        let mut inp = input(
            &["A", "B", "C"],
            vec![
                cmp("j1", "A", "C", Winner::A),
                cmp("j1", "B", "C", Winner::A),
                cmp("j1", "B", "C", Winner::A),
            ],
        );
        inp.quorum = 2;
        let r = compute(&inp, Mode::Official);
        assert!(!row(&r, "A").meets_quorum);
        assert!(row(&r, "B").meets_quorum && row(&r, "C").meets_quorum);
        let order: Vec<_> = r.ranking.rows.iter().map(|x| x.team_id.as_str()).collect();
        assert_eq!(order, ["B", "C", "A"]);
        assert_eq!(row(&r, "A").rank, Some(3));
    }

    #[test]
    fn team_without_comparisons_is_unranked() {
        let inp = input(&["A", "X", "B"], vec![cmp("j1", "A", "B", Winner::A)]);
        let r = compute(&inp, Mode::Official);
        let x = row(&r, "X");
        assert_eq!(
            (x.rank, x.score_x100, x.sheets, x.tie),
            (None, None, 0, false)
        );
        assert_eq!(r.ranking.rows.last().unwrap().team_id, "X");
        assert_eq!(r.stats.len(), 3);
    }

    #[test]
    fn deterministic() {
        let inp = input(
            &["A", "B", "C", "D"],
            vec![
                cmp("j1", "A", "B", Winner::A),
                cmp("j1", "B", "C", Winner::Tie),
                cmp("j1", "C", "D", Winner::B),
                cmp("j1", "A", "D", Winner::A),
            ],
        );
        assert_eq!(compute(&inp, Mode::Official), compute(&inp, Mode::Official));
    }

    #[test]
    fn cyclic_results_converge_to_equal() {
        let inp = input(
            &["A", "B", "C"],
            vec![
                cmp("j1", "A", "B", Winner::A),
                cmp("j1", "B", "C", Winner::A),
                cmp("j1", "C", "A", Winner::A),
            ],
        );
        let r = compute(&inp, Mode::Official);
        for x in &r.ranking.rows {
            assert_eq!((x.rank, x.tie, x.score_x100), (Some(1), true, Some(5000)));
        }
    }

    fn pairs_of(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("t{i}")).collect()
    }

    #[test]
    fn next_pairs_covers_every_pair_before_repeating() {
        let groups = vec![pairs_of(4)];
        // A different judge each time: the global count drives the choice.
        let mut all: Vec<(String, String)> = Vec::new();
        for round in 0..2 {
            let mut seen_this_round = HashSet::new();
            for _ in 0..6 {
                let p = next_pairs(&groups, &all, &[], 1);
                assert_eq!(p.len(), 1);
                let (a, b) = p[0].clone();
                assert!(
                    seen_this_round.insert(format!(
                        "{}-{}",
                        unordered(&a, &b).0,
                        unordered(&a, &b).1
                    )),
                    "round {round}"
                );
                all.push((a, b));
            }
            assert_eq!(seen_this_round.len(), 6);
        }
    }

    #[test]
    fn next_pairs_batch_is_balanced_and_unseen() {
        let groups = vec![pairs_of(4)];
        let seen = vec![(s("t1"), s("t0"))];
        let batch = next_pairs(&groups, &[], &seen, 10);
        // 6 possible pairs minus 1 seen; never more than that, no duplicates.
        assert_eq!(batch.len(), 5);
        let unique: HashSet<_> = batch.iter().map(|(a, b)| unordered(a, b)).collect();
        assert_eq!(unique.len(), 5);
        assert!(!unique.contains(&("t0", "t1")));
        // Deterministic.
        assert_eq!(batch, next_pairs(&groups, &[], &seen, 10));
        // First pick spreads load: no team appears in two of the first two pairs.
        let first: HashSet<_> = [&batch[0].0, &batch[0].1, &batch[1].0, &batch[1].1]
            .into_iter()
            .collect();
        assert_eq!(first.len(), 4);
    }

    #[test]
    fn next_pairs_stay_within_groups() {
        let groups = vec![vec![s("a1"), s("a2")], vec![s("b1"), s("b2"), s("b3")]];
        let batch = next_pairs(&groups, &[], &[], 100);
        assert_eq!(batch.len(), 1 + 3);
        for (a, b) in &batch {
            assert_eq!(a.chars().next(), b.chars().next());
        }
    }

    #[test]
    fn next_pairs_prefers_less_used_teams_and_alternates_orientation() {
        let groups = vec![vec![s("a"), s("b"), s("c")]];
        // a-b compared once already, a and b are busy; c is fresh.
        let all = vec![(s("a"), s("b"))];
        let batch = next_pairs(&groups, &all, &[], 2);
        assert_eq!(batch, [(s("a"), s("c")), (s("b"), s("c"))]);

        // Odd overall count -> swapped orientation; even -> original order.
        let only = vec![vec![s("a"), s("b")]];
        assert_eq!(next_pairs(&only, &[], &[], 1), [(s("a"), s("b"))]);
        assert_eq!(
            next_pairs(&only, &[(s("a"), s("b"))], &[], 1),
            [(s("b"), s("a"))]
        );
        assert_eq!(
            next_pairs(&only, &[(s("b"), s("a")), (s("a"), s("b"))], &[], 1),
            [(s("a"), s("b"))]
        );
    }
}
