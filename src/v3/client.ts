import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { DexcomAuthError, DexcomError, DexcomHttpError, DexcomResponseError } from "../errors.ts";
import { type ClientInstance, createClient, ResponseError } from "../generated/.kubb/client.ts";
import { ParseError } from "../generated/.kubb/standardSchema.ts";
import {
  getAlertsEventsV3,
  getCalibrationsV3,
  getDataRangeV3,
  getDevicesV3,
  getEstimatedGlucoseValuesV3,
  getEventsV3,
  postTokenV3,
} from "../generated/clients/index.ts";
import type { ComDexcomPartnerApiModelsProtoV3AlertAlertEvent as AlertRecord } from "../generated/types/com/dexcom/partner/api/models/proto/v3/alert/AlertEvent.ts";
import type { ComDexcomPartnerApiModelsProtoV3CalibrationCalibration as CalibrationRecord } from "../generated/types/com/dexcom/partner/api/models/proto/v3/calibration/Calibration.ts";
import type { ComDexcomPartnerApiModelsProtoV3DeviceDevice as DeviceRecord } from "../generated/types/com/dexcom/partner/api/models/proto/v3/device/Device.ts";
import type { ComDexcomPartnerApiModelsProtoV3EgvEGV as EgvRecord } from "../generated/types/com/dexcom/partner/api/models/proto/v3/egv/EGV.ts";
import type { ComDexcomPartnerApiModelsProtoV3EventEvent as EventRecord } from "../generated/types/com/dexcom/partner/api/models/proto/v3/event/Event.ts";
import { assertRange, formatApiTime, parseApiTime, windows } from "../time.ts";
import { type Capabilities, type Dexcom, type GlucoseReading, type TimeRange, toTrend } from "../types.ts";
import type { StoredToken, TokenStorage } from "./tokens.ts";

export type { AlertRecord, CalibrationRecord, DeviceRecord, EgvRecord, EventRecord };

/** API hosts from the Dexcom endpoint overview; the OpenAPI document carries none. */
export const V3_BASE_URLS = {
  sandbox: "https://sandbox-api.dexcom.com",
  us: "https://api.dexcom.com",
  ous: "https://api.dexcom.eu",
  jp: "https://api.dexcom.jp",
} as const;
export type V3Region = keyof typeof V3_BASE_URLS;

/** The API rejects windows longer than 30 days with 400. */
export const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30_000;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
/** Data from the mobile apps arrives with this delay: 1 h in the US, 3 h elsewhere (Dexcom FAQ). */
const DELAY_MS = { sandbox: 0, us: 60 * 60 * 1000, ous: 3 * 60 * 60 * 1000, jp: 3 * 60 * 60 * 1000 } as const;

export interface DexcomV3Options {
  /** App credentials from developer.dexcom.com. Keep the secret server-side. */
  clientId: string;
  clientSecret: string;
  /** Must match a redirect URI registered for the app. */
  redirectUri: string;
  region: V3Region;
  tokens: TokenStorage;
  /** Per-request timeout; default 30 s. */
  timeoutMs?: number;
  /** Clock used for token expiry; injectable for tests. */
  now?: () => number;
}

export type DataRange = Partial<Record<"egvs" | "events" | "calibrations", TimeRange>>;

export interface DexcomV3 extends Dexcom {
  readonly source: "v3";
  /** Login URL for the OAuth authorization code flow. Store `state` and compare it in the callback. */
  authorizeUrl(state: string): string;
  /** Exchanges the code from the OAuth callback for tokens and stores them. */
  exchangeCode(code: string): Promise<void>;
  /** Earliest and latest record times per type; `lastSyncTime` limits it to newer data. */
  dataRange(lastSyncTime?: Date): Promise<DataRange>;
  egvs(range: TimeRange): Promise<EgvRecord[]>;
  events(range: TimeRange): Promise<EventRecord[]>;
  calibrations(range: TimeRange): Promise<CalibrationRecord[]>;
  alerts(range: TimeRange): Promise<AlertRecord[]>;
  devices(): Promise<DeviceRecord[]>;
}

/** A random value for the OAuth `state` parameter. */
export function createOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export type OAuthCallback = { code: string } | { error: string };

/** Reads the OAuth redirect; a foreign `state` means the callback did not come from this login. */
export function parseOAuthCallback(url: URL, expectedState: string): OAuthCallback {
  if (url.searchParams.get("state") !== expectedState) return { error: "state mismatch" };
  const error = url.searchParams.get("error");
  if (error) return { error };
  const code = url.searchParams.get("code");
  return code ? { code } : { error: "no code in callback" };
}

