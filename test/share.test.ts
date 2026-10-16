import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createDexcomShare,
  DexcomAuthError,
  DexcomHttpError,
  DexcomRangeError,
  DexcomResponseError,
  type DexcomShareOptions,
  type ShareRegion,
} from "../src/share/index.ts";
import { jsonResponse } from "./support.ts";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const ACCOUNT_ID = "11111111-2222-4333-8444-555555555555";
const SESSION_ID = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const SESSION_ID_2 = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const PASSWORD = "s3cret-password";

/** A Share reading as the service sends it: Microsoft JSON dates, newest first. */
function reading(minutesAgo: number, value: number, trend: string | number = "Flat") {
  const ms = NOW - minutesAgo * 60_000;
  return { WT: `Date(${String(ms)})`, ST: `Date(${String(ms)})`, DT: `Date(${String(ms)}+0200)`, Value: value, Trend: trend };
}

/** A fetch stand-in that records requests and answers from a queue. */
function fakeShare(...responses: Response[]) {
  const requests: Request[] = [];
  const fetchFn = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push(new Request(input, init));
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return Promise.resolve(next);
  };
  return { fetchFn, requests };
}

function options(fetchFn: typeof fetch, region: ShareRegion = "ous"): DexcomShareOptions {
  return { username: "user@example.com", password: PASSWORD, region, fetch: fetchFn, now: () => NOW };
}

const shareError = (code: string, message = "", status = 500) => jsonResponse({ Code: code, Message: message }, status);

