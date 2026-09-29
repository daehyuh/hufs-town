-- Serialize outbox sequence allocation until the surrounding message transaction commits.
-- This prevents a later committed event from advancing a polling cursor past an uncommitted lower ID.
CREATE TABLE direct_message_event_sequence (
    singleton_id TINYINT UNSIGNED NOT NULL,
    next_id BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (singleton_id),
    CONSTRAINT ck_dm_event_sequence_singleton CHECK (singleton_id = 1)
) ENGINE=InnoDB;

INSERT INTO direct_message_event_sequence(singleton_id, next_id) VALUES (1, 1);

CREATE TABLE direct_message_event_outbox (
    id BIGINT UNSIGNED NOT NULL,
    event_type VARCHAR(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    origin_node_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    conversation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    message_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    actor_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    reader_membership_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    CONSTRAINT fk_dm_event_message FOREIGN KEY (message_id)
        REFERENCES direct_message(message_id) ON DELETE CASCADE,
    CONSTRAINT fk_dm_event_actor FOREIGN KEY (actor_user_id)
        REFERENCES app_user(id) ON DELETE CASCADE,
    CONSTRAINT fk_dm_event_reader FOREIGN KEY (reader_membership_id)
        REFERENCES direct_conversation_member(membership_id) ON DELETE SET NULL,
    CONSTRAINT ck_dm_event_type CHECK (event_type IN ('MESSAGE', 'MUTATION', 'READ')),
    INDEX ix_dm_event_created (created_at),
    INDEX ix_dm_event_message (message_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE direct_message_event_recipient (
    event_id BIGINT UNSIGNED NOT NULL,
    membership_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    PRIMARY KEY (event_id, membership_id),
    INDEX ix_dm_event_recipient_membership (membership_id, event_id),
    CONSTRAINT fk_dm_event_recipient_event FOREIGN KEY (event_id)
        REFERENCES direct_message_event_outbox(id) ON DELETE CASCADE,
    CONSTRAINT fk_dm_event_recipient_membership FOREIGN KEY (membership_id)
        REFERENCES direct_conversation_member(membership_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
