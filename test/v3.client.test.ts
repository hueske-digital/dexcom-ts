import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  createDexcomV3,
  createOAuthState,
  DexcomAuthError,
  DexcomHttpError,
  DexcomRangeError,
  DexcomResponseError,
  type DexcomV3Options,
  fileTokenStorage,
  MAX_WINDOW_MS,
  memoryTokenStorage,
  parseOAuthCallback,
  type StoredToken,
} from "../src/v3/index.ts";
import { jsonResponse, stubFetch } from "./support.ts";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const VALID: StoredToken = { accessToken: "a1", refreshToken: "r1", expiresAt: NOW + 2 * 60 * 60 * 1000 };
const EXPIRED: StoredToken = { ...VALID, expiresAt: NOW - 1 };

function options(overrides: Partial<DexcomV3Options> = {}): DexcomV3Options {
  return {
    clientId: "client",
    clientSecret: "secret",
    redirectUri: "http://localhost:8080/callback",
    region: "ous",
    tokens: memoryTokenStorage(VALID),
    now: () => NOW,
    ...overrides,
  };
}

function egv(recordId: string, systemTime: string, value: number | null = 120) {
  return {
    recordId,
    systemTime,
    displayTime: `${systemTime}+02:00`,
    transmitterTicks: 72_364_324_786,
    value,
    trend: "flat",
    trendRate: 0.4,
    unit: "mg/dL",
    rateUnit: "mg/dL/min",
    displayDevice: "iOS",
    transmitterGeneration: "g7",
    transmitterGenerationVariant: "g7",
  };
}

const page = (records: unknown[]) => jsonResponse({ recordType: "egv", recordVersion: "3.0", userId: "u", records });
const tokenResponse = (extra: Record<string, unknown> = {}) =>
  jsonResponse({ access_token: "a2", refresh_token: "r2", expires_in: 7200, token_type: "Bearer", ...extra });
/**
 * Every string reachable from an error, its cause chain and their properties. A Request shows
 * up as "[request]": its body (client secret, codes) cannot be read synchronously, so an error
 * must not carry one at all.
 */
