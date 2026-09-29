ALTER TABLE space_member
    ADD COLUMN manager BOOLEAN NOT NULL DEFAULT FALSE AFTER role,
    ADD CONSTRAINT ck_member_manager_role CHECK (manager=FALSE OR role='MEMBER');
