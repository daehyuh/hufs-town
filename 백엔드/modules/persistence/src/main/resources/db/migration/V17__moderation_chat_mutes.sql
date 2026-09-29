CREATE TABLE user_moderation_action (
    action_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    request_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    report_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    target_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    administrator_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    action_code VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    duration_minutes SMALLINT UNSIGNED NOT NULL,
    effective_until TIMESTAMP(6) NOT NULL,
    note VARCHAR(1000) NOT NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT uq_moderation_action_request UNIQUE (administrator_user_id,request_id),
    CONSTRAINT ck_moderation_action_code CHECK (action_code IN ('CHAT_MUTE')),
    CONSTRAINT fk_moderation_action_report FOREIGN KEY (report_id) REFERENCES user_report(report_id) ON DELETE SET NULL,
    CONSTRAINT fk_moderation_action_target FOREIGN KEY (target_user_id) REFERENCES app_user(id) ON DELETE SET NULL,
    CONSTRAINT fk_moderation_action_admin FOREIGN KEY (administrator_user_id) REFERENCES app_user(id) ON DELETE SET NULL,
    INDEX ix_moderation_action_target (target_user_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE user_chat_restriction (
    user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    muted_until TIMESTAMP(6) NOT NULL,
    report_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    updated_by_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    reason VARCHAR(1000) NOT NULL DEFAULT '',
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_chat_restriction_user FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE,
    CONSTRAINT fk_chat_restriction_report FOREIGN KEY (report_id) REFERENCES user_report(report_id) ON DELETE SET NULL,
    CONSTRAINT fk_chat_restriction_admin FOREIGN KEY (updated_by_user_id) REFERENCES app_user(id) ON DELETE SET NULL,
    INDEX ix_chat_restriction_expiry (muted_until)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