// The spec marks every token field optional and its union is strict, while Dexcom documents an
// extra `refresh_expires_in`. Accept extra fields, require the three the flow cannot do without.
const tokenResponseSchema = z.looseObject({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
});

const oauthErrorSchema = z.looseObject({ error: z.string() });

/**
 * Maps generator errors to this library's errors; everything else passes through.
 * A ResponseError is never kept as `cause`: its request holds the bearer token or the client
 * secret. Only the status and, for OAuth errors, the error code are carried over.
 */
function translate(error: unknown, what: string): unknown {
  if (error instanceof ParseError) return new DexcomResponseError(`unexpected ${what} response`, { cause: error });
  if (error instanceof ResponseError) {
    const code = oauthErrorSchema.safeParse(error.data);
    const detail = code.success ? ` (${code.data.error})` : "";
    return new DexcomHttpError(error.status, `${what} failed with HTTP ${String(error.status)}${detail}`);
  }
  return error;
}

/**
 * Token handling shared by every client that uses the same TokenStorage object. All reads,
 * refreshes and saves run one at a time through `queue`, so no two of them interleave.
 */
interface TokenState {
  queue: Promise<unknown>;
  /** A rotated token whose save failed. It replaces the stored one until a save succeeds. */
  unsaved: StoredToken | null;
}
const tokenStates = new WeakMap<TokenStorage, TokenState>();

function tokenState(storage: TokenStorage): TokenState {
  let state = tokenStates.get(storage);
  if (!state) {
    state = { queue: Promise.resolve(), unsaved: null };
    tokenStates.set(storage, state);
  }
  return state;
}

/** Token states whose queues the current async context runs in, outermost first; detects re-entry. */
const runningIn = new AsyncLocalStorage<ReadonlySet<TokenState>>();

/** Runs `work` after every earlier token operation on the same storage has settled. */
function exclusive<T>(state: TokenState, work: () => Promise<T>): Promise<T> {
  // A storage callback that calls the client again, directly or via other clients, would wait
  // for itself forever.
  const active = runningIn.getStore() ?? new Set<TokenState>();
  if (active.has(state)) {
    return Promise.reject(new DexcomError("TokenStorage load/save must not call a Dexcom client that uses the same storage"));
  }
  const runWork = () => runningIn.run(new Set([...active, state]), work);
  const run = state.queue.then(runWork, runWork);
  state.queue = run.catch(() => undefined);
  return run;
}

/** The access token a failed request carried, from its Authorization header. */
function sentAccessToken(request: unknown): string | null {
  const header = request instanceof Request ? request.headers.get("Authorization") : null;
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
}

function toReading(record: EgvRecord): GlucoseReading {
  return {
    time: parseApiTime(record.systemTime),
    mgdl: record.value ?? null,
    status: record.status ?? null,
    trend: toTrend(record.trend),
    trendRate: record.trendRate ?? null,
  };
}

