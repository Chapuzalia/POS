# Independent deploy controller implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Extract a standalone Coolify controller which safely serves multiple GitHub projects.
**Architecture:** Reuse the existing API/worker and trusted receiver. Add project identity to the existing policy, queue and private paths; keep one global serial worker. Prepare the independent repository in `deploy-controller/` before removing POS-only runtime ownership.
**Tech Stack:** Node 24.12+, TypeScript, SQLite, Python stdlib, Vitest, pnpm, Docker Compose.
**Spec:** `docs/superpowers/specs/2026-11-04-independent-deploy-controller-design.md` (approved 2026-11-04).

## Global constraints

- One controller instance for multiple projects; `production` and `staging` with configurable branches/workflows.
- Existing OIDC, access credentials, SQL integrity, Telegram and backup guarantees stay enforced.
- No production writes, messages, deployments or remote publication during preparation.
- New repository builds/tests without parent files; no new runtime dependencies.
- Reuse current self-hosted Supabase and Railpack contracts; no arbitrary downloaded executable hooks.

## Review focus

- Identical request IDs, run IDs and commits in different projects must never share authorization or state.
- Disabled/removed project or changed credentials must not start an existing queued operation.
- Missing functions must require an explicit policy, never delete an existing deployment.
- Historical preparation must preserve hashes for POS and never silently rewrite another project's SQL.
- Importing legacy state must preserve uncertainty and refuse conflicts/active operations.

### Task 1: Standalone source and project policy

Files: `deploy-controller/package.json`, lockfile, Vitest/TS configs; copied controller/scripts/tests; `apps/deploy-controller/src/{config,auth,http}.ts` inside the new root.
Interfaces: `DeploymentRequest` and `Identity` gain `project`; config becomes `{audience,projects:Record<string,ProjectConfig>}`. A project contains `repository`, `repositoryId`, `environments`; each environment contains `branch`, `workflow`, `events`, existing access/frontend/receiver settings. `GitHubVerifier` verifies the selected explicit repository policy.

- [x] Copy the trusted runtime and its existing regression suite into an independent root; create independent package scripts.
- [x] Add failing Vitest tests for a second repository and cross-project token/credential rejection.
- [x] Implement strict configuration and request/auth policy; keep gateway credential allowlist.
- [x] Run focused identity tests and typecheck.

### Task 2: State and execution isolation

Files: new-root `store.ts`, `pipeline.ts`, `worker.ts`, `start-deploy-worker.py`, receiver, retention and startup tests.
Interfaces: storage keys include `project`; `runRelease` receives trusted project policy; private resources use `/var/lib/deploy-controller/projects/<project>/<environment>` and `/etc/deploy-controller/receiver.<project>.<environment>.json`.

- [x] Add failing tests for same request ID across projects, scoped failures/PWA state and queued-disabled destinations.
- [x] Keep one global claim, add project filters to all authorization/idempotency/block/version operations.
- [x] Generate project-specific receiver/key files and mirrors; validate duplicated resources before startup.
- [x] Adapt trusted receiver and retention paths without weakening root ownership checks.
- [x] Run controller, pipeline and Python regressions.

### Task 3: Generic preparation, frontend and Telegram

Files: new-root packager, migration preparation, Coolify client, Telegram module and relevant tests; version-file example.
Interfaces: receiver config includes project/repository/name, explicit `deploy_edge`, and reviewed migration compatibility entries `{migration,sha256,indexCount}`. Coolify receives expected repository and branch from trusted policy.

- [x] Add failing tests for repositories without POS migrations, content-pinned compatibility, no-functions packaging and project-specific Telegram links.
- [x] Replace mandatory POS transformations with optional exact-content compatibility rules; preserve prepared hash behavior.
- [x] Explicitly support SQL-only protocol packages when Edge is disabled; reject unexpected omission otherwise.
- [x] Parameterize repository/branch validation, keep exact frontend SHA checks and supported-version contract.
- [x] Add minimum version-file writer example and run relevant suites.

### Task 4: Explicit legacy import

Files: new-root `scripts/import-legacy-state.py`, Python import tests, import guide.
Interfaces: offline command accepts source state directory, fresh destination directory and explicit project ID. Copies consistent SQLite/state into a fresh tree; adds project identity and retains operations/tokens/versions. Rejects active states, existing destination and unknown source structure; preserves original files/backups.

- [x] Add synthetic legacy fixtures and failing tests for blocked operations, PWA history, file copying and conflicting imports.
- [x] Implement offline read-only-source import with path checks, schema validation, SQLite backup and staging directory promotion.
- [x] Document receiver-log/host-backup copying and safe cutover without starting either worker.
- [x] Run import and receiver suites.

### Task 5: Client, container and POS extraction

Files: new-root Dockerfile/Compose/example config/README/CI/client tests; POS requester, workflows, package scripts and ownership docs.
Interfaces: client requires `DEPLOY_PROJECT`, controller origin/audience and explicit repository/branch/workflow configuration; POS declares its fixed local identity and sends project `tickit-pos`.

- [x] Add failing client tests for project mismatch in polling and a second repository.
- [x] Provide generic client and project workflow example, with minimal POS wrapper/configuration.
- [x] Adapt image and Compose to the independent root and neutral private paths.
- [x] Remove the exclusive controller runtime/tests from POS after new tests pass; retain helpers still used by POS CI or legacy tooling.
- [x] Run own tests/build/lint, POS relevant suite and Compose validation.

### Task 6: Verification and delivery

- [x] Install dependencies and run checks from a standalone copy outside the POS workspace resolution chain.
- [x] Request one independent whole-change review; fix material findings with regression tests.
- [x] Inspect all diffs for unrelated changes/secrets and record commands/results below.
- [x] Deliver the local independent project and production cutover steps; no remote publish or production activation.

## Execution record

- Baseline: existing controller Vitest 44/44 passed with localhost permissions. Sandbox-only run failed with EACCES; no code fault.
- Baseline Python default temp directory is denied by the sandbox; use a task-local temp directory for subsequent checks.
- Ruling: execute inline following the user's “adelante”; no additional plan permission gate. Prepare the new repository in the approved workspace, without publishing or changing production.
- Ruling: keep the current checkout on `Staging` and isolate the deliverable in `deploy-controller/`; avoid moving the user's checkout or creating an externally managed worktree while extracting a separate repository.

- Tasks 1-6: complete locally. Standalone repository: ../deploy-controller, branch codex/independent-controller, initial commit 5371ad5. No POS commit, remote publication or production operation.
- Independent frozen-lockfile install, pnpm lint/build and Compose config passed outside POS. pnpm test: 49 Vitest + 29 Node + 64 Python passed.
- POS: pnpm test passed 443 Vitest + 222 Node; pnpm lint exit 0 with two existing hook warnings; pnpm build exit 0. Sentry release/sourcemap upload failed due unavailable network/DNS.
- Independent review: one Important finding, inherited forced SPA routing. Fixed by preserving frontend routing. Regression test failed before the fix and passed afterward; full standalone suite passed. No other material findings.
- Import regression: ancestor backup source caused recursive copying; now rejected before staging. Imported state is also exercised through the real Node store.
- Limits: Docker Desktop daemon unavailable. Image build/start, live Coolify/Supabase/Telegram and staging cutover were not executed. CI includes image builds. Activation requires separate production permission.
