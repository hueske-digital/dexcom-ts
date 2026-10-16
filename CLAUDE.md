# CLAUDE.md

## Layout

- `src/v3/`: official Dexcom API v3 on top of the Kubb-generated client in `src/generated/` (not committed).
- `src/share/`: hand-written Dexcom Share client (unofficial service).
- `src/index.ts`: `createDexcom()`, the shared interface over both sources.
- `scripts/fetch-spec.ts`: downloads the Dexcom OpenAPI document, verifies the pinned SHA-256, writes the prose-free copy the generator reads.

## Rules

- Never commit Dexcom's OpenAPI document or text from it. Generate from `spec/dexcom-v3.structure.json` only; check `dist/` for Dexcom prose after generator changes.
- Do not copy code from other projects. Protocol facts (hosts, endpoints, IDs) are fine with attribution in `THIRD_PARTY_NOTICES.md`.
- Bundled third-party code (the Kubb runtime in `src/generated/.kubb/`) needs its license in `THIRD_PARTY_NOTICES.md`.
- Every operation in the spec needs a case in `test/v3.contract.test.ts`; the completeness test enforces it.
- Tests never call Dexcom. v3 tests stub the global fetch (`test/support.ts`), Share tests inject `fetch`.

## Learnings

- TypeScript 7 has no compiler API. Tools that need it (Kubb, typescript-eslint) get TypeScript 6 via the `typescript` → `@typescript/typescript6` alias; `tsc` comes from `@typescript/native` (TypeScript 7). Lint is oxlint with oxlint-tsgolint.
- Generated code is not compatible with `exactOptionalPropertyTypes`; keep it off.
- Dexcom's `systemTime` has no offset (UTC), `displayTime` has one. Zod must accept both (`z.iso.datetime({ offset: true, local: true })`, set via the Kubb zod printer).
- The spec's token response union is `.strict()`, but Dexcom documents an extra `refresh_expires_in`. The v3 client validates token responses with its own loose schema.
- Kubb's faker printer ignores `format: int32`; the config bounds integers so mocks pass `z.int32()`.
- Kubb validators return the parsed value: int64 fields arrive as `bigint`. JSON fixtures must convert bigint to number (`test/support.ts`).
- Refresh tokens are single-use: persist the new token before using it, and never run two refreshes concurrently.
- Errors must never keep a generated `ResponseError` as `cause`: its `request` carries the bearer token or, for the token endpoint, the client secret in the body. Carry status and OAuth error code only (`test/v3.client.test.ts` checks the whole cause chain).
- Token state (running refresh, unsaved rotated token) is shared per `TokenStorage` object. A 401 triggers a refresh only if the token sent is still the current one.
- The API works in whole seconds with exclusive `endDate`: query the enclosing seconds, then filter records to the caller's half-open range.
- Share sessions: renew only the session that expired and clear a failed login only if no newer one replaced it.
- Tags and PRs created with `GITHUB_TOKEN` do not trigger other workflows: publishing runs inside the release-please workflow, spec drift reports an issue instead of a PR.
- Workflows pin mise itself (`version` + `sha256` of the linux-x64 binary) besides the mise-action SHA. When updating mise, verify the archive against the release's SHASUMS256.txt and hash the extracted `mise/bin/mise`.
- Token operations on one `TokenStorage` run strictly one after another (`exclusive` in `src/v3/client.ts`); per-flag locks were not enough. Race tests use storages that return the state at read time and gates that hold specific reads.
- Every workflow declares `permissions` explicitly (repo default is read-only). release-please needs "Allow GitHub Actions to create and approve pull requests", which the org must allow before the repo setting sticks.
- pnpm (since 11.5.3) ignores `${...}` placeholders in the project `.npmrc`; registry tokens go into `~/.npmrc` with the placeholder, the token itself via `env:`.
- If publishing fails after release-please created the tag, rerun with `gh workflow run release.yml -f tag=vX.Y.Z` (a rerun of the old run would use the old workflow file).
- Real sandbox data broke spec/doc assumptions. Dexcom support (2026-10-16) sorted them into production behavior and sandbox defects:
  - Minute-precision timestamps ("2026-05-23T06:45Z", not RFC 3339) are valid ISO 8601 and occur in production. Schemas accept them.
  - dataRange's EGV end can lie hours after the last EGV, a known production edge case tied to `lastSyncTime`; Dexcom gave no timeline for a fix. getLatestReading searches backwards.
  - `recordId` reuse (16 ids across 1 439 alerts, EGV and calibration ids repeated months apart) is a sandbox generator defect that Dexcom plans to fix; production ids are unique. Keying by `recordId` + `systemTime` works in both; the README says so.
  - `/events` returning nothing while dataRange reports events is sandbox-only.
  - Dexcom will update swaggerV3.json; the spec-drift workflow should pick that up.
- Probe new data sources with the real API before trusting the spec, and ask Dexcom support whether a finding is production behavior or a sandbox defect.
