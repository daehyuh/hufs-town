ALTER TABLE town_event_poll
    ADD COLUMN kind ENUM('POLL', 'QUIZ') NOT NULL DEFAULT 'POLL',
    ADD COLUMN correct_option_index TINYINT UNSIGNED NULL,
    ADD CONSTRAINT ck_event_poll_kind_answer CHECK (
        (kind = 'POLL' AND correct_option_index IS NULL)
        OR (kind = 'QUIZ' AND correct_option_index IS NOT NULL)
    );

ALTER TABLE town_event_poll_vote
    ADD COLUMN participant_type ENUM('USER', 'GUEST') NOT NULL DEFAULT 'USER',
    ADD COLUMN participant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD COLUMN is_correct BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN points_awarded SMALLINT UNSIGNED NOT NULL DEFAULT 0;

UPDATE town_event_poll_vote SET participant_id = user_id;

ALTER TABLE town_event_poll_vote
    MODIFY COLUMN user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    MODIFY COLUMN participant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    DROP PRIMARY KEY,
    ADD PRIMARY KEY (poll_id, participant_type, participant_id),
    ADD INDEX ix_event_poll_vote_user (user_id);
