import { sha256Hex } from "../../src/auth.js";
import { createTestEnv } from "./env.js";

export const RPC_STASH = "rpc-fixture";
export const RPC_FOREIGN_STASH = "rpc-foreign";
export const RPC_WRITE_TOKEN = `zhs_${"W".repeat(43)}`;
export const RPC_READ_TOKEN = `zhs_${"R".repeat(43)}`;
export const RPC_FOREIGN_TOKEN = `zhs_${"F".repeat(43)}`;
export const RPC_WRITE_TOKEN_ID = `tok_${"a".repeat(32)}`;
export const RPC_READ_TOKEN_ID = `tok_${"b".repeat(32)}`;
export const RPC_FOREIGN_TOKEN_ID = `tok_${"c".repeat(32)}`;
export const RPC_FIXED_NOW = 1_700_100_000_000;

const STASHES = [
  ["alpha", "first page fixture", RPC_FIXED_NOW - 40],
  [RPC_FOREIGN_STASH, "foreign credential fixture", RPC_FIXED_NOW - 30],
  [RPC_STASH, "RPC parity fixture", RPC_FIXED_NOW - 20],
  ["zeta", "last page fixture", RPC_FIXED_NOW - 10],
] as const;

const TOKENS = [
  [RPC_WRITE_TOKEN_ID, RPC_STASH, RPC_WRITE_TOKEN, "write", "fixed writer", RPC_FIXED_NOW - 3],
  [RPC_READ_TOKEN_ID, RPC_STASH, RPC_READ_TOKEN, "read", "fixed reader", RPC_FIXED_NOW - 2],
  [
    RPC_FOREIGN_TOKEN_ID,
    RPC_FOREIGN_STASH,
    RPC_FOREIGN_TOKEN,
    "read",
    "fixed foreign reader",
    RPC_FIXED_NOW - 1,
  ],
] as const;

export async function seedRpcFixture(): Promise<void> {
  const db = createTestEnv().env.DB;
  for (const [name, description, createdAt] of STASHES) {
    await db
      .prepare(
        "INSERT INTO stashes (name, description, meta_json, created_at) VALUES (?, ?, '{}', ?)",
      )
      .bind(name, description, createdAt)
      .run();
  }
  for (const [id, stash, token, scope, label, createdAt] of TOKENS) {
    await db
      .prepare(
        `INSERT INTO tokens
           (id, stash_name, token_hash, label, scope, created_at, revoked_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .bind(id, stash, await sha256Hex(token), label, scope, createdAt)
      .run();
  }
}
