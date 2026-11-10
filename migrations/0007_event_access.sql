ALTER TABLE events ADD COLUMN workflow_phase TEXT NOT NULL DEFAULT 'setup'
    CHECK (workflow_phase IN ('setup', 'teachers', 'students', 'finished'));

CREATE TABLE event_users (
    id               TEXT PRIMARY KEY,
    event_id         TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    team_id          TEXT REFERENCES teams (id) ON DELETE SET NULL,
    name             TEXT NOT NULL,
    role             TEXT NOT NULL CHECK (role IN ('organizer', 'jury', 'teacher', 'student')),
    password_hash    TEXT NOT NULL,
    magic_token_hash TEXT NOT NULL UNIQUE,
    is_active        INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at       INTEGER NOT NULL
);
CREATE INDEX event_users_event_role ON event_users (event_id, role);
CREATE INDEX event_users_team ON event_users (team_id);

CREATE TABLE event_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES event_users (id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX event_sessions_user ON event_sessions (user_id);
CREATE INDEX event_sessions_expires ON event_sessions (expires_at);

CREATE TABLE form_questions (
    id         TEXT PRIMARY KEY,
    event_id   TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    audience   TEXT NOT NULL CHECK (audience IN ('teacher', 'student')),
    prompt     TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX form_questions_event ON form_questions (event_id, audience, sort_order);

CREATE TABLE form_options (
    id          TEXT PRIMARY KEY,
    question_id TEXT NOT NULL REFERENCES form_questions (id) ON DELETE CASCADE,
    label       TEXT NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX form_options_question ON form_options (question_id, sort_order);

-- Every participant group collaborates on one shared draft per team and audience.
CREATE TABLE team_form_answers (
    team_id     TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
    question_id TEXT NOT NULL REFERENCES form_questions (id) ON DELETE CASCADE,
    option_id   TEXT NOT NULL REFERENCES form_options (id) ON DELETE RESTRICT,
    edited_by   TEXT NOT NULL REFERENCES event_users (id) ON DELETE CASCADE,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (team_id, question_id)
);

CREATE TABLE team_form_submissions (
    team_id      TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
    audience     TEXT NOT NULL CHECK (audience IN ('teacher', 'student')),
    submitted_by TEXT NOT NULL REFERENCES event_users (id) ON DELETE RESTRICT,
    submitted_at INTEGER NOT NULL,
    PRIMARY KEY (team_id, audience)
);
