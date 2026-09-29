ALTER TABLE chat_message DROP CONSTRAINT ck_chat_channel;
ALTER TABLE chat_message
    ADD CONSTRAINT ck_chat_channel CHECK (channel IN ('nearby','room','space'));
