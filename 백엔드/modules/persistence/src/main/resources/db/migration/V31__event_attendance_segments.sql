ALTER TABLE town_event_attendance
    ADD COLUMN segment_started_at TIMESTAMP(6) NULL AFTER last_seen_at,
    ADD COLUMN segment_count INT UNSIGNED NOT NULL DEFAULT 1 AFTER segment_started_at;

UPDATE town_event_attendance
SET segment_started_at=joined_at
WHERE left_at IS NULL;
