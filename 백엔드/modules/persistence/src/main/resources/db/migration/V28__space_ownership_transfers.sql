CREATE TABLE space_ownership_transfer (
    space_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    from_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    to_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    requested_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    expires_at TIMESTAMP(6) NOT NULL,
    CONSTRAINT fk_ownership_transfer_space FOREIGN KEY (space_id) REFERENCES town_space(id) ON DELETE CASCADE,
    CONSTRAINT fk_ownership_transfer_from FOREIGN KEY (from_user_id) REFERENCES app_user(id) ON DELETE CASCADE,
    CONSTRAINT fk_ownership_transfer_to FOREIGN KEY (to_user_id) REFERENCES app_user(id) ON DELETE CASCADE,
    CONSTRAINT ck_ownership_transfer_distinct CHECK (from_user_id <> to_user_id),
    INDEX ix_ownership_transfer_recipient (to_user_id, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
