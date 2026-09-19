-- A recovered authorized session can wait for its API credentials, disabled.
alter table core.telegram_accounts drop constraint telegram_credentials_complete;
alter table core.telegram_accounts add constraint telegram_credentials_complete check (
 (api_id is null) = (api_hash is null)
 and (session is null) = (session_fingerprint is null)
 and (not enabled or (api_id is not null and api_hash is not null and session is not null))
);
