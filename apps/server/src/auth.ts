import type { FastifyReply, FastifyRequest } from "fastify";
import type { ServerConfig } from "./config.js";
import { HttpError, type UserRow } from "./core.js";
import { type Db, nowIso } from "./db.js";
import { hashPassword, newId, newSecret, sha256, verifyPassword } from "./crypto.js";

export const SESSION_COOKIE = "pl_session";

export class AuthService {
  constructor(
    private db: Db,
    private config: ServerConfig,
  ) {}

  async signup(email: string, password: string, displayName: string): Promise<UserRow> {
    const existing = this.db.prepare("SELECT 1 FROM users WHERE email = ?").get(email);
    if (existing) throw new HttpError(409, "An account with this email already exists");
    const id = newId("usr");
    this.db
      .prepare(
        "INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?,?,?,?,?)",
      )
      .run(id, email, displayName, await hashPassword(password), nowIso());
    return { id, email, display_name: displayName };
  }

  async login(email: string, password: string): Promise<UserRow> {
    const row = this.db
      .prepare("SELECT id, email, display_name, password_hash FROM users WHERE email = ?")
      .get(email) as (UserRow & { password_hash: string }) | undefined;
    // Same error for unknown email and wrong password.
    if (!row || !(await verifyPassword(password, row.password_hash))) {
      throw new HttpError(401, "Invalid email or password");
    }
    return { id: row.id, email: row.email, display_name: row.display_name };
  }

  /**
   * Changes a password after re-checking the current one, and signs out every other session
   * (the caller keeps `keepToken`). There is no email service, so this plus the operator reset
   * (scripts/reset-password.ts) is the supported recovery path.
   */
  async changePassword(userId: string, current: string, next: string, keepToken?: string) {
    const row = this.db.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId) as
      { password_hash: string } | undefined;
    if (!row || !(await verifyPassword(current, row.password_hash))) {
      throw new HttpError(403, "Your current password is incorrect");
    }
    this.db
      .prepare("UPDATE users SET password_hash = ? WHERE id = ?")
      .run(await hashPassword(next), userId);
    this.db
      .prepare("DELETE FROM auth_sessions WHERE user_id = ? AND token_hash != ?")
      .run(userId, keepToken ? sha256(keepToken) : "");
  }

  /** Operator reset: sets a new password and signs the account out everywhere. */
  async resetPassword(email: string, next: string): Promise<boolean> {
    const row = this.db.prepare("SELECT id FROM users WHERE email = ?").get(email) as
      { id: string } | undefined;
    if (!row) return false;
    this.db
      .prepare("UPDATE users SET password_hash = ? WHERE id = ?")
      .run(await hashPassword(next), row.id);
    this.db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(row.id);
    return true;
  }

  createSession(userId: string): { token: string; expiresAt: Date } {
    const token = newSecret(32);
    const expiresAt = new Date(Date.now() + this.config.sessionTtlHours * 3600_000);
    this.db
      .prepare(
        "INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)",
      )
      .run(sha256(token), userId, nowIso(), expiresAt.toISOString());
    return { token, expiresAt };
  }

  /** Resolves a cookie token to a user; expired sessions are deleted and rejected. */
  userForToken(token: string | undefined): UserRow | null {
    if (!token) return null;
    const row = this.db
      .prepare(
        `SELECT u.id, u.email, u.display_name, s.expires_at FROM auth_sessions s
         JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
      )
      .get(sha256(token)) as (UserRow & { expires_at: string }) | undefined;
    if (!row) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) {
      this.revoke(token);
      return null;
    }
    return { id: row.id, email: row.email, display_name: row.display_name };
  }

  revoke(token: string) {
    this.db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(sha256(token));
  }

  setCookie(reply: FastifyReply, token: string, expiresAt: Date) {
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: this.config.secureCookies,
      path: "/",
      expires: expiresAt,
    });
  }

  requireUser(req: FastifyRequest): UserRow {
    const user = this.userForToken(req.cookies[SESSION_COOKIE]);
    if (!user) throw new HttpError(401, "Not signed in", "unauthenticated");
    return user;
  }
}
