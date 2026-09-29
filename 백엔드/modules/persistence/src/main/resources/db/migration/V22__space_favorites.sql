CREATE TABLE space_favorite (
    user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    space_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (user_id, space_id),
    CONSTRAINT fk_space_favorite_user FOREIGN KEY (user_id) REFERENCES app_user(id),
    CONSTRAINT fk_space_favorite_space FOREIGN KEY (space_id) REFERENCES town_space(id),
    INDEX ix_space_favorite_space (space_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
