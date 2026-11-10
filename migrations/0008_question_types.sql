ALTER TABLE form_questions ADD COLUMN kind TEXT NOT NULL DEFAULT 'single_choice'
    CHECK (kind IN ('single_choice', 'multiple_choice', 'text'));
ALTER TABLE form_questions ADD COLUMN required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0, 1));

CREATE TABLE team_form_answers_new (
    team_id     TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
    question_id TEXT NOT NULL REFERENCES form_questions (id) ON DELETE CASCADE,
    option_ids  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(option_ids) AND json_type(option_ids) = 'array'),
    text        TEXT NOT NULL DEFAULT '',
    edited_by   TEXT NOT NULL REFERENCES event_users (id) ON DELETE CASCADE,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (team_id, question_id)
);
INSERT INTO team_form_answers_new (team_id, question_id, option_ids, edited_by, updated_at)
    SELECT team_id, question_id, json_array(option_id), edited_by, updated_at FROM team_form_answers;
DROP TABLE team_form_answers;
ALTER TABLE team_form_answers_new RENAME TO team_form_answers;
