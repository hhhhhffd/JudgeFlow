-- Tracks, judge-team assignments and conflicts (SPEC section 12).
-- ADD COLUMN with REFERENCES is allowed because the default is NULL.

CREATE TABLE tracks (
    id          TEXT PRIMARY KEY,
    event_id    TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    sort_order  INTEGER NOT NULL
);
CREATE INDEX tracks_event_id ON tracks (event_id);

ALTER TABLE teams ADD COLUMN track_id TEXT REFERENCES tracks (id) ON DELETE SET NULL;
CREATE INDEX teams_track_id ON teams (track_id);

-- NULL = the criterion applies to every team.
ALTER TABLE criteria ADD COLUMN track_id TEXT REFERENCES tracks (id) ON DELETE CASCADE;
CREATE INDEX criteria_track_id ON criteria (track_id);

CREATE TABLE assignments (
    judge_id  TEXT NOT NULL REFERENCES judges (id) ON DELETE CASCADE,
    team_id   TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
    PRIMARY KEY (judge_id, team_id)
);
CREATE INDEX assignments_team_id ON assignments (team_id);

CREATE TABLE conflicts (
    judge_id  TEXT NOT NULL REFERENCES judges (id) ON DELETE CASCADE,
    team_id   TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
    PRIMARY KEY (judge_id, team_id)
);
CREATE INDEX conflicts_team_id ON conflicts (team_id);

ALTER TABLE events ADD COLUMN stage_track_id TEXT REFERENCES tracks (id) ON DELETE SET NULL;
CREATE INDEX events_stage_track_id ON events (stage_track_id);
