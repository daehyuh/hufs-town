CREATE INDEX ix_user_friendship_requester_status_created
    ON user_friendship (requested_by_user_id, status, created_at);
