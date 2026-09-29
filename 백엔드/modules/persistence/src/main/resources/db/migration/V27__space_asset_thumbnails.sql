ALTER TABLE space_asset
    ADD COLUMN thumbnail_key VARCHAR(120) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER storage_key,
    ADD CONSTRAINT uq_space_asset_thumbnail UNIQUE (thumbnail_key);
