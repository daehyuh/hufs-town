ALTER TABLE town_space
    ADD COLUMN approval_required BOOLEAN NOT NULL DEFAULT FALSE AFTER capacity;

CREATE TABLE space_join_request (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    space_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    status VARCHAR(16) CHARACTER SET ascii NOT NULL DEFAULT 'PENDING',
    requested_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    resolved_at TIMESTAMP(6) NULL,
    resolved_by_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    CONSTRAINT fk_space_join_request_space FOREIGN KEY (space_id) REFERENCES town_space(id) ON DELETE CASCADE,
    CONSTRAINT fk_space_join_request_user FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE,
    CONSTRAINT fk_space_join_request_resolver FOREIGN KEY (resolved_by_user_id) REFERENCES app_user(id) ON DELETE SET NULL,
    CONSTRAINT ck_space_join_request_status CHECK (status IN ('PENDING','APPROVED','REJECTED')),
    UNIQUE KEY uq_space_join_request_user (space_id,user_id),
    INDEX ix_space_join_request_pending (space_id,status,requested_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
