CREATE TABLE space_board_whiteboard (
    space_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    board_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    revision BIGINT NOT NULL DEFAULT 0,
    strokes_json LONGTEXT NOT NULL CHECK (JSON_VALID(strokes_json)),
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (space_id, board_id),
    CONSTRAINT fk_whiteboard_space FOREIGN KEY (space_id) REFERENCES town_space(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE space_board_whiteboard_operation (
    space_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    board_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (space_id, board_id, operation_id),
    CONSTRAINT fk_whiteboard_operation_document FOREIGN KEY (space_id, board_id)
        REFERENCES space_board_whiteboard(space_id, board_id) ON DELETE CASCADE,
    INDEX ix_whiteboard_operation_retention (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
