ALTER TABLE user_report
    MODIFY conversation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    MODIFY message_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    MODIFY message_sent_at TIMESTAMP(3) NULL,
    ADD COLUMN source_type VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'DIRECT_MESSAGE',
    ADD COLUMN space_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD COLUMN player_report_day DATE NULL,
    ADD CONSTRAINT ck_user_report_source CHECK (
        (source_type='DIRECT_MESSAGE' AND conversation_id IS NOT NULL AND message_id IS NOT NULL
            AND message_sent_at IS NOT NULL AND space_id IS NULL AND player_report_day IS NULL)
        OR
        (source_type='PLAYER' AND conversation_id IS NULL AND message_id IS NULL
            AND message_sent_at IS NULL AND space_id IS NOT NULL AND player_report_day IS NOT NULL)
    ),
    ADD UNIQUE INDEX uq_user_report_player_day (reporter_user_id,target_user_id,player_report_day);