function errorText(error: unknown, seen = new Set<unknown>()): string {
  if (typeof error !== "object" || error === null || seen.has(error)) return typeof error === "string" ? error : "";
  seen.add(error);
  const parts = Object.getOwnPropertyNames(error).map((key) => {
    const value: unknown = Reflect.get(error, key);
    if (value instanceof Request) return `[request] ${value.url} ${JSON.stringify([...value.headers])}`;
    if (typeof value === "object") return errorText(value, seen);
    return typeof value === "string" ? value : "";
  });
  return parts.join(" ");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Polls until `condition` holds; for tests that wait on a specific interleaving. */
async function until(condition: () => boolean): Promise<void> {
  if (condition()) return;
  await sleep(1);
  await until(condition);
}
const callback = (query: string) => parseOAuthCallback(new URL(`http://localhost:8080/callback?${query}`), "s1");
const devicesPage = () => jsonResponse({ recordType: "device", recordVersion: "3.0", userId: "u", records: [] });
const dataRange = (egvs?: [string, string]) =>
  jsonResponse({
    recordType: "dataRange",
    recordVersion: "3.0",
    userId: "u",
    ...(egvs && {
      egvs: { start: { systemTime: egvs[0], displayTime: egvs[0] }, end: { systemTime: egvs[1], displayTime: egvs[1] } },
    }),
  });

describe("v3 client", () => {
  describe("OAuth", () => {
    it("builds the authorize URL on the regional host", () => {
      const url = new URL(createDexcomV3(options()).authorizeUrl("s1"));
      assert.equal(url.origin, "https://api.dexcom.eu");
      assert.equal(url.pathname, "/v3/oauth2/login");
      assert.deepEqual(Object.fromEntries(url.searchParams), {
        client_id: "client",
        redirect_uri: "http://localhost:8080/callback",
        response_type: "code",
        scope: "offline_access",
        state: "s1",
      });
    });

    it("creates unguessable states", () => {
      assert.notEqual(createOAuthState(), createOAuthState());
      assert.ok(createOAuthState().length >= 40);
    });

    it("accepts a callback only with the expected state", () => {
      assert.deepEqual(callback("code=c&state=s1"), { code: "c" });
      assert.deepEqual(callback("code=c&state=other"), { error: "state mismatch" });
      assert.deepEqual(callback("error=access_denied&state=s1"), { error: "access_denied" });
      assert.deepEqual(callback("state=s1"), { error: "no code in callback" });
    });

    it("exchanges the code and stores the tokens", async (t) => {
      const tokens = memoryTokenStorage();
      const requests = stubFetch(t, tokenResponse());
      await createDexcomV3(options({ tokens })).exchangeCode("the-code");
      assert.deepEqual(await tokens.load(), { accessToken: "a2", refreshToken: "r2", expiresAt: NOW + 7_200_000 });
      const body = new URLSearchParams(await requests[0]?.text());
      assert.deepEqual(Object.fromEntries(body), {
        client_id: "client",
        client_secret: "secret",
        grant_type: "authorization_code",
        code: "the-code",
        redirect_uri: "http://localhost:8080/callback",
      });
    });

    it("accepts token responses with fields beyond the spec", async (t) => {
      const tokens = memoryTokenStorage();
      stubFetch(t, tokenResponse({ refresh_expires_in: 0, scope: "offline_access" }));
      await createDexcomV3(options({ tokens })).exchangeCode("c");
      assert.equal((await tokens.load())?.refreshToken, "r2");
    });

    it("rejects a token response without refresh token", async (t) => {
      stubFetch(t, jsonResponse({ access_token: "a2", expires_in: 7200 }));
      await assert.rejects(createDexcomV3(options()).exchangeCode("c"), DexcomResponseError);
    });

    it("reports a rejected code as an auth error with the OAuth error code", async (t) => {
      stubFetch(t, jsonResponse({ error: "invalid_grant" }, 400));
      await assert.rejects(createDexcomV3(options()).exchangeCode("c"), (error) => {
        assert.ok(error instanceof DexcomAuthError);
        assert.match(error.message, /invalid_grant/);
        return true;
      });
    });

    it("keeps the client secret and codes out of token errors", async (t) => {
      stubFetch(t, jsonResponse({ error: "invalid_client" }, 400));
      const error: unknown = await createDexcomV3(options()).exchangeCode("the-code").then(
        () => assert.fail("expected an error"),
        (rejection: unknown) => rejection,
      );
      assert.doesNotMatch(errorText(error), /\[request\]|secret|the-code/);
    });
  });

  describe("tokens", () => {
    it("requires a sign-in before data requests", async (t) => {
      const requests = stubFetch(t);
      await assert.rejects(createDexcomV3(options({ tokens: memoryTokenStorage() })).devices(), DexcomAuthError);
      assert.equal(requests.length, 0);
    });

    it("uses a valid access token without refreshing", async (t) => {
      const requests = stubFetch(t, jsonResponse({ recordType: "device", recordVersion: "3.0", userId: "u", records: [] }));
      await createDexcomV3(options()).devices();
      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.headers.get("Authorization"), "Bearer a1");
    });

    it("refreshes an expiring token and persists the new refresh token first", async (t) => {
      const tokens = memoryTokenStorage(EXPIRED);
      const requests = stubFetch(t, tokenResponse(), jsonResponse({ recordType: "device", recordVersion: "3.0", userId: "u", records: [] }));
      await createDexcomV3(options({ tokens })).devices();
      const refreshBody = Object.fromEntries(new URLSearchParams(await requests[0]?.text()));
      assert.equal(refreshBody.grant_type, "refresh_token");
      assert.equal(refreshBody.refresh_token, "r1");
      assert.equal(requests[1]?.headers.get("Authorization"), "Bearer a2");
      assert.equal((await tokens.load())?.refreshToken, "r2");
    });

    it("refreshes only once for concurrent requests", async (t) => {
      const requests = stubFetch(t, tokenResponse(), devicesPage(), devicesPage());
      const dexcom = createDexcomV3(options({ tokens: memoryTokenStorage(EXPIRED) }));
      await Promise.all([dexcom.devices(), dexcom.devices()]);
      assert.equal(requests.filter((r) => r.url.endsWith("/oauth2/token")).length, 1);
    });

    it("asks for a new sign-in when the refresh token is rejected", async (t) => {
      stubFetch(t, jsonResponse({ error: "invalid_grant" }, 400));
      await assert.rejects(createDexcomV3(options({ tokens: memoryTokenStorage(EXPIRED) })).devices(), DexcomAuthError);
    });

    it("refreshes once on 401 and retries with the new token", async (t) => {
      const requests = stubFetch(
        t,
        jsonResponse({}, 401),
        tokenResponse(),
        jsonResponse({ recordType: "device", recordVersion: "3.0", userId: "u", records: [] }),
      );
      await createDexcomV3(options()).devices();
      assert.deepEqual(
        requests.map((r) => [new URL(r.url).pathname, r.headers.get("Authorization")]),
        [
          ["/v3/users/self/devices", "Bearer a1"],
          ["/v3/oauth2/token", null],
          ["/v3/users/self/devices", "Bearer a2"],
        ],
      );
    });

    it("keeps the bearer token out of HTTP errors", async (t) => {
      stubFetch(t, jsonResponse({}, 500));
      const error: unknown = await createDexcomV3(options()).devices().then(
        () => assert.fail("expected an error"),
        (rejection: unknown) => rejection,
      );
      assert.ok(error instanceof DexcomHttpError);
      assert.doesNotMatch(errorText(error), /\[request\]|a1/);
    });

    it("shares one refresh between clients that use the same token storage", async (t) => {
      const tokens = memoryTokenStorage(EXPIRED);
      const requests = stubFetch(t, tokenResponse(), devicesPage(), devicesPage());
      await Promise.all([createDexcomV3(options({ tokens })).devices(), createDexcomV3(options({ tokens })).devices()]);
      assert.equal(requests.filter((r) => r.url.endsWith("/oauth2/token")).length, 1);
    });

    it("keeps a rotated token whose save failed and never reuses the consumed refresh token", async (t) => {
      let stored: StoredToken | null = EXPIRED;
      let failSaves = 1;
      const tokens = {
        load: () => Promise.resolve(stored),
        save: (token: StoredToken) => {
          if (failSaves > 0) {
            failSaves -= 1;
            return Promise.reject(new Error("storage unavailable"));
          }
          stored = token;
          return Promise.resolve();
        },
      };
      const requests = stubFetch(t, tokenResponse(), devicesPage());
      const dexcom = createDexcomV3(options({ tokens }));
      await assert.rejects(dexcom.devices(), /storage unavailable/);
      await dexcom.devices();
      assert.equal(requests.filter((r) => r.url.endsWith("/oauth2/token")).length, 1);
      assert.equal((await tokens.load())?.refreshToken, "r2");
      assert.equal(requests[1]?.headers.get("Authorization"), "Bearer a2");
    });

    it("does not refresh again for a 401 on a token that was already replaced", async (t) => {
      const tokens = memoryTokenStorage(VALID);
      const requests = stubFetch(
        t,
        async () => {
          // Another client refreshed while this request, sent with a1, was in flight.
          await tokens.save({ accessToken: "a9", refreshToken: "r9", expiresAt: NOW + 7_200_000 });
          return jsonResponse({}, 401);
        },
        devicesPage(),
      );
      await createDexcomV3(options({ tokens })).devices();
      assert.equal(requests.filter((r) => r.url.endsWith("/oauth2/token")).length, 0);
      assert.equal(requests[1]?.headers.get("Authorization"), "Bearer a9");
    });

    it("never sends a refresh token twice, even with slow storage and a failed save", async (t) => {
      // Storage with latency; the first save fails, the next one is slower than the rest.
      let stored: StoredToken | null = EXPIRED;
      let saves = 0;
      const tokens = {
        load: async () => {
          const snapshot = stored;
          await sleep(2);
          return snapshot;
        },
        save: async (token: StoredToken) => {
          saves += 1;
          if (saves === 1) throw new Error("storage unavailable");
          await sleep(saves === 2 ? 20 : 1);
          stored = token;
        },
      };
      const sentRefreshTokens: string[] = [];
      let issued = 1;
      t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (!request.url.endsWith("/oauth2/token")) return devicesPage();
        sentRefreshTokens.push(new URLSearchParams(await request.text()).get("refresh_token") ?? "");
        issued += 1;
        // Short-lived tokens: every access refreshes again.
        return jsonResponse({ access_token: `a${String(issued)}`, refresh_token: `r${String(issued)}`, expires_in: 30 });
      });
      const dexcom = createDexcomV3(options({ tokens }));
      await assert.rejects(dexcom.devices(), /storage unavailable/);
      await Promise.all([dexcom.devices(), dexcom.devices(), dexcom.devices()]);
      assert.equal(new Set(sentRefreshTokens).size, sentRefreshTokens.length, `reused: ${sentRefreshTokens.join(",")}`);
      assert.equal((await tokens.load())?.refreshToken, `r${String(issued)}`);
    });

    it("does not rotate again when a 401 recovery read the token before another refresh finished", async (t) => {
      // Interleaving: A's recovery is reading storage when B's 401 arrives; B's read sees a1,
      // A then refreshes to a2 and finishes, and only then does B's read return.
      let stored: StoredToken | null = VALID;
      let loads = 0;
      const held = new Map<number, () => void>();
      const tokens = {
        load: async () => {
          loads += 1;
          const call = loads;
          const snapshot = stored;
          if (call === 3 || call === 4) await new Promise<void>((resolve) => held.set(call, resolve));
          return snapshot;
        },
        save: (token: StoredToken) => {
          stored = token;
          return Promise.resolve();
        },
      };
      const release = (call: number) => {
        held.get(call)?.();
      };
      let refreshes = 0;
      let dataRequests = 0;
      const second401 = Promise.withResolvers<void>();
      t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/oauth2/token")) {
          refreshes += 1;
          return tokenResponse();
        }
        dataRequests += 1;
        if (request.headers.get("Authorization") !== "Bearer a1") return devicesPage();
        if (dataRequests === 2) await second401.promise;
        return jsonResponse({}, 401);
      });

      const dexcom = createDexcomV3(options({ tokens }));
      const a = dexcom.devices();
      const b = dexcom.devices();
      await until(() => held.has(3)); // A's recovery is reading storage
      second401.resolve();
      await sleep(5); // B's recovery starts its read (or queues behind A)
      release(3);
      // A's refresh is done (a2 stored) and B's read is held: release it now. Waiting for all of
      // A instead would deadlock, because A's retry queues behind B's recovery.
      await until(() => stored?.accessToken === "a2" && held.has(4));
      release(4);
      await Promise.all([a, b]);
      assert.equal(refreshes, 1);
    });

    it("rejects a storage callback that calls the client again, and keeps working afterwards", async (t) => {
      let stored: StoredToken | null = VALID;
      let reenter = true;
      const tokens = {
        load: async (): Promise<StoredToken | null> => {
          if (reenter) {
            reenter = false;
            await dexcom.devices();
          }
          return stored;
        },
        save: (token: StoredToken) => {
          stored = token;
          return Promise.resolve();
        },
      };
      const dexcom = createDexcomV3(options({ tokens }));
      stubFetch(t, devicesPage());
      await assert.rejects(dexcom.devices(), /must not call a Dexcom client/);
      assert.deepEqual(await dexcom.devices(), []);
    });

    it("rejects indirect re-entry through another client's storage", async (t) => {
      let reenter = true;
      const storageA = {
        load: async (): Promise<StoredToken | null> => {
          if (reenter) {
            reenter = false;
            await clientB.devices();
          }
          return VALID;
        },
        save: () => Promise.resolve(),
      };
      const storageB = {
        load: async (): Promise<StoredToken | null> => {
          await clientA.devices();
          return VALID;
        },
        save: () => Promise.resolve(),
      };
      const clientA = createDexcomV3(options({ tokens: storageA }));
      const clientB = createDexcomV3(options({ tokens: storageB }));
      stubFetch(t, devicesPage());
      await assert.rejects(clientA.devices(), /must not call a Dexcom client/);
      assert.deepEqual(await clientA.devices(), []);
    });

    it("gives up after a second 401", async (t) => {
      stubFetch(t, jsonResponse({}, 401), tokenResponse(), jsonResponse({}, 401));
      await assert.rejects(createDexcomV3(options()).devices(), (error) => error instanceof DexcomHttpError && error.status === 401);
    });
  });

  describe("records", () => {
    it("splits long ranges into windows the API accepts", async (t) => {
      const from = new Date("2026-01-01T00:00:00Z");
      const to = new Date(from.getTime() + 95 * DAY_MS);
      const requests = stubFetch(t, page([]), page([]), page([]), page([]));
      await createDexcomV3(options()).egvs({ from, to });
      const windows = requests.map((r) => {
        const url = new URL(r.url);
        return [url.searchParams.get("startDate"), url.searchParams.get("endDate")];
      });
      assert.deepEqual(windows, [
        ["2026-01-01T00:00:00", "2026-01-31T00:00:00"],
        ["2026-01-31T00:00:00", "2026-03-02T00:00:00"],
        ["2026-03-02T00:00:00", "2026-04-01T00:00:00"],
        ["2026-04-01T00:00:00", "2026-04-06T00:00:00"],
      ]);
      assert.ok(MAX_WINDOW_MS === 30 * DAY_MS);
    });

    it("queries whole seconds and filters to the exact half-open range", async (t) => {
      const requests = stubFetch(
        t,
        page([egv("before", "2026-10-16T08:00:00"), egv("inside", "2026-10-16T08:00:01"), egv("end", "2026-10-16T08:00:02")]),
      );
      const records = await createDexcomV3(options()).egvs({
        from: new Date("2026-10-16T08:00:00.500Z"),
        to: new Date("2026-10-16T08:00:02.000Z"),
      });
      const url = new URL(requests[0]?.url ?? "");
      assert.equal(url.searchParams.get("startDate"), "2026-10-16T08:00:00");
      assert.equal(url.searchParams.get("endDate"), "2026-10-16T08:00:02");
      assert.deepEqual(records.map((r) => r.recordId), ["inside"]);
    });

    it("rounds a fractional end up so the last second is queried", async (t) => {
      const requests = stubFetch(t, page([egv("x", "2026-10-16T12:00:00")]));
      const records = await createDexcomV3(options()).egvs({
        from: new Date("2026-10-16T11:00:00Z"),
        to: new Date("2026-10-16T12:00:00.500Z"),
      });
      assert.equal(new URL(requests[0]?.url ?? "").searchParams.get("endDate"), "2026-10-16T12:00:01");
      assert.deepEqual(records.map((r) => r.recordId), ["x"]);
    });

    it("rejects an empty or inverted range without a request", async (t) => {
      const requests = stubFetch(t);
      const at = new Date(NOW);
      await assert.rejects(createDexcomV3(options()).egvs({ from: at, to: at }), DexcomRangeError);
      assert.equal(requests.length, 0);
    });

    it("maps EGVs to readings, oldest first", async (t) => {
      stubFetch(t, page([egv("b", "2026-10-16T08:05:00", null), egv("a", "2026-10-16T08:00:00", 112)]));
      const readings = await createDexcomV3(options()).getReadings({
        from: new Date("2026-10-16T08:00:00Z"),
        to: new Date("2026-10-16T09:00:00Z"),
      });
      assert.deepEqual(readings, [
        { time: new Date("2026-10-16T08:00:00Z"), mgdl: 112, status: null, trend: "flat", trendRate: 0.4 },
        { time: new Date("2026-10-16T08:05:00Z"), mgdl: null, status: null, trend: "flat", trendRate: 0.4 },
      ]);
    });

    it("returns int64 fields as bigint", async (t) => {
      stubFetch(t, page([egv("a", "2026-10-16T08:00:00")]));
      const [record] = await createDexcomV3(options()).egvs({ from: new Date(NOW - DAY_MS), to: new Date(NOW) });
      assert.equal(record?.transmitterTicks, 72_364_324_786n);
    });

    it("reads the latest reading at the end of the data range", async (t) => {
      const requests = stubFetch(t, dataRange(["2026-01-01T00:00:00", "2026-10-16T09:00:00"]), page([egv("x", "2026-10-16T09:00:00", 140)]));
      const latest = await createDexcomV3(options()).getLatestReading();
      assert.equal(latest?.mgdl, 140);
      const url = new URL(requests[1]?.url ?? "");
      assert.equal(url.searchParams.get("startDate"), "2026-10-16T08:45:00");
      assert.equal(url.searchParams.get("endDate"), "2026-10-16T09:00:01");
    });

    it("returns null as latest reading without data", async (t) => {
      stubFetch(t, dataRange());
      assert.equal(await createDexcomV3(options()).getLatestReading(), null);
    });

    it("passes lastSyncTime to dataRange", async (t) => {
      const requests = stubFetch(t, dataRange());
      await createDexcomV3(options()).dataRange(new Date("2026-10-01T00:00:00Z"));
      assert.equal(new URL(requests[0]?.url ?? "").searchParams.get("lastSyncTime"), "2026-10-01T00:00:00");
    });

    it("reports a payload that violates the spec", async (t) => {
      stubFetch(t, page([{ recordId: "a" }]));
      await assert.rejects(createDexcomV3(options()).egvs({ from: new Date(NOW - DAY_MS), to: new Date(NOW) }), DexcomResponseError);
    });

    it("reports other HTTP errors with their status", async (t) => {
      stubFetch(t, jsonResponse({}, 429));
      await assert.rejects(createDexcomV3(options()).devices(), (error) => error instanceof DexcomHttpError && error.status === 429);
    });
  });

  it("describes its capabilities per region", () => {
    assert.deepEqual(createDexcomV3(options({ region: "us" })).capabilities, { realtime: false, delayMs: 3_600_000, historyMs: null });
    assert.equal(createDexcomV3(options({ region: "ous" })).capabilities.delayMs, 10_800_000);
  });
});

describe("token storage", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dexcom-ts-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null before the first save", async () => {
    assert.equal(await fileTokenStorage(join(dir, "token.json")).load(), null);
  });

  it("round-trips tokens through a 0600 file without leftovers", async () => {
    const path = join(dir, "token.json");
    await fileTokenStorage(path).save(VALID);
    assert.deepEqual(await fileTokenStorage(path).load(), VALID);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir), ["token.json"]);
  });

  it("survives overlapping saves", async () => {
    const path = join(dir, "token.json");
    const storage = fileTokenStorage(path);
    const tokens = Array.from({ length: 10 }, (_, i) => ({ ...VALID, accessToken: `a${String(i)}` }));
    await Promise.all(tokens.map((token) => storage.save(token)));
    const loaded = await storage.load();
    assert.ok(tokens.some((token) => token.accessToken === loaded?.accessToken));
    assert.deepEqual(readdirSync(dir), ["token.json"]);
  });

  it("treats a malformed file as signed out", async () => {
    const path = join(dir, "token.json");
    writeFileSync(path, JSON.stringify({ accessToken: 1 }));
    await assert.rejects(fileTokenStorage(path).load(), DexcomAuthError);
  });
});
