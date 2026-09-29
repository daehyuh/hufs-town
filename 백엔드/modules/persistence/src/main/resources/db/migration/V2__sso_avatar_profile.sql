ALTER TABLE app_user
    ADD COLUMN avatar_preset TINYINT NOT NULL DEFAULT 0,
    ADD COLUMN sso_status VARCHAR(32) CHARACTER SET ascii NULL,
    ADD CONSTRAINT ck_avatar_preset CHECK (avatar_preset BETWEEN 0 AND 2);
