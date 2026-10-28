// Operator password reset (there is no email service): sets a new password for an account and
// signs it out everywhere. Run on the server with access to its database:
//
//   DATABASE_PATH=./data/pairloom.sqlite node --import tsx scripts/reset-password.ts user@example.com
//
// The new password is read from stdin (never from the command line, where it would be kept in
// shell history and visible in the process list).
import { createInterface } from "node:readline";
import { AuthService } from "../apps/server/src/auth.js";
import { loadConfig } from "../apps/server/src/config.js";
import { openDb } from "../apps/server/src/db.js";

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error("Usage: node --import tsx scripts/reset-password.ts <email>   (password on stdin)");
  process.exit(2);
}
const config = loadConfig();
const rl = createInterface({ input: process.stdin });
const password = await new Promise<string>((resolve) => {
  process.stderr.write("New password (10+ characters): ");
  rl.once("line", (l) => {
    rl.close();
    resolve(l.trim());
  });
});
if (password.length < 10) {
  console.error("Password must be at least 10 characters.");
  process.exit(1);
}
const ok = await new AuthService(openDb(config.databasePath), config).resetPassword(
  email,
  password,
);
console.error(
  ok
    ? `Password reset for ${email}; all its sessions were signed out.`
    : `No account for ${email}.`,
);
process.exit(ok ? 0 : 1);
