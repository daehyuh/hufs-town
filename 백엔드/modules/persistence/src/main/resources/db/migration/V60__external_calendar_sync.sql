CREATE TABLE user_calendar_connection (
    user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    provider VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    remote_calendar_id VARCHAR(512) NOT NULL,
    refresh_token_ciphertext VARCHAR(2048) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    connected_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (user_id, provider),
    CONSTRAINT fk_calendar_connection_user FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE,
    CONSTRAINT ck_calendar_connection_provider CHECK (provider IN ('GOOGLE')),
    INDEX ix_calendar_connection_updated (provider, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE calendar_sync_item (
    user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    provider VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    source_kind VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    source_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    remote_event_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    remote_etag VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    source_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    synced_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    sync_state VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'SYNCED',
    PRIMARY KEY (user_id, provider, source_kind, source_id),
    CONSTRAINT fk_calendar_sync_item_connection FOREIGN KEY (user_id, provider)
        REFERENCES user_calendar_connection(user_id, provider) ON DELETE CASCADE,
    CONSTRAINT ck_calendar_sync_item_provider CHECK (provider IN ('GOOGLE')),
    CONSTRAINT ck_calendar_sync_item_source CHECK (source_kind IN ('SCHEDULED_EVENT','ROOM_RESERVATION')),
    CONSTRAINT ck_calendar_sync_item_state CHECK (sync_state IN ('SYNCED','CONFLICT','DELETE_PENDING')),
    UNIQUE INDEX uq_calendar_sync_remote_event (user_id, provider, remote_event_id),
    INDEX ix_calendar_sync_conflict (user_id, provider, sync_state, synced_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE calendar_sync_outbox (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    provider VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    source_kind VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    source_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    operation VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    attempts INT NOT NULL DEFAULT 0,
    available_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    lease_until TIMESTAMP(6) NULL,
    last_error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_calendar_outbox_connection FOREIGN KEY (user_id, provider)
        REFERENCES user_calendar_connection(user_id, provider) ON DELETE CASCADE,
    CONSTRAINT ck_calendar_outbox_provider CHECK (provider IN ('GOOGLE')),
    CONSTRAINT ck_calendar_outbox_source CHECK (source_kind IN ('SCHEDULED_EVENT','ROOM_RESERVATION')),
    CONSTRAINT ck_calendar_outbox_operation CHECK (operation IN ('UPSERT','DELETE')),
    CONSTRAINT ck_calendar_outbox_attempts CHECK (attempts >= 0),
    UNIQUE INDEX uq_calendar_outbox_source (user_id, provider, source_kind, source_id),
    INDEX ix_calendar_outbox_ready (available_at, lease_until, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
