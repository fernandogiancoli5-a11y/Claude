// Netlify Function: POST /api/waitlist (logic in ../lib/waitlist.ts).
import { handleWaitlist } from "../lib/waitlist.js";

export default async (req: Request, context: { ip?: string }) =>
  handleWaitlist(req, {
    env: process.env,
    fetch,
    clientIp: context.ip,
    log: (m) => console.log(m),
  });

export const config = { path: "/api/waitlist" };
