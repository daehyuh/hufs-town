CREATE TABLE chat_retention_policy (
    policy_id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
    retention_days SMALLINT UNSIGNED NOT NULL,
    updated_by_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT ck_chat_retention_policy_singleton CHECK (policy_id=1),
    CONSTRAINT ck_chat_retention_policy_days CHECK (retention_days BETWEEN 1 AND 365),
    CONSTRAINT fk_chat_retention_policy_admin FOREIGN KEY (updated_by_user_id)
        REFERENCES app_user(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
