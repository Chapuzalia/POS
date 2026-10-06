-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
-- migration-safety-reviewed: REVOKE
-- migration-safety-reason: Remove anonymous execution of the new link-deletion guard while preserving authenticated trigger permissions and its unchanged signature.

-- This routine only runs as a trigger. Signed-in writes still pass the existing
-- link RLS and the guard's scoped parent-document checks.
revoke all on function public.guard_supplier_document_link_deletion() from public, anon;
grant execute on function public.guard_supplier_document_link_deletion() to authenticated;
