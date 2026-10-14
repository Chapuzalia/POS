-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
-- migration-safety-reviewed: COMPATIBLE CHECK REPLACEMENT
-- migration-safety-reason: Preserve the complete deployed HTTPS predicate and nullable bridge URL; add HTTP loopback origins only, in one atomic ALTER TABLE with NOT VALID.

-- Compatible widening of the URL check: all previously accepted HTTPS values
-- and NULL remain valid. No rows, RLS policies or fiscal identities are changed.
-- Replace in one ALTER TABLE so writers never see an unconstrained column.
-- The checker verifies this exact compatible replacement; other DROP operations
-- remain forbidden in expand migrations. No promotion exception is needed.
alter table public.fiscal_pos_bridge_settings
  drop constraint fiscal_pos_bridge_settings_bridge_url_check,
  add constraint fiscal_pos_bridge_settings_bridge_url_check check (
    (bridge_url ~ '^https://[^/?#@]+/?$' and length(bridge_url) <= 255)
    or (
      length(bridge_url) <= 255
      and case when bridge_url ~ '^http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]{1,5})?/?$'
        then coalesce(substring(bridge_url from ':([0-9]{1,5})/?$')::integer, 80) <= 65535
        else false
      end
    )
  ) not valid;
