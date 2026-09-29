ALTER TABLE direct_conversation
    MODIFY pair_key VARCHAR(73) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD conversation_kind VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'DIRECT',
    ADD group_name VARCHAR(80) NULL,
    ADD creation_key VARCHAR(110) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD creation_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL;

ALTER TABLE direct_conversation
    ADD CONSTRAINT uq_direct_conversation_creation UNIQUE (creation_key),
    ADD CONSTRAINT ck_direct_conversation_shape CHECK (
        (conversation_kind='DIRECT' AND pair_key IS NOT NULL AND group_name IS NULL AND creation_key IS NULL AND creation_hash IS NULL)
        OR
        (conversation_kind='GROUP' AND pair_key IS NULL AND group_name IS NOT NULL AND creation_key IS NOT NULL AND creation_hash IS NOT NULL)
    );
