CREATE TABLE town_scheduled_event (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    space_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    title VARCHAR(80) NOT NULL,
    description VARCHAR(280) NOT NULL DEFAULT '',
    instructions VARCHAR(500) NOT NULL DEFAULT '',
    resource_url VARCHAR(512) NOT NULL DEFAULT '',
    starts_at TIMESTAMP(6) NOT NULL,
    ends_at TIMESTAMP(6) NULL,
    cancelled_at TIMESTAMP(6) NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_scheduled_event_space FOREIGN KEY (space_id) REFERENCES town_space(id) ON DELETE CASCADE,
    CONSTRAINT fk_scheduled_event_creator FOREIGN KEY (created_by) REFERENCES app_user(id),
    INDEX ix_scheduled_event_space_time (space_id, starts_at, cancelled_at),
    INDEX ix_scheduled_event_manager_rate (created_by, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
