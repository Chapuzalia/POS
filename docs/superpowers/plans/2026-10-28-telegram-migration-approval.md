# Telegram approval for sensitive migrations

User request: replace automatic refusal of sensitive pending SQL with a Telegram message naming the migration and every detected reason, with Desplegar / Cancelar buttons. The user explicitly authorizes any current member of the designated group to decide.

- [x] Add a structured safety report from the installed checker; preserve integrity, ledger and contract dependency checks.
- [x] Add bounded Telegram polling in the existing receiver before backup/password/SQL. Bind approval to commit, environment, prepared-byte hash and a single expiring nonce. All sensitive files must be approved before SQL starts; cancellation aborts the release.
- [x] Wire private Coolify configuration, awaiting_approval/cancelled states, requester handling, tests and operations documentation. No webhook, extra service or production changes.

Bot token is provided only as a private runtime secret. Never include it in source, test fixtures, messages, logs or public errors. Transport tests use fake Telegram responses only. Interrupted approval is not resumed automatically; existing interrupted-state reconciliation remains in force.

Validation: pnpm test passed 173 Vitest + 233 legacy tests; Python passed 58 tests. pnpm lint exited 0 with two existing React hook warnings. pnpm build exited 0, including controller typecheck; Sentry upload was unavailable due network resolution in the sandbox. Resolved Compose confirms Telegram credentials reach only the worker. A fresh read-only security review reported no Important/Critical findings. No real Telegram messages or production changes were made. Actual bot/group permissions and image integration require authorized staging activation.
