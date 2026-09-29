ALTER TABLE direct_conversation
    ADD owner_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL;

UPDATE direct_conversation
SET owner_user_id=SUBSTRING_INDEX(creation_key, ':', 1)
WHERE conversation_kind='GROUP';

ALTER TABLE direct_conversation
    ADD CONSTRAINT fk_direct_conversation_owner FOREIGN KEY (owner_user_id)
        REFERENCES app_user(id) ON DELETE CASCADE,
    ADD CONSTRAINT ck_direct_conversation_owner CHECK (
        (conversation_kind='DIRECT' AND owner_user_id IS NULL)
        OR
        (conversation_kind='GROUP' AND owner_user_id IS NOT NULL)
    );

ALTER TABLE direct_conversation_member
    ADD membership_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL;

UPDATE direct_conversation_member SET membership_id=UUID();

ALTER TABLE direct_conversation_member
    MODIFY membership_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    ADD CONSTRAINT uq_direct_member_public_id UNIQUE (membership_id);
