CREATE TABLE space_extension_app (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    space_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    name VARCHAR(60) NOT NULL,
    launch_url VARCHAR(2048) NOT NULL,
    origin VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    requested_permissions JSON NOT NULL,
    approved_permissions JSON NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    created_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_space_extension_app_space FOREIGN KEY (space_id) REFERENCES town_space(id) ON DELETE CASCADE,
    CONSTRAINT fk_space_extension_app_creator FOREIGN KEY (created_by) REFERENCES app_user(id) ON DELETE CASCADE,
    INDEX ix_space_extension_enabled (space_id, enabled, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
