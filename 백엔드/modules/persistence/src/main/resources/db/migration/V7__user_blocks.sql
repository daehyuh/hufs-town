CREATE TABLE user_block (
    block_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    blocker_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    blocked_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    blocked_display_name VARCHAR(80) NOT NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT uq_user_block UNIQUE (blocker_user_id, blocked_user_id),
    CONSTRAINT ck_user_block_not_self CHECK (blocker_user_id <> blocked_user_id),
    INDEX ix_user_blocked_by (blocked_user_id, blocker_user_id),
    CONSTRAINT fk_user_block_blocker FOREIGN KEY (blocker_user_id) REFERENCES app_user(id) ON DELETE CASCADE,
    CONSTRAINT fk_user_block_target FOREIGN KEY (blocked_user_id) REFERENCES app_user(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
