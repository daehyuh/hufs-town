CREATE TABLE app_user (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    display_name VARCHAR(80) NOT NULL,
    status VARCHAR(20) CHARACTER SET ascii NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    deleted_at TIMESTAMP(6) NULL,
    version BIGINT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE oauth_identity (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    provider VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    subject VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    verified_email VARCHAR(320) NULL,
    CONSTRAINT uq_oauth_subject UNIQUE (provider, subject),
    CONSTRAINT fk_oauth_user FOREIGN KEY (user_id) REFERENCES app_user(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
