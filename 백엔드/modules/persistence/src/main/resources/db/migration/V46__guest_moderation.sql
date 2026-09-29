ALTER TABLE user_report
    ADD COLUMN target_identity_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'ACCOUNT',
    ADD COLUMN target_guest_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    DROP CONSTRAINT ck_user_report_source,
    ADD CONSTRAINT ck_user_report_target_identity CHECK (
        (target_identity_type='ACCOUNT' AND target_guest_id IS NULL)
        OR (target_identity_type='GUEST' AND target_guest_id IS NOT NULL)
    ),
    ADD CONSTRAINT ck_user_report_source CHECK (
        (source_type='DIRECT_MESSAGE' AND conversation_id IS NOT NULL AND message_id IS NOT NULL
            AND message_sent_at IS NOT NULL AND space_id IS NULL AND player_report_day IS NULL
            AND target_identity_type='ACCOUNT')
        OR
        (source_type='PLAYER' AND conversation_id IS NULL AND message_id IS NULL
            AND message_sent_at IS NULL AND space_id IS NOT NULL AND player_report_day IS NOT NULL)
    ),
    ADD UNIQUE INDEX uq_user_report_guest_player_day (reporter_user_id,target_guest_id,player_report_day);

ALTER TABLE user_moderation_action
    ADD COLUMN target_guest_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD INDEX ix_moderation_action_guest_target (target_guest_id,created_at);

CREATE TABLE guest_moderation_restriction (
    guest_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    chat_muted_until TIMESTAMP(6) NULL,
    media_muted_until TIMESTAMP(6) NULL,
    blocked_until TIMESTAMP(6) NULL,
    report_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    updated_by_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    reason VARCHAR(1000) NOT NULL DEFAULT '',
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_guest_restriction_report FOREIGN KEY (report_id) REFERENCES user_report(report_id) ON DELETE SET NULL,
    CONSTRAINT fk_guest_restriction_admin FOREIGN KEY (updated_by_user_id) REFERENCES app_user(id) ON DELETE SET NULL,
    INDEX ix_guest_restriction_expiry (chat_muted_until,media_muted_until,blocked_until)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
