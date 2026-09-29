CREATE TABLE social_join_request (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    requester_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    target_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    message VARCHAR(160) NOT NULL DEFAULT '',
    status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    expires_at TIMESTAMP(6) NOT NULL,
    resolved_at TIMESTAMP(6) NULL,
    CONSTRAINT ck_social_join_not_self CHECK (requester_user_id <> target_user_id),
    CONSTRAINT ck_social_join_status CHECK (status IN ('PENDING','APPROVED','DECLINED','CANCELLED','EXPIRED')),
    CONSTRAINT fk_social_join_requester FOREIGN KEY (requester_user_id) REFERENCES app_user(id) ON DELETE CASCADE,
    CONSTRAINT fk_social_join_target FOREIGN KEY (target_user_id) REFERENCES app_user(id) ON DELETE CASCADE,
    INDEX ix_social_join_incoming (target_user_id,status,created_at,id),
    INDEX ix_social_join_outgoing (requester_user_id,status,created_at,id),
    INDEX ix_social_join_expiry (status,expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
