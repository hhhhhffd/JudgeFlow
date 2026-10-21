-- JudgeFlow v2 schema (docs/SPEC.md section 3).
-- Timestamps are Unix milliseconds, scores are integers in hundredths.

CREATE TABLE admins (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL UNIQUE,
    role              TEXT NOT NULL CHECK (role IN ('owner', 'admin')),
    totp_secret_enc   BLOB NOT NULL,
    totp_last_step    INTEGER,
    created_at        INTEGER NOT NULL
);
-- At most one owner.
CREATE UNIQUE INDEX admins_single_owner ON admins (role) WHERE role = 'owner';

CREATE TABLE sessions (
    token_hash  TEXT PRIMARY KEY,
    admin_id    TEXT NOT NULL REFERENCES admins (id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
);
CREATE INDEX sessions_admin_id ON sessions (admin_id);
CREATE INDEX sessions_expires_at ON sessions (expires_at);

CREATE TABLE enrollments (
    token_hash  TEXT PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN ('first_start', 'invite')),
    name        TEXT,
    secret_enc  BLOB,
    created_by  TEXT REFERENCES admins (id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
);
CREATE INDEX enrollments_created_by ON enrollments (created_by);
CREATE INDEX enrollments_expires_at ON enrollments (expires_at);

CREATE TABLE events (
    id                      TEXT PRIMARY KEY,
    title                   TEXT NOT NULL,
    description             TEXT NOT NULL DEFAULT '',
    starts_at               INTEGER,
    location                TEXT,
    status                  TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'judging', 'locked', 'finalized', 'published')),
    scoring_mode            TEXT NOT NULL DEFAULT 'team' CHECK (scoring_mode IN ('team', 'criterion')),
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
    updated_at              INTEGER NOT NULL
);
CREATE INDEX events_created_by ON events (created_by);

CREATE TABLE teams (
    id           TEXT PRIMARY KEY,
    event_id     TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    description  TEXT,
    sort_order   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX teams_event_id ON teams (event_id);

CREATE TABLE criteria (
    id           TEXT PRIMARY KEY,
    event_id     TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    description  TEXT,
    max_x100     INTEGER NOT NULL CHECK (max_x100 > 0),
    step_x100    INTEGER NOT NULL CHECK (step_x100 > 0),
    weight       INTEGER NOT NULL DEFAULT 1 CHECK (weight BETWEEN 1 AND 1000),
    sort_order   INTEGER NOT NULL DEFAULT 0,
    CHECK (max_x100 % step_x100 = 0)
);
CREATE INDEX criteria_event_id ON criteria (event_id);

CREATE TABLE judges (
    id             TEXT PRIMARY KEY,
    event_id       TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    token_hash     TEXT NOT NULL UNIQUE,
    is_active      INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    submitted_at   INTEGER,
    last_seen_at   INTEGER,
    pending_count  INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL
);
CREATE INDEX judges_event_id ON judges (event_id);

CREATE TABLE scores (
    judge_id      TEXT NOT NULL REFERENCES judges (id) ON DELETE CASCADE,
    team_id       TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
    criterion_id  TEXT NOT NULL REFERENCES criteria (id) ON DELETE CASCADE,
    value_x100    INTEGER NOT NULL CHECK (value_x100 >= 0),
    note          TEXT,
    edited_at     INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    PRIMARY KEY (judge_id, team_id, criterion_id)
);
CREATE INDEX scores_team_id ON scores (team_id);
CREATE INDEX scores_criterion_id ON scores (criterion_id);

CREATE TABLE result_snapshots (
    id          TEXT PRIMARY KEY,
    event_id    TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    created_by  TEXT REFERENCES admins (id) ON DELETE SET NULL,
    payload     TEXT NOT NULL
);
CREATE INDEX result_snapshots_event_id ON result_snapshots (event_id, created_at);
CREATE INDEX result_snapshots_created_by ON result_snapshots (created_by);

-- No foreign keys on purpose: the log must survive deletion of events and admins.
CREATE TABLE audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id    TEXT,
    admin_id    TEXT,
    action      TEXT NOT NULL,
    details     TEXT NOT NULL DEFAULT '{}',
    created_at  INTEGER NOT NULL
);
CREATE INDEX audit_log_event_id ON audit_log (event_id, id);
