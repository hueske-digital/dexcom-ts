/**
 * One entry point for both Dexcom data sources:
 *
 * - `source: "v3"`: the official Dexcom API v3 (OAuth, full history, delayed by 1–3 h)
 * - `source: "share"`: the unofficial Dexcom Share service (account login, near real time, last 24 h)
 *
 * Both return a client with `getReadings` and `getLatestReading`; the v3 client adds the other
 * record types. Import from `dexcom-ts/v3` or `dexcom-ts/share` to use one source only.
 */
import { createDexcomShare, type DexcomShare, type DexcomShareOptions } from "./share/client.ts";
import { createDexcomV3, type DexcomV3, type DexcomV3Options } from "./v3/client.ts";

export type CreateDexcomOptions = ({ source: "v3" } & DexcomV3Options) | ({ source: "share" } & DexcomShareOptions);

export function createDexcom(options: { source: "v3" } & DexcomV3Options): DexcomV3;
export function createDexcom(options: { source: "share" } & DexcomShareOptions): DexcomShare;
export function createDexcom(options: CreateDexcomOptions): DexcomV3 | DexcomShare {
  return options.source === "v3" ? createDexcomV3(options) : createDexcomShare(options);
}

export * from "./share/index.ts";
export * from "./v3/index.ts";
