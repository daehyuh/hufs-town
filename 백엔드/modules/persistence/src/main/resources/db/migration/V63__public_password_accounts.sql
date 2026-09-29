CREATE TABLE public_password_account (
    user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    email VARCHAR(320) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
    password_hash VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT uq_public_password_email UNIQUE (email),
    CONSTRAINT fk_public_password_user FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
