# POS Project Instructions

## Project priorities

This is a production-oriented, multi-tenant POS/CRM/KDS. Favor correctness of sales, cash, fiscal, offline, printing, auth and tenant isolation over cosmetic refactors or architectural novelty.

## Stack and commands

- React 19 + TypeScript + Vite 8; Tailwind CSS 4 + HeroUI; Zustand where already used.
- Supabase Auth/Postgres/Realtime/Storage/Edge Functions; Zod validation; Sentry observability.
- Package manager: **pnpm 10.x**. Do not run `npm install` or modify `package-lock.json` unless explicitly requested.
- Dev: `pnpm dev`; lint: `pnpm lint`; tests: `pnpm test`; build/typecheck: `pnpm build`.

## Efficient workflow

- Before editing, locate the smallest relevant feature and inspect its existing controller/service/store/components plus nearby tests.
- Use targeted search (`rg`) and targeted reads. Do not scan/dump the whole repo for localized tasks.
- Reuse existing helpers, types, RPCs, mappers and UI patterns before creating abstractions.
- Keep diffs scoped. No unrelated cleanup, renames, formatting, dependency upgrades or large refactors.
- During iteration run the smallest relevant check first; do not repeatedly run the full suite or reread unchanged large files.

## Architecture

- Keep `src/App.tsx` as a small composition boundary.
- `src/app/AppShell.tsx` wires session, POS, CRM, KDS, cash, offline, restaurant, reservations and printing. Put new business logic in the owning feature/service, not directly in `AppShell`.
- Prefer feature-specific code under `src/features/<feature>/`; shared infrastructure under `src/lib/`; shared app services under `src/services/`.
- Shared domain contracts live in `src/types/domain.ts`; Supabase row shapes in `src/types/supabase.ts`.
- Preserve existing lazy-loading boundaries for POS/CRM/Superadmin/KDS.

## TypeScript and UI

- This is a TypeScript/TSX codebase. Do not introduce untyped JS for app code.
- Respect `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax` and `erasableSyntaxOnly`; use `import type` where appropriate.
- Match surrounding naming/style. Avoid `any`, `@ts-ignore`, broad casts and non-null assertions unless the boundary genuinely requires them.
- Reuse existing shared/HeroUI components before creating parallel ones.
- `src/index.css` owns design tokens, theme scopes and document defaults; keep component layout/spacing/states/responsiveness in component Tailwind classes.
- Preserve CRM light/dark tokens and touch-first iPad/PWA behavior; avoid hover-only or tiny-target interactions.

## Tenant, auth and permissions

- Tenant isolation is non-negotiable. Never weaken tenant/venue/device scoping or RLS to make code work.
- Preserve `tenantId`, `venueId`, `deviceId`, role and feature-gate checks through relevant data paths.
- Roles: `superadmin`, `owner`, `manager`, `cashier`; device modes: `satellite`, `checkout`, `hybrid`, `kds`. Do not assume equal permissions.
- Browser code may use only public/anon Supabase config. Service-role credentials belong only in trusted Edge/server code.
- Supabase auth storage is route-scoped for POS/CRM/Superadmin; preserve route/session migration and exclusive-login lease behavior unless explicitly changing that model.

## Database and concurrency

- Schema/RLS/RPC changes must be a **new migration** under `supabase/migrations/`; do not rewrite deployed migrations unless explicitly told they are undeployed.
- Review every tenant-owned table/query/RPC for RLS plus tenant/venue isolation.
- For cross-terminal invariants use DB constraints, atomic RPC/transactions, idempotency/request IDs and atomic updates rather than frontend-only checks.
- Add indexes for new FKs or frequent tenant/venue/status/time filters when needed.
- Keep RPCs backward-compatible when older deployed clients may still call them.
- Use the docs/safe-production-migrations.md as a guide
- Check contracts-pending.yml when create a new migration, if the contracts refers to migrations already merged to main, applu the contracts in the migration being created

## Sales, money and fiscal invariants

- Transactional money uses integer cents (`*Cents`). Do not use floating-point arithmetic for sale/payment/cash totals.
- Paid tickets, lines, discounts, taxes, customer fiscal data and catalog metadata are historical snapshots; do not silently recompute history from the current catalog.
- Preserve ticket/sale/payment relationships and cash-session/register/venue/device/user IDs.
- Sale creation, voiding, invoices and history changes must consider Verifactu/TicketBAI issuance/cancellation and persisted fiscal status.
- Be conservative around cash closings, discrepancies, payment changes and invoice numbering.

## Offline-first behavior

- Offline operation is intentional; never replace it with online-only assumptions.
- Persisted localStorage keys and offline payloads are compatibility contracts scoped by route/tenant/device/session.
- Offline events cover cash open/close, sale creation, payment changes and voids. Preserve ordering, retries, failures and idempotency.
- Do not change persisted queue/payload shapes without a compatibility/migration strategy for installed PWAs.
- Network failure is not equivalent to `navigator.onLine === false`; preserve backend-unavailable/retry behavior and graceful Realtime recovery.

## Printing, Cashlogy and local hardware

- Keep printing/Cashlogy work under `src/features/local-printing/`; reuse clients, stores, schemas, mappers and receipt helpers.
- Map domain data through existing print services instead of formatting transport payloads ad hoc in UI code.
- Preserve request IDs, copy numbering/idempotency and cash-drawer rules.
- Hardware/printing failure must not corrupt an already completed economic transaction.
- Never log pairing/Cashlogy secrets, auth headers or sensitive diagnostics.

## Edge Functions, OCR and secrets

- Edge Functions run in Deno; service-role usage must remain server-side.
- Some functions have `verify_jwt = false` because they implement webhook/agent/custom validation. Do not remove their signature/secret/ownership checks.
- Preserve `production-agent` pairing/secret hashing and revocation boundaries.
- Supplier-document processing has shared deterministic/OCR/provider/repair logic under `supabase/functions/_shared/supplier-documents/`; extend shared logic instead of growing the large entrypoint unnecessarily.
- Validate AI/OCR/external output before persistence; prefer deterministic parsing/math checks and leave uncertain data reviewable.
- Never commit secrets or expose service-role/API credentials to client code.

## PWA and observability

- Preserve service-worker/version compatibility: older deployed PWAs may coexist temporarily with newer backend/database versions.
- Do not force updates while business-critical operations are active.
- Keep Sentry privacy sanitization: no auth headers, cookies, API keys, request bodies, PII, fiscal documents, OCR content or sensitive URLs in telemetry.
- Use existing user-facing/observability error utilities instead of exposing raw infrastructure errors.
- Do not bypass the build guard that rejects redacted `[SENSITIVE]` Vite values.

## Verification

1. Inspect the diff for unrelated changes.
2. Run the most focused applicable test/check first.
3. Run `pnpm lint` for TS/React changes when practical.
4. Run `pnpm test` for logic, SQL/migrations, sync, offline, fiscal or shared behavior changes.
5. Run `pnpm build` for type/import/build/PWA changes or broad frontend changes.
6. Add/update regression coverage for tenant isolation, concurrency and money/fiscal invariants when the existing harness can cover it.

Never claim a test/build passed unless it actually ran. If credentials/services prevent verification, say so explicitly.

## Completion

- Make low-risk assumptions from the repo instead of asking unnecessary questions.
- Ask before destructive data changes, breaking schema/API changes, changing fiscal semantics, replacing core dependencies or removing compatibility.
- Finish with a concise summary of changes, important files touched and verification commands actually run.
