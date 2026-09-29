CREATE TABLE direct_conversation (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    pair_key VARCHAR(73) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT uq_direct_conversation_pair UNIQUE (pair_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE direct_conversation_member (
    conversation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    last_read_at TIMESTAMP(3) NULL DEFAULT NULL,
    last_read_message_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    joined_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (conversation_id, user_id),
    INDEX ix_direct_member_inbox (user_id, last_read_at, conversation_id),
    CONSTRAINT fk_direct_member_conversation FOREIGN KEY (conversation_id) REFERENCES direct_conversation(id) ON DELETE CASCADE,
    CONSTRAINT fk_direct_member_user FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE direct_message (
    message_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    conversation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    sender_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    sender_player_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    client_message_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    sender_name VARCHAR(80) NOT NULL,
    sender_avatar TINYINT NOT NULL,
    sender_skin VARCHAR(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    sender_clothing VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    sender_hair VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    body VARCHAR(500) NOT NULL,
    content_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    sent_at TIMESTAMP(3) NOT NULL,
    expires_at TIMESTAMP(6) NOT NULL,
    CONSTRAINT uq_direct_message_idempotency UNIQUE (conversation_id, sender_user_id, client_message_id),
    CONSTRAINT fk_direct_message_conversation FOREIGN KEY (conversation_id) REFERENCES direct_conversation(id) ON DELETE CASCADE,
    CONSTRAINT fk_direct_message_sender FOREIGN KEY (sender_user_id) REFERENCES app_user(id) ON DELETE CASCADE,
    CONSTRAINT ck_direct_message_avatar CHECK (sender_avatar BETWEEN 0 AND 2),
    INDEX ix_direct_message_history (conversation_id, sent_at, message_id),
    INDEX ix_direct_message_retention (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
