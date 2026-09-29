CREATE TABLE town_event (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    space_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    host_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    title VARCHAR(80) NOT NULL,
    description VARCHAR(280) NOT NULL DEFAULT '',
    resource_url VARCHAR(512) NOT NULL DEFAULT '',
    started_at TIMESTAMP(6) NOT NULL,
    ended_at TIMESTAMP(6) NULL,
    CONSTRAINT fk_event_space FOREIGN KEY (space_id) REFERENCES town_space(id),
    CONSTRAINT fk_event_host FOREIGN KEY (host_user_id) REFERENCES app_user(id),
    INDEX ix_event_space_started (space_id, started_at),
    INDEX ix_event_active (space_id, ended_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE town_event_question (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    asker_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    asker_name VARCHAR(20) NOT NULL,
    body VARCHAR(280) NOT NULL,
    answered BOOLEAN NOT NULL DEFAULT FALSE,
    answer VARCHAR(280) NOT NULL DEFAULT '',
    answerer_name VARCHAR(20) NOT NULL DEFAULT '',
    asked_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    answered_at TIMESTAMP(6) NULL,
    CONSTRAINT fk_event_question_event FOREIGN KEY (event_id) REFERENCES town_event(id) ON DELETE CASCADE,
    CONSTRAINT fk_event_question_asker FOREIGN KEY (asker_user_id) REFERENCES app_user(id),
    INDEX ix_event_question_order (event_id, asked_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE town_event_poll (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    question VARCHAR(160) NOT NULL,
    closed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    closed_at TIMESTAMP(6) NULL,
    CONSTRAINT fk_event_poll_event FOREIGN KEY (event_id) REFERENCES town_event(id) ON DELETE CASCADE,
    INDEX ix_event_poll_order (event_id, created_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE town_event_poll_option (
    poll_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    option_index TINYINT UNSIGNED NOT NULL,
    label VARCHAR(80) NOT NULL,
    vote_count INT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (poll_id, option_index),
    CONSTRAINT fk_event_poll_option_poll FOREIGN KEY (poll_id) REFERENCES town_event_poll(id) ON DELETE CASCADE,
    CONSTRAINT ck_event_poll_option_index CHECK (option_index BETWEEN 0 AND 5)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE town_event_poll_vote (
    poll_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    option_index TINYINT UNSIGNED NOT NULL,
    voted_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (poll_id, user_id),
    CONSTRAINT fk_event_poll_vote_poll FOREIGN KEY (poll_id) REFERENCES town_event_poll(id) ON DELETE CASCADE,
    CONSTRAINT fk_event_poll_vote_user FOREIGN KEY (user_id) REFERENCES app_user(id),
    CONSTRAINT ck_event_poll_vote_index CHECK (option_index BETWEEN 0 AND 5)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE town_event_attendance (
    event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    player_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    display_name VARCHAR(20) NOT NULL,
    joined_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    last_seen_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    left_at TIMESTAMP(6) NULL,
    attended_seconds INT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (event_id, player_id),
    CONSTRAINT fk_event_attendance_event FOREIGN KEY (event_id) REFERENCES town_event(id) ON DELETE CASCADE,
    CONSTRAINT fk_event_attendance_user FOREIGN KEY (user_id) REFERENCES app_user(id),
    INDEX ix_event_attendance_user (event_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
