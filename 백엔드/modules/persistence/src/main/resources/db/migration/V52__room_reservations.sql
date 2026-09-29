CREATE TABLE town_room_reservation (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    space_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    map_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    zone_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    organizer_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    organizer_name VARCHAR(80) NOT NULL,
    request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    title VARCHAR(80) NOT NULL,
    starts_at TIMESTAMP(6) NOT NULL,
    ends_at TIMESTAMP(6) NOT NULL,
    cancelled_at TIMESTAMP(6) NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_room_reservation_space FOREIGN KEY (space_id)
        REFERENCES town_space(id) ON DELETE CASCADE,
    CONSTRAINT fk_room_reservation_map FOREIGN KEY (map_id)
        REFERENCES space_map(map_id) ON DELETE CASCADE,
    CONSTRAINT fk_room_reservation_organizer FOREIGN KEY (organizer_user_id)
        REFERENCES app_user(id) ON DELETE SET NULL,
    CONSTRAINT uq_room_reservation_request UNIQUE (space_id, organizer_user_id, request_id),
    CONSTRAINT ck_room_reservation_interval CHECK (ends_at > starts_at),
    INDEX ix_room_reservation_overlap (space_id, map_id, zone_id, cancelled_at, starts_at, ends_at),
    INDEX ix_room_reservation_organizer (organizer_user_id, cancelled_at, starts_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
