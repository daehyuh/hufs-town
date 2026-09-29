ALTER TABLE space_map
    ADD COLUMN edit_mode VARCHAR(16) CHARACTER SET ascii NOT NULL DEFAULT 'LEGACY',
    ADD COLUMN edit_sequence BIGINT NOT NULL DEFAULT 0,
    ADD CONSTRAINT ck_space_map_edit_mode CHECK (edit_mode IN ('LEGACY', 'COLLABORATIVE'));

CREATE TABLE map_edit_operation (
    space_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    map_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    sequence_no BIGINT NOT NULL,
    actor_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    actor_name VARCHAR(80) NOT NULL,
    client_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    base_sequence BIGINT NOT NULL,
    undo_of_sequence BIGINT NULL,
    content_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    actions_json JSON NOT NULL CHECK (JSON_VALID(actions_json)),
    inverse_json JSON NOT NULL CHECK (JSON_VALID(inverse_json)),
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (map_id, sequence_no),
    CONSTRAINT uq_map_edit_operation_id UNIQUE (map_id, operation_id),
    CONSTRAINT uq_map_edit_undo UNIQUE (map_id, undo_of_sequence),
    CONSTRAINT fk_map_edit_space FOREIGN KEY (space_id) REFERENCES town_space(id),
    CONSTRAINT fk_map_edit_map FOREIGN KEY (map_id) REFERENCES space_map(map_id) ON DELETE CASCADE,
    CONSTRAINT fk_map_edit_actor FOREIGN KEY (actor_id) REFERENCES app_user(id),
    INDEX ix_map_edit_actor (map_id, actor_id, sequence_no),
    INDEX ix_map_edit_created (space_id, map_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
