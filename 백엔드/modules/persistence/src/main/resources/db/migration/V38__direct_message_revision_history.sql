CREATE TABLE direct_message_revision (
    message_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    revision INT UNSIGNED NOT NULL,
    body VARCHAR(500) NOT NULL,
    version_at TIMESTAMP(3) NOT NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (message_id, revision),
    CONSTRAINT fk_direct_message_revision_message FOREIGN KEY (message_id)
        REFERENCES direct_message(message_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
