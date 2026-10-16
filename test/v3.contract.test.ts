/**
 * Contract tests for the generated v3 client, driven by the OpenAPI document.
 *
 * Every operation in spec/dexcom-v3.openapi.json needs an entry in OPERATIONS; the completeness
 * test fails when Dexcom adds or removes one. Requests and responses come from the generated
 * faker factories, so the tests follow the spec when it is regenerated.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, describe, it } from "node:test";
import { fakerEN } from "@faker-js/faker";
import { z } from "zod";
import { createClient, ResponseError } from "../src/generated/.kubb/client.ts";
import { ParseError } from "../src/generated/.kubb/standardSchema.ts";
import {
  getAlertsEventsV3,
  getCalibrationsV3,
  getDataRangeV3,
  getDevicesV3,
  getEstimatedGlucoseValuesV3,
  getEventsV3,
  postTokenV3,
} from "../src/generated/clients/index.ts";
import { createGetAlertsEventsV3Query, createGetAlertsEventsV3Status200 } from "../src/generated/mocks/createGetAlertsEventsV3.ts";
import { createGetCalibrationsV3Query, createGetCalibrationsV3Status200 } from "../src/generated/mocks/createGetCalibrationsV3.ts";
import { createGetDataRangeV3Query, createGetDataRangeV3Status200 } from "../src/generated/mocks/createGetDataRangeV3.ts";
import { createGetDevicesV3Status200 } from "../src/generated/mocks/createGetDevicesV3.ts";
import {
  createGetEstimatedGlucoseValuesV3Query,
  createGetEstimatedGlucoseValuesV3Status200,
} from "../src/generated/mocks/createGetEstimatedGlucoseValuesV3.ts";
import { createGetEventsV3Query, createGetEventsV3Status200 } from "../src/generated/mocks/createGetEventsV3.ts";
import { createPostTokenV3Body, createPostTokenV3Status200, createPostTokenV3Status400 } from "../src/generated/mocks/createPostTokenV3.ts";
import { getAlertsEventsV3ResponseSchema } from "../src/generated/zod/getAlertsEventsV3Schema.ts";
import { getCalibrationsV3ResponseSchema } from "../src/generated/zod/getCalibrationsV3Schema.ts";
import { getDataRangeV3ResponseSchema } from "../src/generated/zod/getDataRangeV3Schema.ts";
import { getDevicesV3ResponseSchema } from "../src/generated/zod/getDevicesV3Schema.ts";
import { getEstimatedGlucoseValuesV3ResponseSchema } from "../src/generated/zod/getEstimatedGlucoseValuesV3Schema.ts";
import { getEventsV3ResponseSchema } from "../src/generated/zod/getEventsV3Schema.ts";
import {
  getLoginV3QueryClientIdSchema,
  getLoginV3QueryRedirectUriSchema,
  getLoginV3QueryResponseTypeSchema,
  getLoginV3QueryScopeSchema,
  getLoginV3QueryStateSchema,
} from "../src/generated/zod/getLoginV3Schema.ts";
import { postTokenV3ErrorSchema, postTokenV3ResponseSchema } from "../src/generated/zod/postTokenV3Schema.ts";
import { createDexcomV3, memoryTokenStorage } from "../src/v3/index.ts";
import { jsonResponse, overTheWire, stubFetch } from "./support.ts";

const BASE_URL = "https://api.test.invalid";
const ACCESS_TOKEN = "test-access-token";
const SEED = 20_261_016;

// --- the OpenAPI document as the source of truth ---

const securitySchema = z.array(z.record(z.string(), z.array(z.string())));
const specSchema = z.looseObject({
  paths: z.record(z.string(), z.record(z.string(), z.unknown())),
  security: securitySchema.optional(),
});
const operationSchema = z.looseObject({ operationId: z.string(), security: securitySchema.optional() });
const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

interface SpecOperation {
  method: string;
  path: string;
  secured: boolean;
}

const SPEC = specSchema.parse(JSON.parse(readFileSync(new URL("../spec/dexcom-v3.openapi.json", import.meta.url), "utf8")));
const SPEC_OPERATIONS = new Map<string, SpecOperation>(
  Object.entries(SPEC.paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => HTTP_METHODS.has(method))
      .map(([method, raw]): [string, SpecOperation] => {
        const operation = operationSchema.parse(raw);
        const secured = (operation.security ?? SPEC.security ?? []).length > 0;
        return [operation.operationId, { method: method.toUpperCase(), path, secured }];
      }),
  ),
);

function specOperation(operationId: string): SpecOperation {
  const operation = SPEC_OPERATIONS.get(operationId);
  assert.ok(operation, `${operationId} is not in the spec`);
  return operation;
}

// --- one entry per operation ---

const client = () => createClient({ baseURL: BASE_URL, auth: () => ACCESS_TOKEN });
type Client = ReturnType<typeof client>;

interface OperationCase {
  /** Query parameters the case sends, from the generated factory. */
  query: Record<string, string>;
  /** Form fields the case sends, from the generated factory. */
  body?: Record<string, string>;
  /** A valid response, from the generated factory. */
  response: unknown;
  /** The generated response schema: the validated SDK result must equal its output. */
  schema: z.ZodType;
  call: (client: Client) => Promise<{ data: unknown }>;
  /** A body that violates the response schema. */
  invalid: unknown;
}