describe("share client", () => {
  it("authenticates, opens a session and reads glucose values", async () => {
    const { fetchFn, requests } = fakeShare(jsonResponse(ACCOUNT_ID), jsonResponse(SESSION_ID), jsonResponse([reading(5, 120), reading(10, 118)]));
    const readings = await createDexcomShare(options(fetchFn)).getReadings({ from: new Date(NOW - 60 * 60_000), to: new Date(NOW) });

    assert.deepEqual(
      readings.map((r) => [r.time.toISOString(), r.mgdl, r.trend]),
      [
        ["2026-10-16T11:50:00.000Z", 118, "flat"],
        ["2026-10-16T11:55:00.000Z", 120, "flat"],
      ],
    );
    const [auth, login, read] = requests;
    assert.ok(auth && login && read);
    assert.equal(auth.url, "https://shareous1.dexcom.com/ShareWebServices/Services/General/AuthenticatePublisherAccount");
    assert.deepEqual(await auth.json(), {
      accountName: "user@example.com",
      password: PASSWORD,
      applicationId: "d89443d2-327c-4a6f-89e5-496bbb0317db",
    });
    assert.equal(login.url, "https://shareous1.dexcom.com/ShareWebServices/Services/General/LoginPublisherAccountById");
    assert.deepEqual(await login.json(), { accountId: ACCOUNT_ID, password: PASSWORD, applicationId: "d89443d2-327c-4a6f-89e5-496bbb0317db" });
    const url = new URL(read.url);
    assert.equal(url.pathname, "/ShareWebServices/Services/Publisher/ReadPublisherLatestGlucoseValues");
    assert.deepEqual(Object.fromEntries(url.searchParams), { sessionId: SESSION_ID, minutes: "60", maxCount: "288" });
    assert.equal(read.method, "POST");
  });

  it("skips the account lookup when the account id is known", async () => {
    const { fetchFn, requests } = fakeShare(jsonResponse(SESSION_ID), jsonResponse([]));
    const dexcom = createDexcomShare({ accountId: ACCOUNT_ID, password: PASSWORD, region: "ous", fetch: fetchFn, now: () => NOW });
    await dexcom.getLatestReading();
    assert.equal(requests.length, 2);
    assert.ok(requests[0]?.url.endsWith("LoginPublisherAccountById"));
  });

  it("uses the Japanese host and application id", async () => {
    const { fetchFn, requests } = fakeShare(jsonResponse(ACCOUNT_ID), jsonResponse(SESSION_ID), jsonResponse([]));
    await createDexcomShare(options(fetchFn, "jp")).getLatestReading();
    assert.ok(requests[0]?.url.startsWith("https://share.dexcom.jp/"));
    const body: unknown = await requests[0]?.json();
    assert.deepEqual(body, { accountName: "user@example.com", password: PASSWORD, applicationId: "d8665ade-9673-4e27-9ff6-92db4ce13d13" });
  });

  it("reuses the session across calls", async () => {
    const { fetchFn, requests } = fakeShare(jsonResponse(ACCOUNT_ID), jsonResponse(SESSION_ID), jsonResponse([]), jsonResponse([]));
    const dexcom = createDexcomShare(options(fetchFn));
    await dexcom.getLatestReading();
    await dexcom.getLatestReading();
    assert.equal(requests.length, 4);
  });

  it("opens a new session once when the old one expired", async () => {
    const { fetchFn, requests } = fakeShare(
      jsonResponse(ACCOUNT_ID),
      jsonResponse(SESSION_ID),
      shareError("SessionNotValid"),
      jsonResponse(SESSION_ID_2),
      jsonResponse([reading(5, 99)]),
    );
    const latest = await createDexcomShare(options(fetchFn)).getLatestReading();
    assert.equal(latest?.mgdl, 99);
    assert.equal(new URL(requests[4]?.url ?? "").searchParams.get("sessionId"), SESSION_ID_2);
  });

  it("renews an expired session only once for concurrent requests", async () => {
    let logins = 0;
    const requests: string[] = [];
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      requests.push(request.url);
      if (request.url.endsWith("AuthenticatePublisherAccount")) return jsonResponse(ACCOUNT_ID);
      if (request.url.endsWith("LoginPublisherAccountById")) {
        logins += 1;
        return jsonResponse(logins === 1 ? SESSION_ID : SESSION_ID_2);
      }
      const sessionId = new URL(request.url).searchParams.get("sessionId");
      // Let both reads with the old session fail before either renews it.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return sessionId === SESSION_ID ? shareError("SessionIdNotFound") : jsonResponse([reading(5, 100)]);
    };
    const dexcom = createDexcomShare(options(fetchFn));
    const [a, b] = await Promise.all([dexcom.getLatestReading(), dexcom.getLatestReading()]);
    assert.equal(a?.mgdl, 100);
    assert.equal(b?.mgdl, 100);
    assert.equal(logins, 2);
  });

  it("returns the latest reading with a 24 h window and one value", async () => {
    const { fetchFn, requests } = fakeShare(jsonResponse(ACCOUNT_ID), jsonResponse(SESSION_ID), jsonResponse([reading(3, 140, "SingleUp")]));
    const latest = await createDexcomShare(options(fetchFn)).getLatestReading();
    assert.deepEqual(latest, { time: new Date(NOW - 180_000), mgdl: 140, status: null, trend: "singleUp", trendRate: null });
    const url = new URL(requests[2]?.url ?? "");
    assert.equal(url.searchParams.get("minutes"), "1440");
    assert.equal(url.searchParams.get("maxCount"), "1");
  });

  it("returns null without readings", async () => {
    const { fetchFn } = fakeShare(jsonResponse(ACCOUNT_ID), jsonResponse(SESSION_ID), jsonResponse([]));
    assert.equal(await createDexcomShare(options(fetchFn)).getLatestReading(), null);
  });

  it("maps numeric and unknown trends", async () => {
    const { fetchFn } = fakeShare(jsonResponse(ACCOUNT_ID), jsonResponse(SESSION_ID), jsonResponse([reading(5, 100, 7), reading(10, 100, "Sideways")]));
    const readings = await createDexcomShare(options(fetchFn)).getReadings({ from: new Date(NOW - 60 * 60_000), to: new Date(NOW) });
    assert.deepEqual(readings.map((r) => r.trend), ["unknown", "doubleDown"]);
  });

  it("filters readings to the requested range", async () => {
    const { fetchFn } = fakeShare(jsonResponse(ACCOUNT_ID), jsonResponse(SESSION_ID), jsonResponse([reading(5, 1), reading(30, 2), reading(55, 3)]));
    const readings = await createDexcomShare(options(fetchFn)).getReadings({
      from: new Date(NOW - 40 * 60_000),
      to: new Date(NOW - 10 * 60_000),
    });
    assert.deepEqual(readings.map((r) => r.mgdl), [2]);
  });

  it("refuses ranges older than 24 hours without a request", async () => {
    const { fetchFn, requests } = fakeShare();
    const dexcom = createDexcomShare(options(fetchFn));
    await assert.rejects(dexcom.getReadings({ from: new Date(NOW - 25 * 60 * 60_000), to: new Date(NOW) }), DexcomRangeError);
    assert.equal(requests.length, 0);
  });

  for (const [code, message] of [
    ["AccountPasswordInvalid", ""],
    ["SSO_AuthenticateMaxAttemptsExceeded", ""],
    ["SSO_InternalError", "Cannot Authenticate by AccountName"],
  ] as const) {
    it(`reports ${code} as an auth error without leaking the password`, async () => {
      const { fetchFn } = fakeShare(shareError(code, message));
      await assert.rejects(createDexcomShare(options(fetchFn)).getLatestReading(), (error) => {
        assert.ok(error instanceof DexcomAuthError);
        assert.ok(!error.message.includes(PASSWORD));
        return true;
      });
    });
  }

  it("retries the login on the next call after a failure", async () => {
    const { fetchFn } = fakeShare(shareError("AccountPasswordInvalid"), jsonResponse(ACCOUNT_ID), jsonResponse(SESSION_ID), jsonResponse([]));
    const dexcom = createDexcomShare(options(fetchFn));
    await assert.rejects(dexcom.getLatestReading(), DexcomAuthError);
    assert.equal(await dexcom.getLatestReading(), null);
  });

  it("rejects the all-zero account id", async () => {
    const { fetchFn } = fakeShare(jsonResponse("00000000-0000-0000-0000-000000000000"));
    await assert.rejects(createDexcomShare(options(fetchFn)).getLatestReading(), DexcomAuthError);
  });

  it("reports unknown error codes with the HTTP status", async () => {
    const { fetchFn } = fakeShare(shareError("SomethingNew", "", 503));
    await assert.rejects(createDexcomShare(options(fetchFn)).getLatestReading(), (error) => error instanceof DexcomHttpError && error.status === 503);
  });

  it("reports a non-JSON answer", async () => {
    const { fetchFn } = fakeShare(new Response("<html>maintenance</html>", { status: 503 }));
    await assert.rejects(createDexcomShare(options(fetchFn)).getLatestReading(), DexcomResponseError);
  });

  it("reports malformed readings", async () => {
    const { fetchFn } = fakeShare(jsonResponse(ACCOUNT_ID), jsonResponse(SESSION_ID), jsonResponse([{ WT: "yesterday", Value: 1, Trend: "Flat" }]));
    await assert.rejects(createDexcomShare(options(fetchFn)).getLatestReading(), DexcomResponseError);
  });

  it("describes its capabilities", () => {
    const { fetchFn } = fakeShare();
    assert.deepEqual(createDexcomShare(options(fetchFn)).capabilities, { realtime: true, delayMs: 0, historyMs: 86_400_000 });
  });
});
