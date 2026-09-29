ALTER TABLE direct_message
    ADD revision INT UNSIGNED NOT NULL DEFAULT 0,
    ADD edited_at TIMESTAMP(3) NULL DEFAULT NULL,
    ADD deleted_at TIMESTAMP(3) NULL DEFAULT NULL;

CREATE TABLE direct_message_mutation (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    message_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    actor_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    request_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    action VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    revision INT UNSIGNED NOT NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT uq_direct_message_mutation_request UNIQUE (actor_user_id, request_id),
    CONSTRAINT uq_direct_message_mutation_revision UNIQUE (message_id, revision),
    CONSTRAINT fk_direct_message_mutation_message FOREIGN KEY (message_id) REFERENCES direct_message(message_id) ON DELETE CASCADE,
    CONSTRAINT fk_direct_message_mutation_actor FOREIGN KEY (actor_user_id) REFERENCES app_user(id) ON DELETE CASCADE,
    CONSTRAINT ck_direct_message_mutation_action CHECK (action IN ('EDIT','DELETE')),
    INDEX ix_direct_message_mutation_history (message_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
