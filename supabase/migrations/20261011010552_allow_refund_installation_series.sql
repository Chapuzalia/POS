-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
-- migration-safety-reviewed: COMPATIBLE CHECK REPLACEMENT
-- migration-safety-reason: Preserve the complete deployed legacy refund-series predicate; also accept the positive installation sequence already issued by SIF v2, without altering fiscal records or numbering.

-- Compatible widening: legacy VENUE-REGISTER-YEAR-R remains valid, while
-- series v2 also includes the positive installation sequence before YEAR.
-- Replace atomically so no concurrent write can bypass series validation.
-- NOT VALID avoids a historical table scan while holding the metadata lock;
-- it still enforces this CHECK on every new or updated refund.
alter table public.refund_requests
  drop constraint refund_requests_fiscal_series_check,
  add constraint refund_requests_fiscal_series_check
    check (
      fiscal_series ~ '^[A-Z0-9]{1,8}-[A-Z0-9]{1,8}-[0-9]{4}-R$'
      or fiscal_series ~ '^[A-Z0-9]{1,8}-[A-Z0-9]{1,8}-[1-9][0-9]*-[0-9]{4}-R$'
    ) not valid;
