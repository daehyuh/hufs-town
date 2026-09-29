ALTER TABLE app_user
    ADD COLUMN avatar_skin VARCHAR(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'light',
    ADD COLUMN avatar_clothing VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'casual_white',
    ADD COLUMN avatar_hair VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'hair_short_black',
    ADD CONSTRAINT ck_avatar_skin CHECK (avatar_skin IN ('black','blue','dark','green','light','medium','purple','red','white','yellow'));

UPDATE app_user SET avatar_clothing=CASE avatar_preset
    WHEN 1 THEN 'casual_pink'
    WHEN 2 THEN 'casual_green'
    ELSE 'casual_white'
END;

ALTER TABLE chat_message
    ADD COLUMN sender_skin VARCHAR(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'light',
    ADD COLUMN sender_clothing VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'casual_white',
    ADD COLUMN sender_hair VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'hair_short_black';

UPDATE chat_message SET sender_clothing=CASE sender_avatar
    WHEN 1 THEN 'casual_pink'
    WHEN 2 THEN 'casual_green'
    ELSE 'casual_white'
END;
