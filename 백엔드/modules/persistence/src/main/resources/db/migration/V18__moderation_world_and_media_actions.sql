ALTER TABLE user_moderation_action
    DROP CONSTRAINT ck_moderation_action_code,
    ADD CONSTRAINT ck_moderation_action_code CHECK (action_code IN ('CHAT_MUTE','WORLD_KICK','MEDIA_MUTE'));

CREATE TABLE user_world_restriction (
    user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    blocked_until TIMESTAMP(6) NOT NULL,
    report_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    updated_by_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    reason VARCHAR(1000) NOT NULL DEFAULT '',
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_world_restriction_user FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE,
    CONSTRAINT fk_world_restriction_report FOREIGN KEY (report_id) REFERENCES user_report(report_id) ON DELETE SET NULL,
    CONSTRAINT fk_world_restriction_admin FOREIGN KEY (updated_by_user_id) REFERENCES app_user(id) ON DELETE SET NULL,
    INDEX ix_world_restriction_expiry (blocked_until)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE user_media_mute (
    user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    muted_until TIMESTAMP(6) NOT NULL,
    report_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    updated_by_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    reason VARCHAR(1000) NOT NULL DEFAULT '',
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_media_mute_user FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE,
    CONSTRAINT fk_media_mute_report FOREIGN KEY (report_id) REFERENCES user_report(report_id) ON DELETE SET NULL,
    CONSTRAINT fk_media_mute_admin FOREIGN KEY (updated_by_user_id) REFERENCES app_user(id) ON DELETE SET NULL,
    INDEX ix_media_mute_expiry (muted_until)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
