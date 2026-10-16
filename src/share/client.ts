/**
 * Client for Dexcom Share, the unofficial service behind the Dexcom Follow app.
 *
 * Share is not documented by Dexcom and can change without notice. The protocol follows
 * pydexcom (https://github.com/gagebenne/pydexcom, MIT).
 */
import { z } from "zod";
import { DexcomAuthError, DexcomHttpError, DexcomRangeError, DexcomResponseError } from "../errors.ts";
import { assertRange } from "../time.ts";
import { type Capabilities, type Dexcom, type GlucoseReading, type Trend, toTrend } from "../types.ts";

export const SHARE_BASE_URLS = {
  us: "https://share2.dexcom.com/ShareWebServices/Services",
  ous: "https://shareous1.dexcom.com/ShareWebServices/Services",
  jp: "https://share.dexcom.jp/ShareWebServices/Services",
} as const;
export type ShareRegion = keyof typeof SHARE_BASE_URLS;

const APPLICATION_IDS: Record<ShareRegion, string> = {
  us: "d89443d2-327c-4a6f-89e5-496bbb0317db",
  ous: "d89443d2-327c-4a6f-89e5-496bbb0317db",
  jp: "d8665ade-9673-4e27-9ff6-92db4ce13d13",
};

/** Share keeps 24 h of readings and returns at most one per 5 minutes. */
export const SHARE_MAX_MINUTES = 1440;
export const SHARE_MAX_COUNT = 288;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_UUID = "00000000-0000-0000-0000-000000000000";

export type DexcomShareOptions = {
  /** Password of the Dexcom account that shares its data (not a follower account). */
  password: string;
  region: ShareRegion;
  /** Per-request timeout; default 30 s. */
  timeoutMs?: number;
  /** Injectable fetch and clock, mainly for tests. */
  fetch?: typeof fetch;
  now?: () => number;
} & ({ username: string; accountId?: never } | { accountId: string; username?: never });

export interface DexcomShare extends Dexcom {
  readonly source: "share";
}

const uuidSchema = z.uuid().refine((value) => value !== DEFAULT_UUID, "default UUID");
const errorSchema = z.looseObject({ Code: z.string().optional(), Message: z.string().optional() });
// Share used numeric trends before switching to names; both map onto the same order.
const NUMERIC_TRENDS: readonly Trend[] = [
  "none",
  "doubleUp",
  "singleUp",
  "fortyFiveUp",
  "flat",
  "fortyFiveDown",
  "singleDown",
  "doubleDown",
  "notComputable",
  "rateOutOfRange",
];
const readingSchema = z.looseObject({
  WT: z.string(),
  Value: z.number(),
  Trend: z.union([z.string(), z.number()]),
});
const SHARE_DATE = /^Date\((-?\d+)(?:[+-]\d{4})?\)$/;

function toShareTrend(trend: string | number): Trend {
  if (typeof trend === "number") return NUMERIC_TRENDS[trend] ?? "unknown";
  return toTrend(trend.charAt(0).toLowerCase() + trend.slice(1));
}

function toReading(raw: z.infer<typeof readingSchema>): GlucoseReading {
  // WT is the sensor's measurement time as epoch milliseconds (UTC).
  const match = SHARE_DATE.exec(raw.WT);
  if (!match?.[1]) throw new DexcomResponseError("unexpected Share timestamp");
  return { time: new Date(Number(match[1])), mgdl: raw.Value, status: null, trend: toShareTrend(raw.Trend), trendRate: null };
}

const SESSION_CODES = new Set(["SessionIdNotFound", "SessionNotValid"]);

class ShareSessionExpired extends Error {}

