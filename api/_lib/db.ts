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
