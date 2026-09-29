CREATE TABLE space_map (
    space_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    draft_json LONGTEXT NOT NULL CHECK (JSON_VALID(draft_json)),
    draft_version BIGINT NOT NULL DEFAULT 1,
    published_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    published_sequence BIGINT NOT NULL DEFAULT 1,
    lease_token VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    lease_session CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    lease_client CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    lease_fence BIGINT NOT NULL DEFAULT 0,
    lease_until TIMESTAMP(6) NULL,
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_map_space FOREIGN KEY (space_id) REFERENCES town_space(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE map_revision (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    space_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    sequence_no BIGINT NOT NULL,
    document LONGTEXT NOT NULL CHECK (JSON_VALID(document)),
    content_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    actor_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    reason VARCHAR(16) CHARACTER SET ascii NOT NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_revision_space FOREIGN KEY (space_id) REFERENCES town_space(id),
    CONSTRAINT fk_revision_actor FOREIGN KEY (actor_id) REFERENCES app_user(id),
    CONSTRAINT uq_revision_sequence UNIQUE (space_id,sequence_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE map_draft_operation (
    space_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    content_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    saved_version BIGINT NOT NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (space_id,operation_id),
    CONSTRAINT fk_operation_space FOREIGN KEY (space_id) REFERENCES town_space(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE map_outbox (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    space_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    revision_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    sequence_no BIGINT NOT NULL,
    delivered BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_outbox_revision FOREIGN KEY (revision_id) REFERENCES map_revision(id),
    INDEX ix_map_outbox_pending (delivered,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
