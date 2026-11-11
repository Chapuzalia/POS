-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
-- migration-safety-reviewed: COMPATIBLE CHECK REPLACEMENT
-- migration-safety-reason: Keep the deployed owner/manager/cashier predicate verbatim and only add the read-only gestor role, in one atomic ALTER TABLE with NOT VALID.

-- Compatible widening: every existing membership stays valid; no rows, RLS or
-- grants change here. Access for gestor is granted in the next migration.
alter table public.tenant_memberships
  drop constraint tenant_memberships_role_check,
  add constraint tenant_memberships_role_check
    check (
      role = any (array['owner'::text, 'manager'::text, 'cashier'::text])
      or role = 'gestor'::text
    ) not valid;
