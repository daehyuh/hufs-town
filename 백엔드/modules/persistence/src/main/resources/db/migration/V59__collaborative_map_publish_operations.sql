CREATE TABLE map_publish_operation (
    space_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    map_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    actor_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    client_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    content_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    edit_sequence BIGINT NOT NULL,
    revision_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (map_id, operation_id),
    CONSTRAINT fk_map_publish_space FOREIGN KEY (space_id) REFERENCES town_space(id),
    CONSTRAINT fk_map_publish_map FOREIGN KEY (map_id) REFERENCES space_map(map_id) ON DELETE CASCADE,
    CONSTRAINT fk_map_publish_actor FOREIGN KEY (actor_id) REFERENCES app_user(id),
    CONSTRAINT fk_map_publish_revision FOREIGN KEY (revision_id) REFERENCES map_revision(id),
    INDEX ix_map_publish_actor (space_id, map_id, actor_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
