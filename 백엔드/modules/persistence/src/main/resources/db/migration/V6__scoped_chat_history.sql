CREATE TABLE chat_message (
    message_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    space_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    sender_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    sender_player_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    client_message_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    channel VARCHAR(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    zone_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
    sender_name VARCHAR(80) NOT NULL,
    sender_avatar TINYINT NOT NULL,
    body VARCHAR(500) NOT NULL,
    content_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    sent_at TIMESTAMP(3) NOT NULL,
    expires_at TIMESTAMP(6) NOT NULL,
    CONSTRAINT fk_chat_space FOREIGN KEY (space_id) REFERENCES town_space(id) ON DELETE CASCADE,
    CONSTRAINT fk_chat_sender FOREIGN KEY (sender_user_id) REFERENCES app_user(id),
    CONSTRAINT uq_chat_idempotency UNIQUE (space_id, sender_user_id, client_message_id),
    CONSTRAINT ck_chat_channel CHECK (channel IN ('nearby','room')),
    CONSTRAINT ck_chat_avatar CHECK (sender_avatar BETWEEN 0 AND 2),
    INDEX ix_chat_history (space_id, channel, zone_id, sent_at, message_id),
    INDEX ix_chat_retention (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE chat_message_recipient (
    message_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    PRIMARY KEY (message_id, user_id),
    INDEX ix_chat_recipient_history (user_id, message_id),
    CONSTRAINT fk_chat_recipient_message FOREIGN KEY (message_id) REFERENCES chat_message(message_id) ON DELETE CASCADE,
    CONSTRAINT fk_chat_recipient_user FOREIGN KEY (user_id) REFERENCES app_user(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
