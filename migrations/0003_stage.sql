-- Stage Mode: controlled reveal of the official ranking on a projector screen (SPEC section 11).

ALTER TABLE events ADD COLUMN stage_view TEXT NOT NULL DEFAULT 'waiting'
    CHECK (stage_view IN ('waiting', 'leaderboard', 'podium'));
ALTER TABLE events ADD COLUMN stage_top_n INTEGER NOT NULL DEFAULT 3
    CHECK (stage_top_n BETWEEN 1 AND 10);
ALTER TABLE events ADD COLUMN stage_revealed INTEGER NOT NULL DEFAULT 0
    CHECK (stage_revealed >= 0);
