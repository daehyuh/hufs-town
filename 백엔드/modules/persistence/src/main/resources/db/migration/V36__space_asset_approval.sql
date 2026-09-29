ALTER TABLE space_asset
    DROP CONSTRAINT ck_space_asset_status,
    ADD COLUMN reviewed_by_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER status,
    ADD COLUMN reviewed_at TIMESTAMP(6) NULL AFTER reviewed_by_user_id,
    ADD CONSTRAINT fk_space_asset_reviewer FOREIGN KEY (reviewed_by_user_id) REFERENCES app_user(id) ON DELETE SET NULL,
    ADD CONSTRAINT ck_space_asset_status CHECK (status IN ('PENDING','READY','REJECTED'));
