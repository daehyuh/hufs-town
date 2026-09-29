ALTER TABLE social_join_request
    ADD COLUMN destination_space_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD COLUMN destination_space_name VARCHAR(60) NULL,
    ADD CONSTRAINT fk_social_join_destination_space
        FOREIGN KEY (destination_space_id) REFERENCES town_space(id) ON DELETE SET NULL,
    ADD INDEX ix_social_join_destination (destination_space_id, status, created_at);
