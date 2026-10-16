# dexcom-ts

TypeScript client for Dexcom CGM data. One interface over two sources:

| | `v3`: official Dexcom API v3 | `share`: Dexcom Share |
|---|---|---|
| Status | Documented by Dexcom | Unofficial, undocumented, can change without notice |
| Sign-in | OAuth 2.0 with an app registered at [developer.dexcom.com](https://developer.dexcom.com) | Username or account ID and password of the account that shares its data |
| Data | Glucose values, events, calibrations, alerts, devices | Glucose values and trend |
| Delay | 1 h in the US, 3 h elsewhere | Near real time |
| History | Whole account history | Last 24 hours |

> **Not a medical device.** This library is not affiliated with or endorsed by Dexcom. Do not use it for treatment decisions.

## Install

The package is published to GitHub Packages. Point the `@hueske-digital` scope at it in `.npmrc`:

```ini
@hueske-digital:registry=https://npm.pkg.github.com
```

```sh
pnpm add @hueske-digital/dexcom-ts
```

Node.js 22 or later.

## Usage

### Official API v3

Register an app at developer.dexcom.com with a redirect URI. New apps get sandbox data; real data needs an approved access upgrade. The client secret and the tokens belong on a server.

```ts
import { createDexcom, createOAuthState, fileTokenStorage, parseOAuthCallback } from "@hueske-digital/dexcom-ts";

const dexcom = createDexcom({
  source: "v3",
  clientId: process.env.DEXCOM_CLIENT_ID,
  clientSecret: process.env.DEXCOM_CLIENT_SECRET,
  redirectUri: "http://localhost:8080/callback",
  region: "ous", // "us" | "ous" | "jp" | "sandbox"
  tokens: fileTokenStorage(".dexcom-token.json"),
});

// 1. Send the user to the Dexcom login.
const state = createOAuthState();
const loginUrl = dexcom.authorizeUrl(state);

// 2. In the redirect handler: check the state, exchange the code. Tokens are stored and refreshed automatically.
const callback = parseOAuthCallback(new URL(request.url, "http://localhost:8080"), state);
if ("error" in callback) throw new Error(callback.error);
await dexcom.exchangeCode(callback.code);

// 3. Read data. Ranges longer than the API's 30-day limit are split automatically.
const readings = await dexcom.getReadings({ from: new Date("2026-01-01"), to: new Date() });
const events = await dexcom.events({ from: new Date("2026-10-01"), to: new Date() });
const range = await dexcom.dataRange();
```

The record methods return the API's records as typed objects. The package carries no field descriptions (see [How it is built](#how-it-is-built)); Dexcom documents the fields in its [endpoint reference](https://developer.dexcom.com/docs/dexcomv3/endpoint-overview/).

`fileTokenStorage` writes a file with mode 0600; keep it outside any git checkout. For a database or secrets store, implement `TokenStorage` (`load` and `save`); these must not call the Dexcom client themselves.

Refresh tokens are single-use. Clients that share one `TokenStorage` object refresh one at a time, and the new token is saved before it is used; if saving fails, the client keeps the new token in memory and retries the save first. Coordinating several processes is up to the storage: let one process at a time use a token file, or implement `TokenStorage` with a lock.

### Dexcom Share

Sign in with the account that shares its data, not with a follower account. Share must be enabled with at least one follower.

```ts
import { createDexcom } from "@hueske-digital/dexcom-ts";

const dexcom = createDexcom({
  source: "share",
  username: process.env.DEXCOM_USERNAME, // or accountId
  password: process.env.DEXCOM_PASSWORD,
  region: "ous", // "us" | "ous" | "jp"
});

const latest = await dexcom.getLatestReading();
const lastHour = await dexcom.getReadings({ from: new Date(Date.now() - 3_600_000), to: new Date() });
```

### One interface

Both clients implement `Dexcom`:

```ts
interface Dexcom {
  readonly source: "v3" | "share";
  readonly capabilities: { realtime: boolean; delayMs: number; historyMs: number | null };
  getReadings(range: { from: Date; to: Date }): Promise<GlucoseReading[]>; // oldest first
  getLatestReading(): Promise<GlucoseReading | null>;
}

interface GlucoseReading {
  time: Date; // UTC instant of the measurement
  mgdl: number | null;
  status: "low" | "high" | null;
  trend: Trend;
  trendRate: number | null; // mg/dL/min, v3 only
}
```

To use one source only, import from `@hueske-digital/dexcom-ts/v3` or `@hueske-digital/dexcom-ts/share`.

### Errors

| Error | Meaning |
|---|---|
| `DexcomAuthError` | Not signed in, or credentials/tokens rejected: sign in again |
| `DexcomHttpError` | Unexpected HTTP status (`status` property) |
| `DexcomResponseError` | The response does not match the documented shape |
| `DexcomRangeError` | Invalid range, or older than the source keeps (Share: 24 h) |

All extend `DexcomError`. Error messages never contain passwords or tokens.

## How it is built

- The v3 client is generated with [Kubb](https://kubb.dev) from Dexcom's OpenAPI document: types, Zod schemas that validate every response, and fetch functions.
- The document belongs to Dexcom and is not committed. `pnpm spec` downloads it and checks the SHA-256 pinned in `spec/dexcom-v3.openapi.sha256`; the generator reads a copy without descriptions and examples, so the package carries the API's structure only.
- Contract tests derive every request and response from the same document with generated faker factories. When Dexcom adds an endpoint, the completeness test fails until it is covered.
- The Share client is written by hand; its protocol follows [pydexcom](https://github.com/gagebenne/pydexcom).

## Development

Tool versions are pinned in `mise.toml`.

```sh
mise install
pnpm install        # also runs `pnpm spec` and `pnpm generate`
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

When Dexcom changes the document, `pnpm spec` fails with a hash mismatch, and the weekly *Spec drift* workflow opens an issue with the result of testing against the new version. Run `pnpm spec --update`, regenerate, review the diff of the generated code and the test results, then commit the new hash.

Releases use [release-please](https://github.com/googleapis/release-please): it keeps a release PR with version and changelog from the [Conventional Commits](https://www.conventionalcommits.org) on `main`. Merging that PR tags the release and publishes the package to GitHub Packages.

## License

[MIT](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the bundled Kubb runtime.
