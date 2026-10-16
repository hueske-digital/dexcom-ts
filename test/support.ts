import type { TestContext } from "node:test";

/**
 * JSON response for a fake server. int64 fields are bigint in the generated types and mocks;
 * JSON carries them as numbers, the way Dexcom sends them.
 */
export function jsonResponse(body: unknown, status = 200): Response {
  const text = JSON.stringify(body, (_key, value: unknown) => (typeof value === "bigint" ? Number(value) : value));
  return new Response(text, { status, headers: { "Content-Type": "application/json" } });
}

/** What a JSON body looks like after a round trip over the wire (bigint becomes number). */
export function overTheWire(body: unknown): unknown {
  return JSON.parse(JSON.stringify(body, (_key, value: unknown) => (typeof value === "bigint" ? Number(value) : value)));
}

export type Responder = (request: Request) => Response | Promise<Response>;

/**
 * Replaces the global fetch for one test (restored automatically) and records every request.
 * Each responder answers one request, in order; a request beyond the queue fails the test.
 */
export function stubFetch(t: TestContext, ...responders: (Response | Responder)[]): Request[] {
  const requests: Request[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    requests.push(request.clone());
    const next = responders.shift();
    if (next === undefined) throw new Error(`unexpected request: ${request.method} ${request.url}`);
    return typeof next === "function" ? next(request) : next;
  });
  return requests;
}
