import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

type Schema = typeof schema;
type Db = NodePgDatabase<Schema>;

let _pool: pg.Pool | undefined;
let _db: Db | undefined;

function readDatabaseUrl(): string {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    throw new Error(
      "DATABASE_URL must be set. Did you forget to provision a database?",
    );
  }
  return url;
}

export function getPool(): pg.Pool {
  if (!_pool) {
    _pool = new Pool({ connectionString: readDatabaseUrl() });
  }
  return _pool;
}

export function getDb(): Db {
  if (!_db) {
    _db = drizzle(getPool(), { schema });
  }
  return _db;
}

export async function closeDb(): Promise<void> {
  if (_pool) {
    const p = _pool;
    _pool = undefined;
    _db = undefined;
    await p.end();
  }
}

export * from "./schema";
