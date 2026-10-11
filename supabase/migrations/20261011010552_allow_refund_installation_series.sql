-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

-- Compatible widening: legacy VENUE-REGISTER-YEAR-R remains valid, while
-- series v2 also includes the positive installation sequence before YEAR.
-- Replace atomically so no concurrent write can bypass series validation.
-- NOT VALID avoids a historical table scan while holding the metadata lock;
-- it still enforces this CHECK on every new or updated refund.
alter table public.refund_requests
  drop constraint refund_requests_fiscal_series_check,
  add constraint refund_requests_fiscal_series_check
    check (fiscal_series ~ '^[A-Z0-9]{1,8}-[A-Z0-9]{1,8}-([1-9][0-9]*-)?[0-9]{4}-R$') not valid;