const stringRecord = z.record(z.string(), z.string());

function cases(): Record<string, OperationCase> {
  const egvsQuery = createGetEstimatedGlucoseValuesV3Query();
  const eventsQuery = createGetEventsV3Query();
  const calibrationsQuery = createGetCalibrationsV3Query();
  const alertsQuery = createGetAlertsEventsV3Query();
  const dataRangeQuery = createGetDataRangeV3Query();
  const tokenBody = createPostTokenV3Body();
  return {
    getEstimatedGlucoseValuesV3: {
      query: egvsQuery,
      response: createGetEstimatedGlucoseValuesV3Status200(),
      schema: getEstimatedGlucoseValuesV3ResponseSchema,
      call: (c) => getEstimatedGlucoseValuesV3({ client: c, query: egvsQuery }),
      invalid: { records: [{ recordId: 1 }] },
    },
    getEventsV3: {
      query: eventsQuery,
      response: createGetEventsV3Status200(),
      schema: getEventsV3ResponseSchema,
      call: (c) => getEventsV3({ client: c, query: eventsQuery }),
      invalid: { records: [{ eventType: "not an event type" }] },
    },
    getCalibrationsV3: {
      query: calibrationsQuery,
      response: createGetCalibrationsV3Status200(),
      schema: getCalibrationsV3ResponseSchema,
      call: (c) => getCalibrationsV3({ client: c, query: calibrationsQuery }),
      invalid: { records: [{ value: "high" }] },
    },
    getAlertsEventsV3: {
      query: alertsQuery,
      response: createGetAlertsEventsV3Status200(),
      schema: getAlertsEventsV3ResponseSchema,
      call: (c) => getAlertsEventsV3({ client: c, query: alertsQuery }),
      invalid: { records: "not an array" },
    },
    getDevicesV3: {
      query: {},
      response: createGetDevicesV3Status200(),
      schema: getDevicesV3ResponseSchema,
      call: (c) => getDevicesV3({ client: c }),
      invalid: { records: null },
    },
    getDataRangeV3: {
      query: stringRecord.parse(dataRangeQuery),
      response: createGetDataRangeV3Status200(),
      schema: getDataRangeV3ResponseSchema,
      call: (c) => getDataRangeV3({ client: c, query: dataRangeQuery }),
      invalid: { egvs: { start: { systemTime: "yesterday" } } },
    },
    postTokenV3: {
      query: {},
      body: stringRecord.parse(tokenBody ?? {}),
      response: createPostTokenV3Status200(),
      schema: postTokenV3ResponseSchema,
      call: (c) => postTokenV3({ client: c, body: tokenBody }),
      invalid: { access_token: 42 },
    },
  };
}

