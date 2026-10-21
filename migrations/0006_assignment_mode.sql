-- Explicit assignment mode (SPEC section 12): 0 = every judge scores every team, 1 = judges cover
-- only their assigned teams (even when the assignment list is empty). Previously inferred from
-- the row count, which flipped silently when the last assignment disappeared.
ALTER TABLE events ADD COLUMN assignments_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (assignments_enabled IN (0, 1));

UPDATE events SET assignments_enabled = 1
WHERE EXISTS (
    SELECT 1 FROM assignments a JOIN judges j ON j.id = a.judge_id WHERE j.event_id = events.id
);
