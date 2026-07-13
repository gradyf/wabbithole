import { neon, Pool } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-http';
import { drizzle as drizzleWs, type NeonDatabase } from 'drizzle-orm/neon-serverless';
import * as schema from './schema.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

export const db = drizzle({ client: neon(url), schema });

export type DbTx = Parameters<Parameters<NeonDatabase<typeof schema>['transaction']>[0]>[0];

/** Runs fn in a transaction that holds a per-user advisory lock, so a
 * cap check and the insert it authorizes can't interleave with another
 * request's. WebSocket driver: the HTTP driver can't hold a transaction. */
export async function withUserLock<T>(userId: string, fn: (tx: DbTx) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: url });
  try {
    const ws = drizzleWs({ client: pool, schema });
    return await ws.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 42))`);
      return fn(tx);
    });
  } finally {
    await pool.end();
  }
}

// Distinct salt from withUserLock's 42 so a string namespace key and a user id
// can never collide in the shared advisory-lock keyspace. [C13]
const KEY_LOCK_SALT = 8731;

/** Runs fn in a transaction holding an advisory lock keyed by an arbitrary
 * STRING (not a user id) — used by ad-hoc generation, where the key is
 * `adhoc:<articleId>:<selectionHash>` so concurrent identical highlights
 * serialize into a SINGLE paid call (the fn re-checks the cache under the lock
 * and only the first misser generates). Same WebSocket-driver requirement as
 * withUserLock. The salt is distinct from withUserLock's, so the two lock
 * families share the 64-bit advisory keyspace without a cross-family collision.
 * A benign extra serialization on an astronomically unlikely hash collision is
 * acceptable (the plan's [C13] note). */
export async function withKeyLock<T>(key: string, fn: (tx: DbTx) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: url });
  try {
    const ws = drizzleWs({ client: pool, schema });
    return await ws.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, ${KEY_LOCK_SALT}))`);
      return fn(tx);
    });
  } finally {
    await pool.end();
  }
}
