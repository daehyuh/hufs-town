CREATE TABLE town_space (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    name VARCHAR(60) NOT NULL,
    description VARCHAR(300) NOT NULL DEFAULT '',
    visibility VARCHAR(16) CHARACTER SET ascii NOT NULL,
    capacity SMALLINT NOT NULL DEFAULT 100,
    owner_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_space_owner FOREIGN KEY (owner_id) REFERENCES app_user(id),
    CONSTRAINT ck_space_visibility CHECK (visibility IN ('PUBLIC','UNLISTED','PRIVATE')),
    CONSTRAINT ck_space_capacity CHECK (capacity BETWEEN 1 AND 100),
    INDEX ix_space_visibility (visibility, created_at),
    INDEX ix_space_owner (owner_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE space_member (
    space_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    role VARCHAR(16) CHARACTER SET ascii NOT NULL DEFAULT 'MEMBER',
    joined_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    last_visited_at TIMESTAMP(6) NULL,
    PRIMARY KEY (space_id, user_id),
    CONSTRAINT fk_member_space FOREIGN KEY (space_id) REFERENCES town_space(id),
    CONSTRAINT fk_member_user FOREIGN KEY (user_id) REFERENCES app_user(id),
    CONSTRAINT ck_member_role CHECK (role IN ('OWNER','MEMBER')),
    INDEX ix_member_user (user_id, last_visited_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE space_invite (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    space_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    code_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
    expires_at TIMESTAMP(6) NOT NULL,
    max_uses INT NOT NULL,
    use_count INT NOT NULL DEFAULT 0,
    revoked BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_invite_space FOREIGN KEY (space_id) REFERENCES town_space(id),
    CONSTRAINT ck_invite_uses CHECK (max_uses BETWEEN 1 AND 100 AND use_count BETWEEN 0 AND max_uses),
    INDEX ix_invite_space (space_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO town_space (id, name, description, visibility, capacity)
VALUES ('00000000-0000-4000-8000-000000000001', 'GDG HUFS 캠퍼스', '누구나 편하게 만나는 우리 학교의 작은 광장.', 'PUBLIC', 100);
