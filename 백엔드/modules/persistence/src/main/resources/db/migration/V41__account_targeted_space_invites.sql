ALTER TABLE space_invite
    ADD COLUMN target_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD CONSTRAINT fk_invite_target_user FOREIGN KEY (target_user_id) REFERENCES app_user(id) ON DELETE CASCADE,
    ADD INDEX ix_invite_target_user (space_id, target_user_id, created_at);
