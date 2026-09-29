CREATE TABLE space_room_note (
    space_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    map_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    zone_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
    body VARCHAR(4000) NOT NULL DEFAULT '',
    updated_at TIMESTAMP(6) NULL,
    updated_by_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    updated_by_name VARCHAR(20) NOT NULL DEFAULT '',
    meeting_ended_at TIMESTAMP(6) NULL,
    retention_expires_at TIMESTAMP(6) NULL,
    PRIMARY KEY (space_id, map_id, zone_id),
    CONSTRAINT fk_room_note_space FOREIGN KEY (space_id)
        REFERENCES town_space(id) ON DELETE CASCADE,
    CONSTRAINT fk_room_note_map FOREIGN KEY (map_id)
        REFERENCES space_map(map_id) ON DELETE CASCADE,
    CONSTRAINT fk_room_note_updated_by FOREIGN KEY (updated_by_user_id)
        REFERENCES app_user(id) ON DELETE SET NULL,
    CONSTRAINT ck_room_note_revision CHECK (revision >= 0),
    INDEX ix_room_note_retention (retention_expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE space_room_note_presence (
    space_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    map_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    zone_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    node_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    last_seen_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (space_id, map_id, zone_id, node_id),
    CONSTRAINT fk_room_note_presence_space FOREIGN KEY (space_id)
        REFERENCES town_space(id) ON DELETE CASCADE,
    CONSTRAINT fk_room_note_presence_map FOREIGN KEY (map_id)
        REFERENCES space_map(map_id) ON DELETE CASCADE,
    INDEX ix_room_note_presence_room_heartbeat (space_id, map_id, zone_id, last_seen_at),
    INDEX ix_room_note_presence_heartbeat (last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE space_room_note_revision (
    space_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    map_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    zone_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    request_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    revision BIGINT UNSIGNED NOT NULL,
    request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    author_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    author_name VARCHAR(20) NOT NULL,
    body VARCHAR(4000) NOT NULL,
    edited_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (space_id, map_id, zone_id, request_id),
    CONSTRAINT fk_room_note_revision_document FOREIGN KEY (space_id, map_id, zone_id)
        REFERENCES space_room_note(space_id, map_id, zone_id) ON DELETE CASCADE,
    CONSTRAINT fk_room_note_revision_author FOREIGN KEY (author_user_id)
        REFERENCES app_user(id) ON DELETE SET NULL,
    CONSTRAINT uq_room_note_revision_number UNIQUE (space_id, map_id, zone_id, revision),
    INDEX ix_room_note_revision_history (space_id, map_id, zone_id, revision)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A locked singleton sequence keeps committed outbox IDs in cursor order across nodes.
CREATE TABLE space_room_note_event_sequence (
    singleton_id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
    next_id BIGINT UNSIGNED NOT NULL,
    CONSTRAINT ck_room_note_event_sequence_singleton CHECK (singleton_id = 1)
) ENGINE=InnoDB;

INSERT INTO space_room_note_event_sequence(singleton_id, next_id) VALUES (1, 1);

CREATE TABLE space_room_note_event_outbox (
    id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    origin_node_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    space_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    map_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    zone_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_room_note_outbox_document FOREIGN KEY (space_id, map_id, zone_id)
        REFERENCES space_room_note(space_id, map_id, zone_id) ON DELETE CASCADE,
    INDEX ix_room_note_outbox_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
