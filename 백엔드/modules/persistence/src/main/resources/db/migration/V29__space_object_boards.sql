CREATE TABLE space_board_post (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    space_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    board_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    author_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    body VARCHAR(2000) NOT NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_board_post_space FOREIGN KEY (space_id) REFERENCES town_space(id) ON DELETE CASCADE,
    CONSTRAINT fk_board_post_author FOREIGN KEY (author_user_id) REFERENCES app_user(id) ON DELETE CASCADE,
    INDEX ix_board_post_recent (space_id, board_id, created_at, id),
    INDEX ix_board_post_rate (space_id, author_user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
