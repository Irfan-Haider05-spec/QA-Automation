-- 006_harden: the app role can add audit events but never change or remove them,
-- and can't touch the migration history. (Deleting an organization still removes
-- its audit events: foreign-key cascades run with the table owner's rights.)
revoke update, delete on audit_events from qa_app;
revoke insert, update, delete on schema_migrations from qa_app;
