import { randomBytes } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { z } from "zod";
import { DexcomAuthError } from "../errors.ts";

/** OAuth tokens of one Dexcom user. Refresh tokens are single-use and valid for up to a year. */
export interface StoredToken {
  accessToken: string;
  refreshToken: string;
  /** Access token expiry, epoch milliseconds. */
  expiresAt: number;
}

/**
 * Where a client keeps its tokens. Implement it for a database or secrets store.
 * `load` and `save` must not call a Dexcom client that uses the same storage; such a call is rejected.
 */
export interface TokenStorage {
  load(): Promise<StoredToken | null>;
  save(token: StoredToken): Promise<void>;
}

const storedTokenSchema = z.object({ accessToken: z.string(), refreshToken: z.string(), expiresAt: z.number() });

/** Keeps tokens in memory only; they are lost when the process ends. */
export function memoryTokenStorage(initial: StoredToken | null = null): TokenStorage {
  let current = initial;
  return {
    load: () => Promise.resolve(current),
    save: (token) => {
      current = token;
      return Promise.resolve();
    },
  };
}

/**
 * Keeps tokens in a JSON file created with mode 0600 and replaced atomically, so a crash never
 * leaves a half-written refresh token behind. Keep the file outside any git checkout.
 * It does not lock across processes: let one process at a time use a token file.
 */
export function fileTokenStorage(path: string): TokenStorage {
  return {
    load: async () => {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      }
      const parsed = storedTokenSchema.safeParse(JSON.parse(text));
      if (!parsed.success) throw new DexcomAuthError(`token file ${path} is invalid; sign in again`);
      return parsed.data;
    },
    save: async (token) => {
      // A unique temp file per save, so overlapping saves never touch each other's file.
      const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
      const file = await open(tmp, "wx", 0o600);
      try {
        try {
          await file.writeFile(JSON.stringify(token));
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(tmp, path);
      } catch (error) {
        await rm(tmp, { force: true });
        throw error;
      }
    },
  };
}
