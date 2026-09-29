ALTER TABLE user_calendar_connection
    ADD COLUMN connection_state VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'CONNECTED',
    ADD CONSTRAINT ck_calendar_connection_state CHECK (connection_state IN ('CONNECTED','RECONNECT_REQUIRED'));

ALTER TABLE calendar_sync_outbox
    ADD COLUMN lease_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD COLUMN force_apply BOOLEAN NOT NULL DEFAULT FALSE,
    ADD INDEX ix_calendar_sync_outbox_lease (lease_until,lease_id);
