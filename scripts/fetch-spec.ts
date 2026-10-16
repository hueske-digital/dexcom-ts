/**
 * Downloads the official Dexcom API v3 OpenAPI document into spec/ and checks it against the
 * pinned SHA-256 in spec/dexcom-v3.openapi.sha256. The document belongs to Dexcom and is not
 * committed; the pin makes every build use exactly the reviewed version.
 *
 * The generator reads spec/dexcom-v3.structure.json instead: the same document without
 * Dexcom's prose (descriptions, summaries, examples), so the published package carries the
 * API's structure only, not Dexcom's documentation text.
 *
 *   pnpm spec            download if missing, verify the pin
 *   pnpm spec --update   download, then pin the new hash (review the generated diff afterwards)
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const SPEC_URL = "https://developer.dexcom.com/docs/_bundle/swaggerV3.json?download";
const SPEC_FILE = new URL("../spec/dexcom-v3.openapi.json", import.meta.url);
const STRUCTURE_FILE = new URL("../spec/dexcom-v3.structure.json", import.meta.url);
const HASH_FILE = new URL("../spec/dexcom-v3.openapi.sha256", import.meta.url);
/** Keys that hold documentation text or sample data rather than API structure. */
const PROSE_KEYS = new Set(["description", "summary", "example", "examples", "externalDocs", "termsOfService", "contact"]);
const TIMEOUT_MS = 30_000;

const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

async function download(): Promise<Uint8Array> {
  const response = await fetch(SPEC_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`spec download failed: HTTP ${String(response.status)}`);
  const data = new Uint8Array(await response.arrayBuffer());
  // Reject an HTML error page or an unrelated document before it reaches the generator.
  const parsed: unknown = JSON.parse(new TextDecoder().decode(data));
  if (typeof parsed !== "object" || parsed === null || !("openapi" in parsed) || !("paths" in parsed)) {
    throw new Error("downloaded file is not an OpenAPI document");
  }
  return data;
}

/**
 * Drops prose keys everywhere except where they name something: the keys of `properties`
 * (a field may be called "description") and of `responses`/`paths` maps.
 */
function stripProse(value: unknown, parentKey = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => stripProse(item));
  if (typeof value !== "object" || value === null) return value;
  const namesOnly = parentKey === "properties";
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => namesOnly || !PROSE_KEYS.has(key))
      .map(([key, child]) => [key, stripProse(child, key)]),
  );
}

function writeStructure(data: Uint8Array): void {
  const document: unknown = JSON.parse(new TextDecoder().decode(data));
  writeFileSync(STRUCTURE_FILE, `${JSON.stringify(stripProse(document), null, 2)}\n`);
}

const { values } = parseArgs({ options: { update: { type: "boolean", default: false } } });

if (values.update) {
  const data = await download();
  writeFileSync(SPEC_FILE, data);
  writeFileSync(HASH_FILE, `${sha256(data)}\n`);
  writeStructure(data);
  console.log(`spec updated and pinned: ${sha256(data)}`);
} else {
  const pinned = readFileSync(HASH_FILE, "utf8").trim();
  const data = existsSync(SPEC_FILE) ? readFileSync(SPEC_FILE) : await download();
  const actual = sha256(data);
  if (actual !== pinned) {
    throw new Error(
      `spec hash mismatch: pinned ${pinned}, got ${actual}. Dexcom changed the document; run \`pnpm spec --update\` and review.`,
    );
  }
  writeFileSync(SPEC_FILE, data);
  writeStructure(data);
  console.log(`spec verified: ${actual}`);
}
