ALTER TABLE town_space
    ADD COLUMN archived_at TIMESTAMP(6) NULL AFTER created_at,
    ADD INDEX ix_space_owner_archived (owner_id, archived_at);
