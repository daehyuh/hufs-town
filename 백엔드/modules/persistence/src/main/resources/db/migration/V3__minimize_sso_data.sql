-- The supplied sso.md forbids long-term storage of mutable SSO profile fields.
-- Service nicknames and avatar choices are separate, user-managed data.
ALTER TABLE app_user DROP COLUMN sso_status;
