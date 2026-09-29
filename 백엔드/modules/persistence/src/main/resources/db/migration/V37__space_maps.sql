-- Turn the existing space-wide map into the first map of each space. Keep all
-- historical revision IDs and documents stable so existing editor links remain valid.
ALTER TABLE space_map
    ADD COLUMN map_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD COLUMN sort_order INT NOT NULL DEFAULT 0,
    ADD COLUMN is_entry BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE space_map
SET map_id = space_id;

ALTER TABLE space_map
    MODIFY COLUMN map_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    DROP PRIMARY KEY,
    ADD PRIMARY KEY (map_id),
    ADD INDEX ix_space_map_order (space_id, sort_order, map_id);

ALTER TABLE map_revision
    ADD COLUMN map_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL;

UPDATE map_revision
SET map_id = space_id;

-- MariaDB rebuilds the referenced table for ALTER TABLE, so temporarily drop the
-- existing outbox foreign key before changing map_revision's indexes.
ALTER TABLE map_outbox
    DROP FOREIGN KEY fk_outbox_revision;

ALTER TABLE map_revision
    MODIFY COLUMN map_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    DROP INDEX uq_revision_sequence,
    ADD CONSTRAINT fk_revision_map FOREIGN KEY (map_id) REFERENCES space_map(map_id),
    ADD CONSTRAINT uq_revision_map_sequence UNIQUE (map_id, sequence_no),
    ADD INDEX ix_revision_space_map (space_id, map_id);

ALTER TABLE map_draft_operation
    ADD COLUMN map_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL;

UPDATE map_draft_operation
SET map_id = space_id;

ALTER TABLE map_draft_operation
    MODIFY COLUMN map_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    DROP PRIMARY KEY,
    ADD PRIMARY KEY (map_id, operation_id),
    ADD INDEX ix_operation_space_map (space_id, map_id),
    ADD CONSTRAINT fk_operation_map FOREIGN KEY (map_id) REFERENCES space_map(map_id);

ALTER TABLE map_outbox
    ADD COLUMN map_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL;

UPDATE map_outbox
SET map_id = space_id;

ALTER TABLE map_outbox
    MODIFY COLUMN map_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    ADD CONSTRAINT fk_outbox_revision FOREIGN KEY (revision_id) REFERENCES map_revision(id),
    ADD CONSTRAINT fk_outbox_map FOREIGN KEY (map_id) REFERENCES space_map(map_id),
    ADD INDEX ix_map_outbox_map_sequence (map_id, sequence_no);
