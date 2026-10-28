// Netlify Scheduled Function: one small Supabase query a day. This lowers the chance that a
// quiet free project is paused for inactivity; it does not guarantee it (see docs/DEPLOY_FREE.md).
import { keepAlive } from "../lib/waitlist.js";

export default async () => {
  await keepAlive({ env: process.env, fetch });
  console.log("keepalive: ok");
};

export const config = { schedule: "@daily" };
