CREATE TABLE space_access_block (
    space_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    blocked_by_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    blocked_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (space_id,user_id),
    CONSTRAINT fk_space_access_block_space FOREIGN KEY (space_id) REFERENCES town_space(id) ON DELETE CASCADE,
    CONSTRAINT fk_space_access_block_user FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE,
    CONSTRAINT fk_space_access_block_actor FOREIGN KEY (blocked_by_user_id) REFERENCES app_user(id) ON DELETE SET NULL,
    INDEX ix_space_access_block_user (user_id,blocked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
