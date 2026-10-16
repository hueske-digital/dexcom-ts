import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDexcom, DexcomRangeError, memoryTokenStorage, toTrend } from "../src/index.ts";
import { assertRange, formatApiTime, parseApiTime, windows } from "../src/time.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("time", () => {
  it("treats timestamps without offset as UTC and honours offsets", () => {
    assert.equal(parseApiTime("2024-01-02T03:04:05").toISOString(), "2024-01-02T03:04:05.000Z");
    assert.equal(parseApiTime("2024-01-02T03:04:05Z").toISOString(), "2024-01-02T03:04:05.000Z");
    assert.equal(parseApiTime("2024-01-02T05:04:05+02:00").toISOString(), "2024-01-02T03:04:05.000Z");
  });

  it("rejects invalid timestamps", () => {
    assert.throws(() => parseApiTime("not a time"));
  });

  it("formats in the API's UTC query format", () => {
    assert.equal(formatApiTime(new Date("2024-01-02T03:04:05.678Z")), "2024-01-02T03:04:05");
  });

  it("splits a range into gapless windows within the limit", () => {
    const start = new Date("2024-01-01T00:00:00Z");
    const end = new Date(start.getTime() + 95 * DAY_MS);
    const parts = [...windows(start, end, 30 * DAY_MS)];
    assert.equal(parts.length, 4);
    assert.deepEqual(parts[0]?.[0], start);
    assert.deepEqual(parts.at(-1)?.[1], end);
    for (const [index, [lower, upper]] of parts.entries()) {
      assert.ok(upper.getTime() - lower.getTime() <= 30 * DAY_MS);
      const next = parts[index + 1];
      if (next) assert.deepEqual(upper, next[0]);
    }
  });

  it("rejects empty, inverted and invalid ranges", () => {
    const at = new Date("2024-01-01T00:00:00Z");
    for (const range of [
      { from: at, to: at },
      { from: at, to: new Date(at.getTime() - 1) },
      { from: new Date(Number.NaN), to: at },
    ]) {
      assert.throws(() => {
        assertRange(range);
      }, DexcomRangeError);
    }
  });

  it("maps unknown trends to unknown", () => {
    assert.equal(toTrend("flat"), "flat");
    assert.equal(toTrend("sideways"), "unknown");
    assert.equal(toTrend(null), "unknown");
  });
});

describe("createDexcom", () => {
  it("creates the client for the requested source", () => {
    const v3 = createDexcom({
      source: "v3",
      clientId: "id",
      clientSecret: "secret",
      redirectUri: "http://localhost:8080/callback",
      region: "sandbox",
      tokens: memoryTokenStorage(),
    });
    const share = createDexcom({ source: "share", username: "user", password: "pw", region: "us" });
    assert.equal(v3.source, "v3");
    assert.equal(typeof v3.events, "function");
    assert.equal(share.source, "share");
    assert.equal(share.capabilities.realtime, true);
    assert.equal(v3.capabilities.historyMs, null);
  });
});
