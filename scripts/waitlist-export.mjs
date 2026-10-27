// Prints the early-access waitlist as CSV (email,role,created_at). Server-side only: it reads the
// database directly and is never exposed over HTTP.
//
//   node scripts/waitlist-export.mjs [path/to/pairloom.sqlite] > waitlist.csv
//   DATABASE_PATH=... node scripts/waitlist-export.mjs
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = resolve(new URL("..", import.meta.url).pathname);
const path = resolve(root, process.argv[2] ?? process.env.DATABASE_PATH ?? "data/pairloom.sqlite");
if (!existsSync(path)) {
  console.error(`No database at ${path}`);
  process.exit(1);
}
const db = new DatabaseSync(path, { readOnly: true });
const csv = (v) =>
  v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v);
console.log("email,role,created_at");
for (const r of db
  .prepare("SELECT email, role, created_at FROM waitlist ORDER BY created_at")
  .all())
  console.log([r.email, r.role, r.created_at].map(csv).join(","));
db.close();
