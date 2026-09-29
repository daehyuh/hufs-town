CREATE TABLE world_map_node_map (
    node_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    space_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    map_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    applied_sequence BIGINT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    last_seen_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (node_id, space_id, map_id),
    INDEX ix_world_map_node_map_active (space_id, map_id, active, last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE map_outbox_node_target (
    outbox_id BIGINT NOT NULL,
    node_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    acknowledged_at TIMESTAMP(6) NULL,
    expired_at TIMESTAMP(6) NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (outbox_id, node_id),
    INDEX ix_map_outbox_node_target_status (outbox_id, acknowledged_at, expired_at),
    CONSTRAINT fk_map_outbox_node_target_outbox FOREIGN KEY (outbox_id) REFERENCES map_outbox(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
