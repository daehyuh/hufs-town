ALTER TABLE user_social_preference
    ADD COLUMN allow_friend_notifications BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN share_presence_with_friends BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE social_push_outbox (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    friendship_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    event_type VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    recipient_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    actor_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    next_attempt_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    lease_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    lease_until TIMESTAMP(6) NULL DEFAULT NULL,
    attempt_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    delivered_at TIMESTAMP(6) NULL DEFAULT NULL,
    last_error_code VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
    CONSTRAINT uq_social_push_event UNIQUE (friendship_id, event_type, recipient_user_id),
    CONSTRAINT ck_social_push_event_type CHECK (event_type IN ('FRIEND_REQUEST', 'FRIEND_ACCEPTED')),
    CONSTRAINT fk_social_push_friendship FOREIGN KEY (friendship_id) REFERENCES user_friendship(friendship_id) ON DELETE CASCADE,
    CONSTRAINT fk_social_push_recipient FOREIGN KEY (recipient_user_id) REFERENCES app_user(id) ON DELETE CASCADE,
    CONSTRAINT fk_social_push_actor FOREIGN KEY (actor_user_id) REFERENCES app_user(id) ON DELETE CASCADE,
    INDEX ix_social_push_due (delivered_at, next_attempt_at, lease_until, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
