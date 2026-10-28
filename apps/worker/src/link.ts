import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import {
  type SessionEventType,
  ServerToWorker,
  WORKER_PROTOCOL_VERSION,
  type WorkerEvent,
} from "@pairloom/shared";
import type { z } from "zod";

type Hello = {
  workerVersion: string;
  adapters: unknown[];
  liveSessions: unknown[];
};
type CommandFrame = Extract<z.infer<typeof ServerToWorker>, { t: "command" }>;

interface PersistedState {
  outbox: WorkerEvent[];
  /** command id -> outcome, so a lost ack is re-sent with the original result. */
  processed: Record<string, { ok: boolean; error?: string }>;
}

const MAX_OUTBOX = 5000;
const MAX_PROCESSED = 2000;

/**
 * Outbound connection to the collaboration server with an at-least-once event
 * outbox and idempotent command handling, both persisted to disk so a worker
 * restart does not lose unacknowledged activity.
 */
export class ServerLink {
  private socket: WebSocket | null = null;
  private state: PersistedState;
  private statePath: string;
  private backoffMs = 1000;
  private stopped = false;
  private heartbeat: NodeJS.Timeout | null = null;
  private lastPong = Date.now();
  connected = false;
  onConnectionChange: (connected: boolean) => void = () => {};

  constructor(
    private url: string,
    private token: string,
    stateDir: string,
    private hello: () => Hello,
    private onCommand: (frame: CommandFrame) => Promise<void>,
    private log: (msg: string) => void = (m) => console.log(m),
  ) {
    mkdirSync(stateDir, { recursive: true });
    this.statePath = join(stateDir, "link-state.json");
    this.state = existsSync(this.statePath)
      ? (JSON.parse(readFileSync(this.statePath, "utf8")) as PersistedState)
      : { outbox: [], processed: {} };
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  async stop() {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    const s = this.socket;
    if (s && s.readyState === WebSocket.OPEN) {
      await new Promise<void>((res) => {
        s.once("close", () => res());
        s.close();
      });
    }
  }

  get outboxSize() {
    return this.state.outbox.length;
  }

  emit(sessionId: string, type: SessionEventType, payload: Record<string, unknown>) {
    const ev: WorkerEvent = { t: "event", id: randomUUID(), sessionId, type, payload };
    this.state.outbox.push(ev);
    if (this.state.outbox.length > MAX_OUTBOX) {
      this.state.outbox.splice(0, this.state.outbox.length - MAX_OUTBOX);
    }
    this.persist();
    if (this.connected) this.write(ev);
  }

  private persist() {
    const keys = Object.keys(this.state.processed);
    if (keys.length > MAX_PROCESSED) {
      for (const k of keys.slice(0, keys.length - MAX_PROCESSED)) delete this.state.processed[k];
    }
    const tmp = `${this.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state));
    renameSync(tmp, this.statePath);
  }

  private write(frame: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
  }

  private connect() {
    const wsUrl = this.url.replace(/^http/, "ws").replace(/\/$/, "") + "/ws/worker";
    const socket = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${this.token}` } });
    this.socket = socket;

    socket.on("open", () => {
      this.write({ t: "hello", protocol: WORKER_PROTOCOL_VERSION, ...this.hello() });
    });

    socket.on("message", (raw) => {
      let frame: z.infer<typeof ServerToWorker>;
      try {
        frame = ServerToWorker.parse(JSON.parse(raw.toString()));
      } catch {
        this.log("ignoring malformed server frame");
        return;
      }
      switch (frame.t) {
        case "welcome":
          this.connected = true;
          this.backoffMs = 1000;
          this.lastPong = Date.now();
          this.log(`connected to server as ${frame.workerId}`);
          this.onConnectionChange(true);
          for (const ev of this.state.outbox) this.write(ev);
          this.startHeartbeat();
          return;
        case "ack": {
          const before = this.state.outbox.length;
          this.state.outbox = this.state.outbox.filter((e) => e.id !== frame.id);
          if (this.state.outbox.length !== before) this.persist();
          return;
        }
        case "command":
          void this.handleCommand(frame);
          return;
        case "pong":
          this.lastPong = Date.now();
          return;
        case "error":
          this.log(`server error: ${frame.message}`);
          return;
      }
    });

    socket.on("close", (code, reason) => {
      const wasConnected = this.connected;
      this.connected = false;
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (wasConnected) this.onConnectionChange(false);
      if (code === 4001) {
        this.log(`server rejected worker token (${reason.toString()}); not reconnecting`);
        return;
      }
      if (this.stopped) return;
      this.log(`disconnected (${code}); reconnecting in ${this.backoffMs}ms`);
      setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    });

    socket.on("error", (err) => this.log(`socket error: ${err.message}`));
  }

  private startHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastPong > 45_000) {
        this.log("heartbeat timeout; reconnecting");
        this.socket?.terminate();
        return;
      }
      this.write({ t: "ping" });
    }, 15_000);
  }

  private async handleCommand(frame: CommandFrame) {
    const prior = this.state.processed[frame.id];
    if (prior) {
      this.write({ t: "command_ack", id: frame.id, ...prior });
      return;
    }
    let outcome: { ok: boolean; error?: string };
    try {
      await this.onCommand(frame);
      outcome = { ok: true };
    } catch (err) {
      outcome = { ok: false, error: (err as Error).message.slice(0, 2000) };
    }
    this.state.processed[frame.id] = outcome;
    this.persist();
    this.write({ t: "command_ack", id: frame.id, ...outcome });
  }
}
