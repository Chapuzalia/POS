# Private Deploy Controller: Coolify deployment

User correction: deploy the controller itself in Coolify, avoiding host installation and systemd management.

- [x] One root Compose file builds API and worker with the existing trusted receiver.
- [x] Private Coolify runtime variables generate container configuration and initialize the Git mirror.
- [x] Preserve non-root HTTP, separate deployment privileges, persistent queue, authenticated requests, PostgreSQL-led pending migrations and same-SHA redeploys.
- [x] Remove host installer, systemd/tmpfiles units and alternate Compose configuration.
- [x] Replace the installation guide with the Coolify workflow.
- [x] Regression checks: 99 Vitest, 231 legacy and 44 Python tests passed; lint exited 0 with two existing warnings, controller typecheck and resolved Compose validation passed. Docker image integration remains pending because the local daemon is unavailable.

No VPS, Coolify, Cloudflare or production mutations are performed in this task.
