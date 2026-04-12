import postgres from "postgres";
import { getConfig } from "./config.js";

let _sql;

export function getSql() {
  if (!_sql) {
    const { databaseUrl } = getConfig();
    _sql = postgres(databaseUrl, { max: 15 });
  }
  return _sql;
}

export async function closeDb() {
  if (_sql) {
    await _sql.end({ timeout: 5 });
    _sql = null;
  }
}
