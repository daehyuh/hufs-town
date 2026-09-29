ALTER TABLE space_invite
    ADD COLUMN created_by_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER target_user_id,
    ADD CONSTRAINT fk_invite_creator_user FOREIGN KEY (created_by_user_id) REFERENCES app_user(id) ON DELETE SET NULL,
    ADD INDEX ix_invite_creator (created_by_user_id, created_at);
