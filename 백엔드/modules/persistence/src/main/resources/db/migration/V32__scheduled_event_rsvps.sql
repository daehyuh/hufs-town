CREATE TABLE town_scheduled_event_rsvp (
    event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    response VARCHAR(16) NOT NULL,
    responded_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (event_id,user_id),
    CONSTRAINT fk_scheduled_event_rsvp_event FOREIGN KEY (event_id)
        REFERENCES town_scheduled_event(id) ON DELETE CASCADE,
    CONSTRAINT fk_scheduled_event_rsvp_user FOREIGN KEY (user_id)
        REFERENCES app_user(id) ON DELETE CASCADE,
    CONSTRAINT ck_scheduled_event_rsvp_response CHECK (response IN ('GOING','INTERESTED','DECLINED')),
    INDEX ix_scheduled_event_rsvp_user (user_id,event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
