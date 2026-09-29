ALTER TABLE town_space
    ADD COLUMN guest_entry_enabled BOOLEAN NOT NULL DEFAULT FALSE AFTER approval_required;
