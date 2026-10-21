-- Deleted scores become tombstones (value_x100 and note NULL, edited_at kept), so
-- last-writer-wins by edited_at also covers deletions. No table references `scores`,
-- so it is safe to recreate it while foreign keys are enforced.

CREATE TABLE scores_new (
    judge_id      TEXT NOT NULL REFERENCES judges (id) ON DELETE CASCADE,
    team_id       TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
    criterion_id  TEXT NOT NULL REFERENCES criteria (id) ON DELETE CASCADE,
    value_x100    INTEGER CHECK (value_x100 IS NULL OR value_x100 >= 0),
    note          TEXT,
    edited_at     INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    PRIMARY KEY (judge_id, team_id, criterion_id)
);

INSERT INTO scores_new (judge_id, team_id, criterion_id, value_x100, note, edited_at, updated_at)
SELECT judge_id, team_id, criterion_id, value_x100, note, edited_at, updated_at FROM scores;

DROP TABLE scores;
ALTER TABLE scores_new RENAME TO scores;

CREATE INDEX scores_team_id ON scores (team_id);
CREATE INDEX scores_criterion_id ON scores (criterion_id);