export function createDexcomShare(options: DexcomShareOptions): DexcomShare {
  const baseUrl = SHARE_BASE_URLS[options.region];
  const applicationId = APPLICATION_IDS[options.region];
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let accountId = options.accountId ?? null;
  let session: Promise<string> | null = null;

  async function post(endpoint: string, body: object, query?: Record<string, string>): Promise<unknown> {
    const url = `${baseUrl}/${endpoint}${query ? `?${new URLSearchParams(query).toString()}` : ""}`;
    const response = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new DexcomResponseError(`Share ${endpoint} returned no JSON (HTTP ${String(response.status)})`, { cause: error });
    }
    if (response.ok) return payload;
    // Only the documented error code goes into the message; never the request body (it holds the password).
    const { Code: code = "unknown", Message: message = "" } = errorSchema.catch({}).parse(payload);
    if (SESSION_CODES.has(code)) throw new ShareSessionExpired(code);
    if (
      code === "AccountPasswordInvalid" ||
      code === "SSO_AuthenticateMaxAttemptsExceeded" ||
      (code === "SSO_InternalError" && message.includes("Cannot Authenticate"))
    ) {
      throw new DexcomAuthError(`Share rejected the credentials (${code})`);
    }
    throw new DexcomHttpError(response.status, `Share ${endpoint} failed (${code})`);
  }

  async function login(): Promise<string> {
    if (accountId === null) {
      const id = uuidSchema.safeParse(
        await post("General/AuthenticatePublisherAccount", {
          accountName: options.username,
          password: options.password,
          applicationId,
        }),
      );
      if (!id.success) throw new DexcomAuthError("Share returned no valid account id");
      accountId = id.data;
    }
    const newSession = uuidSchema.safeParse(
      await post("General/LoginPublisherAccountById", { accountId, password: options.password, applicationId }),
    );
    if (!newSession.success) throw new DexcomAuthError("Share returned no valid session id");
    return newSession.data;
  }

  function startLogin(): Promise<string> {
    const attempt = login();
    session = attempt;
    // A failed login must not stick, but only clear it if no newer login replaced it meanwhile.
    attempt.catch(() => {
      if (session === attempt) session = null;
    });
    return attempt;
  }

  function sessionId(): Promise<string> {
    return session ?? startLogin();
  }

  /** Replaces an expired session once, however many requests saw it expire. */
  async function renewSession(expired: string): Promise<string> {
    const current = session;
    if (current) {
      const id = await current.catch(() => null);
      if (id !== null && id !== expired) return id;
    }
    return session === current ? startLogin() : sessionId();
  }

  async function readings(minutes: number, maxCount: number): Promise<GlucoseReading[]> {
    const query = { minutes: String(minutes), maxCount: String(maxCount) };
    const read = (id: string) => post("Publisher/ReadPublisherLatestGlucoseValues", {}, { sessionId: id, ...query });
    const id = await sessionId();
    let payload: unknown;
    try {
      payload = await read(id);
    } catch (error) {
      if (!(error instanceof ShareSessionExpired)) throw error;
      payload = await read(await renewSession(id));
    }
    const parsed = z.array(readingSchema).safeParse(payload);
    if (!parsed.success) throw new DexcomResponseError("unexpected Share readings response", { cause: parsed.error });
    return parsed.data.map(toReading).toSorted((a, b) => a.time.getTime() - b.time.getTime());
  }

  const capabilities: Capabilities = { realtime: true, delayMs: 0, historyMs: SHARE_MAX_MINUTES * 60 * 1000 };

  return {
    source: "share",
    capabilities,

    async getReadings(range) {
      assertRange(range);
      const minutes = Math.ceil((now() - range.from.getTime()) / 60_000);
      if (minutes > SHARE_MAX_MINUTES) throw new DexcomRangeError("Dexcom Share keeps only the last 24 hours");
      const all = await readings(Math.max(minutes, 1), SHARE_MAX_COUNT);
      return all.filter(({ time }) => time >= range.from && time < range.to);
    },

    async getLatestReading() {
      const [latest] = await readings(SHARE_MAX_MINUTES, 1);
      return latest ?? null;
    },
  };
}