export function createDexcomV3(options: DexcomV3Options): DexcomV3 {
  const { clientId, clientSecret, redirectUri, region, tokens } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const baseURL = V3_BASE_URLS[region];
  const shared = tokenState(tokens);

  const signal = () => AbortSignal.timeout(timeoutMs);
  const tokenClient: ClientInstance = createClient({ baseURL });

  async function requestToken(body: Record<string, string>, what: string): Promise<StoredToken> {
    let data: unknown;
    try {
      ({ data } = await postTokenV3({
        client: tokenClient,
        body: { client_id: clientId, client_secret: clientSecret, ...body },
        validator: { response: tokenResponseSchema },
        signal: signal(),
      }));
    } catch (error) {
      const translated = translate(error, what);
      if (translated instanceof DexcomHttpError && translated.status === 400) {
        throw new DexcomAuthError(`${translated.message}; sign in again`);
      }
      throw translated;
    }
    const token = tokenResponseSchema.parse(data);
    return { accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: now() + token.expires_in * 1000 };
  }

  // The helpers below assume they run inside `exclusive(shared, ...)`.

  /** Saves a new token; if that fails, keeps it so the consumed refresh token is never sent again. */
  async function persist(token: StoredToken): Promise<void> {
    shared.unsaved = token;
    await tokens.save(token);
    shared.unsaved = null;
  }

  async function currentToken(): Promise<StoredToken> {
    if (shared.unsaved) await persist(shared.unsaved);
    const current = await tokens.load();
    if (!current) throw new DexcomAuthError("not signed in; complete the OAuth flow first");
    return current;
  }

  async function refreshFrom(current: StoredToken): Promise<StoredToken> {
    const next = await requestToken({ grant_type: "refresh_token", refresh_token: current.refreshToken }, "token refresh");
    await persist(next);
    return next;
  }

  /** The access token to send, refreshed first if it is about to expire. */
  const accessToken = (): Promise<string> =>
    exclusive(shared, async () => {
      const current = await currentToken();
      if (current.expiresAt - TOKEN_REFRESH_MARGIN_MS > now()) return current.accessToken;
      return (await refreshFrom(current)).accessToken;
    });

  /** After a 401: refresh only if the rejected token is still the current one. */
  const recoverFrom401 = (rejected: string | null): Promise<void> =>
    exclusive(shared, async () => {
      const current = await currentToken();
      if (rejected === null || rejected === current.accessToken) await refreshFrom(current);
    });

  const api: ClientInstance = createClient({ baseURL, auth: () => accessToken() });

  /**
   * Runs a request; on 401 retries once with a fresh access token. The token is refreshed only
   * if the rejected one is still current, so a late 401 does not rotate the tokens again.
   */
  async function call<T>(what: string, request: () => Promise<{ data: T }>): Promise<T> {
    try {
      return (await request()).data;
    } catch (error) {
      if (!(error instanceof ResponseError && error.status === 401)) throw translate(error, what);
      // ResponseError is generic over `any`; narrow the request before reading it.
      const sent: unknown = error.request;
      await recoverFrom401(sentAccessToken(sent));
    }
    try {
      return (await request()).data;
    } catch (error) {
      throw translate(error, what);
    }
  }

  /**
   * Fetches [from, to) in windows the API accepts, oldest window first. The API works in whole
   * seconds, so the query covers the enclosing seconds and the records are filtered to the range.
   */
  async function ranged<T extends { systemTime: string }>(
    range: TimeRange,
    what: string,
    fetchWindow: (query: { startDate: string; endDate: string }) => Promise<{ data: { records: T[] } }>,
  ): Promise<T[]> {
    assertRange(range);
    const from = new Date(Math.floor(range.from.getTime() / 1000) * 1000);
    const to = new Date(Math.ceil(range.to.getTime() / 1000) * 1000);
    const records: T[] = [];
    for (const [start, end] of windows(from, to, MAX_WINDOW_MS)) {
      const query = { startDate: formatApiTime(start), endDate: formatApiTime(end) };
      // oxlint-disable-next-line no-await-in-loop -- one request at a time stays well inside the API rate limit
      const { records: page } = await call(what, () => fetchWindow(query));
      records.push(...page);
    }
    return records.filter((record) => {
      const time = parseApiTime(record.systemTime);
      return time >= range.from && time < range.to;
    });
  }

  const client: DexcomV3 = {
    source: "v3",
    capabilities: { realtime: false, delayMs: DELAY_MS[region], historyMs: null } satisfies Capabilities,

    authorizeUrl(state) {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "offline_access",
        state,
      });
      return `${baseURL}/v3/oauth2/login?${params.toString()}`;
    },

    async exchangeCode(code) {
      await exclusive(shared, async () => {
        await persist(await requestToken({ grant_type: "authorization_code", code, redirect_uri: redirectUri }, "code exchange"));
      });
    },

    async dataRange(lastSyncTime) {
      const data = await call("dataRange", () =>
        getDataRangeV3({
          client: api,
          query: lastSyncTime ? { lastSyncTime: formatApiTime(lastSyncTime) } : {},
          signal: signal(),
        }),
      );
      const result: DataRange = {};
      for (const kind of ["egvs", "events", "calibrations"] as const) {
        const moments = data[kind];
        if (moments) result[kind] = { from: parseApiTime(moments.start.systemTime), to: parseApiTime(moments.end.systemTime) };
      }
      return result;
    },

    egvs: (range) => ranged(range, "egvs", (query) => getEstimatedGlucoseValuesV3({ client: api, query, signal: signal() })),
    events: (range) => ranged(range, "events", (query) => getEventsV3({ client: api, query, signal: signal() })),
    calibrations: (range) => ranged(range, "calibrations", (query) => getCalibrationsV3({ client: api, query, signal: signal() })),
    alerts: (range) => ranged(range, "alerts", (query) => getAlertsEventsV3({ client: api, query, signal: signal() })),

    async devices() {
      return (await call("devices", () => getDevicesV3({ client: api, signal: signal() }))).records;
    },

    async getReadings(range) {
      const records = await client.egvs(range);
      return records.map(toReading).toSorted((a, b) => a.time.getTime() - b.time.getTime());
    },

    async getLatestReading() {
      const { egvs } = await client.dataRange();
      if (!egvs) return null;
      // endDate is exclusive: reach one second past the newest record so it is included.
      const to = new Date(egvs.to.getTime() + 1000);
      const readings = await client.getReadings({ from: new Date(egvs.to.getTime() - 15 * 60 * 1000), to });
      return readings.at(-1) ?? null;
    },
  };
  return client;
}

