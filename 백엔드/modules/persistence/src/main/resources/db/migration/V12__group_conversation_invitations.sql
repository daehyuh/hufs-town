CREATE TABLE direct_conversation_invite (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    conversation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    inviter_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    invitee_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    request_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    content_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    status VARCHAR(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    expires_at TIMESTAMP(6) NOT NULL,
    responded_at TIMESTAMP(6) NULL,
    CONSTRAINT uq_direct_invite_request UNIQUE (inviter_user_id, request_id),
    CONSTRAINT fk_direct_invite_conversation FOREIGN KEY (conversation_id) REFERENCES direct_conversation(id) ON DELETE CASCADE,
    CONSTRAINT fk_direct_invite_inviter FOREIGN KEY (inviter_user_id) REFERENCES app_user(id) ON DELETE CASCADE,
    CONSTRAINT fk_direct_invite_invitee FOREIGN KEY (invitee_user_id) REFERENCES app_user(id) ON DELETE CASCADE,
    CONSTRAINT ck_direct_invite_status CHECK (status IN ('PENDING','ACCEPTED','DECLINED','EXPIRED','CANCELLED')),
    INDEX ix_direct_invite_inbox (invitee_user_id, status, expires_at, created_at),
    INDEX ix_direct_invite_group_member (conversation_id, invitee_user_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
