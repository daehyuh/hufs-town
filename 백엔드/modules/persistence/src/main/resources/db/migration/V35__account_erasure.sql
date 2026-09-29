ALTER TABLE map_revision
    DROP FOREIGN KEY fk_revision_actor,
    MODIFY COLUMN actor_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD CONSTRAINT fk_revision_actor_erasure FOREIGN KEY (actor_id) REFERENCES app_user(id) ON DELETE SET NULL;

ALTER TABLE space_asset
    DROP FOREIGN KEY fk_space_asset_uploader,
    MODIFY COLUMN uploader_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD CONSTRAINT fk_space_asset_uploader_erasure FOREIGN KEY (uploader_user_id) REFERENCES app_user(id) ON DELETE SET NULL;

ALTER TABLE town_scheduled_event
    DROP FOREIGN KEY fk_scheduled_event_creator,
    MODIFY COLUMN created_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD CONSTRAINT fk_scheduled_event_creator_erasure FOREIGN KEY (created_by) REFERENCES app_user(id) ON DELETE SET NULL;
