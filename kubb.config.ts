import { parserTs } from "@kubb/parser-ts";
import { pluginFaker } from "@kubb/plugin-faker";
import { pluginFetch } from "@kubb/plugin-fetch";
import { pluginTs } from "@kubb/plugin-ts";
import { pluginZod } from "@kubb/plugin-zod";
import { defineConfig } from "kubb/config";

const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;

export default defineConfig({
  // Written by `pnpm spec` (scripts/fetch-spec.ts): the pinned Dexcom document without its prose.
  input: "./spec/dexcom-v3.structure.json",
  output: { path: "./src/generated", clean: true },
  // Node ESM needs fully specified imports; `tsc` rewrites them to .js on build.
  parsers: [parserTs({ extension: { ".ts": ".ts" } })],
  plugins: [
    pluginTs(),
    pluginZod({
      printer: {
        nodes: {
          // systemTime comes without offset (UTC), displayTime with one, and some records carry
          // minute precision only (e.g. "2026-05-23T06:45Z", seen in the sandbox): accept all of them.
          datetime: () =>
            "z.union([z.iso.datetime({ offset: true, local: true }), z.iso.datetime({ offset: true, local: true, precision: -1 })])",
        },
      },
    }),
    pluginFetch({ validator: "zod" }),
    pluginFaker({
      seed: 20_261_016,
      printer: {
        nodes: {
          // The faker printer ignores `format: int32`; keep fake values inside the range z.int32() accepts.
          integer(node) {
            if (node.format !== "int32") return this.base(node);
            return `faker.number.int({ min: ${String(node.min ?? INT32_MIN)}, max: ${String(node.max ?? INT32_MAX)} })`;
          },
        },
      },
    }),
  ],
});
