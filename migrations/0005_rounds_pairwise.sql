-- no-transaction
-- Rounds, pairwise comparisons and score normalization (SPEC section 13).
--
-- SQLite cannot alter a CHECK constraint, so `events` is rebuilt (the procedure from the SQLite
-- docs). Foreign keys must be OFF during the rebuild: with them ON, DROP TABLE events performs an
-- implicit DELETE that cascades into teams, criteria, judges, scores, ... `PRAGMA foreign_keys`
-- is a no-op inside a transaction, hence the `no-transaction` directive above and the explicit
-- BEGIN/COMMIT below. The migrator uses a single connection, so the pragma applies to the whole file.

PRAGMA foreign_keys = OFF;
BEGIN;

CREATE TABLE events_new (
    id                      TEXT PRIMARY KEY,
    title                   TEXT NOT NULL,
    description             TEXT NOT NULL DEFAULT '',
    starts_at               INTEGER,
    location                TEXT,
    status                  TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'judging', 'locked', 'finalized', 'published')),
    scoring_mode            TEXT NOT NULL DEFAULT 'team'
        CHECK (scoring_mode IN ('team', 'criterion', 'pairwise')),
    notes_enabled           INTEGER NOT NULL DEFAULT 0 CHECK (notes_enabled IN (0, 1)),
    visibility              TEXT NOT NULL DEFAULT 'hidden'
        CHECK (visibility IN ('hidden', 'live_totals', 'live_full')),
    quorum                  INTEGER NOT NULL DEFAULT 1 CHECK (quorum >= 1),
    teams_label             TEXT,
    teams_label_enabled     INTEGER NOT NULL DEFAULT 0 CHECK (teams_label_enabled IN (0, 1)),
    criteria_label          TEXT,
    criteria_label_enabled  INTEGER NOT NULL DEFAULT 0 CHECK (criteria_label_enabled IN (0, 1)),
    alert_enabled           INTEGER NOT NULL DEFAULT 0 CHECK (alert_enabled IN (0, 1)),
    alert_title             TEXT NOT NULL DEFAULT '',
    alert_text              TEXT NOT NULL DEFAULT '',
    alert_align             TEXT NOT NULL DEFAULT 'left' CHECK (alert_align IN ('left', 'center')),
    alert_button_text       TEXT NOT NULL DEFAULT '',
    alert_version           INTEGER NOT NULL DEFAULT 0,
    background_file         TEXT,
    overlay_enabled         INTEGER NOT NULL DEFAULT 0 CHECK (overlay_enabled IN (0, 1)),
    overlay_color           TEXT NOT NULL DEFAULT '#000000',
    overlay_opacity         INTEGER NOT NULL DEFAULT 35 CHECK (overlay_opacity BETWEEN 0 AND 100),
    locked_at               INTEGER,
    created_by              TEXT REFERENCES admins (id) ON DELETE SET NULL,
    created_at              INTEGER NOT NULL,
    updated_at              INTEGER NOT NULL,
    stage_view              TEXT NOT NULL DEFAULT 'waiting'
        CHECK (stage_view IN ('waiting', 'leaderboard', 'podium')),
    stage_top_n             INTEGER NOT NULL DEFAULT 3 CHECK (stage_top_n BETWEEN 1 AND 10),
    stage_revealed          INTEGER NOT NULL DEFAULT 0 CHECK (stage_revealed >= 0),
    stage_track_id          TEXT REFERENCES tracks (id) ON DELETE SET NULL,
    parent_event_id         TEXT REFERENCES events (id) ON DELETE SET NULL,
    round                   INTEGER NOT NULL DEFAULT 1 CHECK (round >= 1),
    normalization           TEXT NOT NULL DEFAULT 'none' CHECK (normalization IN ('none', 'center'))
);

INSERT INTO events_new (
    id, title, description, starts_at, location, status, scoring_mode, notes_enabled, visibility,
    quorum, teams_label, teams_label_enabled, criteria_label, criteria_label_enabled,
    alert_enabled, alert_title, alert_text, alert_align, alert_button_text, alert_version,
    background_file, overlay_enabled, overlay_color, overlay_opacity, locked_at, created_by,
    created_at, updated_at, stage_view, stage_top_n, stage_revealed, stage_track_id
)
SELECT
    id, title, description, starts_at, location, status, scoring_mode, notes_enabled, visibility,
    quorum, teams_label, teams_label_enabled, criteria_label, criteria_label_enabled,
    alert_enabled, alert_title, alert_text, alert_align, alert_button_text, alert_version,
    background_file, overlay_enabled, overlay_color, overlay_opacity, locked_at, created_by,
    created_at, updated_at, stage_view, stage_top_n, stage_revealed, stage_track_id
FROM events;

DROP TABLE events;
ALTER TABLE events_new RENAME TO events;

CREATE INDEX events_created_by ON events (created_by);
CREATE INDEX events_stage_track_id ON events (stage_track_id);
CREATE INDEX events_parent_event_id ON events (parent_event_id);

CREATE TABLE comparisons (
    id          TEXT PRIMARY KEY,
    event_id    TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    judge_id    TEXT NOT NULL REFERENCES judges (id) ON DELETE CASCADE,
    team_a      TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
    team_b      TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
    winner      TEXT CHECK (winner IN ('a', 'b', 'tie')),
    edited_at   INTEGER,
    created_at  INTEGER NOT NULL,
    CHECK (team_a <> team_b)
);
CREATE INDEX comparisons_event_id ON comparisons (event_id);
CREATE INDEX comparisons_judge_id ON comparisons (judge_id);
CREATE INDEX comparisons_team_a ON comparisons (team_a);
CREATE INDEX comparisons_team_b ON comparisons (team_b);

COMMIT;
PRAGMA foreign_keys = ON;
