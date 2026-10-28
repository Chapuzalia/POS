-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

CREATE SCHEMA IF NOT EXISTS deploy_smoke_test;

CREATE TABLE IF NOT EXISTS deploy_smoke_test.pipeline_probe (
  id bigint PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
