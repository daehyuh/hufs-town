CREATE TABLE web_push_subscription (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    endpoint_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    endpoint VARCHAR(2048) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    p256dh VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    auth_secret VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    last_seen_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT uq_web_push_endpoint_hash UNIQUE (endpoint_hash),
    CONSTRAINT fk_web_push_subscription_user FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE,
    INDEX ix_web_push_subscription_user (user_id, last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE direct_message_push_outbox (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    message_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    recipient_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    next_attempt_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    lease_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    lease_until TIMESTAMP(6) NULL DEFAULT NULL,
    attempt_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    delivered_at TIMESTAMP(6) NULL DEFAULT NULL,
    last_error_code VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
    CONSTRAINT uq_dm_push_outbox_message_recipient UNIQUE (message_id, recipient_user_id),
    CONSTRAINT fk_dm_push_outbox_message FOREIGN KEY (message_id) REFERENCES direct_message(message_id) ON DELETE CASCADE,
    CONSTRAINT fk_dm_push_outbox_recipient FOREIGN KEY (recipient_user_id) REFERENCES app_user(id) ON DELETE CASCADE,
    INDEX ix_dm_push_outbox_due (delivered_at, next_attempt_at, lease_until, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