/** The login endpoint is a browser redirect, not an API call; covered by its own test. */
const BROWSER_OPERATIONS = ["getLoginV3"];

const sorted = (entries: Iterable<[string, string]>) => [...entries].toSorted(([a], [b]) => a.localeCompare(b));

describe("v3 contract", () => {
  beforeEach(() => {
    fakerEN.seed(SEED);
  });

  it("covers every operation of the OpenAPI document", () => {
    assert.deepEqual([...Object.keys(cases()), ...BROWSER_OPERATIONS].toSorted(), [...SPEC_OPERATIONS.keys()].toSorted());
  });

  for (const operationId of Object.keys(cases())) {
    describe(operationId, () => {
      it("sends the request the spec describes and returns the validated response", async (t) => {
        const operation = cases()[operationId];
        assert.ok(operation);
        const spec = specOperation(operationId);
        const requests = stubFetch(t, jsonResponse(operation.response));

        const { data } = await operation.call(client());

        const [request] = requests;
        assert.ok(request);
        const url = new URL(request.url);
        assert.equal(request.method, spec.method);
        assert.equal(`${url.origin}${url.pathname}`, `${BASE_URL}${spec.path}`);
        assert.deepEqual(sorted(url.searchParams), sorted(Object.entries(operation.query)));
        assert.equal(request.headers.get("Authorization"), spec.secured ? `Bearer ${ACCESS_TOKEN}` : null);
        if (operation.body) {
          assert.equal(request.headers.get("Content-Type"), "application/x-www-form-urlencoded");
          assert.deepEqual(sorted(new URLSearchParams(await request.text())), sorted(Object.entries(operation.body)));
        }
        assert.deepEqual(data, operation.schema.parse(overTheWire(operation.response)));
      });

      it("rejects a response that violates the schema", async (t) => {
        const operation = cases()[operationId];
        assert.ok(operation);
        stubFetch(t, jsonResponse(operation.invalid));
        await assert.rejects(operation.call(client()), ParseError);
      });

      it("raises the HTTP status of an error response", async (t) => {
        const operation = cases()[operationId];
        assert.ok(operation);
        stubFetch(t, jsonResponse({}, 503));
        await assert.rejects(operation.call(client()), (error) => error instanceof ResponseError && error.status === 503);
      });
    });
  }

  it("validates the documented 400 body of the token endpoint", async (t) => {
    const body = createPostTokenV3Status400();
    stubFetch(t, jsonResponse(body, 400));
    const result = await postTokenV3({ client: client(), body: { grant_type: "refresh_token" }, throwOnError: false });
    assert.equal(result.status, 400);
    assert.deepEqual(result.error, postTokenV3ErrorSchema.parse(body));
  });

  it("builds login URLs that satisfy the getLoginV3 contract", () => {
    const spec = specOperation("getLoginV3");
    const dexcom = createDexcomV3({
      clientId: "client",
      clientSecret: "secret",
      redirectUri: "http://localhost:8080/callback",
      region: "sandbox",
      tokens: memoryTokenStorage(),
    });
    const url = new URL(dexcom.authorizeUrl("state"));
    assert.equal(spec.method, "GET");
    assert.equal(url.pathname, spec.path);
    getLoginV3QueryClientIdSchema.parse(url.searchParams.get("client_id"));
    getLoginV3QueryRedirectUriSchema.parse(url.searchParams.get("redirect_uri"));
    getLoginV3QueryResponseTypeSchema.parse(url.searchParams.get("response_type"));
    getLoginV3QueryScopeSchema.parse(url.searchParams.get("scope"));
    getLoginV3QueryStateSchema.parse(url.searchParams.get("state"));
  });
});
