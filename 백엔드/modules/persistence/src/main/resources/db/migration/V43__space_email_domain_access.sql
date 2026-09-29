CREATE TABLE space_allowed_email_domain (
    space_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    email_domain VARCHAR(253) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (space_id, email_domain),
    CONSTRAINT fk_space_allowed_domain_space FOREIGN KEY (space_id) REFERENCES town_space(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
