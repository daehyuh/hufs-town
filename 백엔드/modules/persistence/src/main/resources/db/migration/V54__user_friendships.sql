CREATE TABLE user_friendship (
    friendship_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    user_a_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_b_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    requested_by_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    status ENUM('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    resolved_at TIMESTAMP(6) NULL,
    CONSTRAINT uq_user_friendship_pair UNIQUE (user_a_id, user_b_id),
    CONSTRAINT ck_user_friendship_order CHECK (user_a_id < user_b_id),
    CONSTRAINT ck_user_friendship_requester CHECK (requested_by_user_id = user_a_id OR requested_by_user_id = user_b_id),
    CONSTRAINT fk_user_friendship_a FOREIGN KEY (user_a_id) REFERENCES app_user(id) ON DELETE CASCADE,
    CONSTRAINT fk_user_friendship_b FOREIGN KEY (user_b_id) REFERENCES app_user(id) ON DELETE CASCADE,
    CONSTRAINT fk_user_friendship_requester FOREIGN KEY (requested_by_user_id) REFERENCES app_user(id) ON DELETE CASCADE,
    INDEX ix_user_friendship_a_status (user_a_id, status, created_at),
    INDEX ix_user_friendship_b_status (user_b_id, status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE user_social_preference (
    user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    allow_friend_requests BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_user_social_preference_user FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
