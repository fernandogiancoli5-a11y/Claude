import type { WebSocket } from "ws";
import {
  type AgentSessionDTO,
  ClientToServer,
  type ServerToClient,
  type SessionEvent,
  type WorkerDTO,
  WorkerToServer,
} from "@pairloom/shared";
import { type Core, HttpError, type Notifier } from "./core.js";

interface ClientConn {
  socket: WebSocket;
  userId: string;
  sessions: Map<string, string>; // sessionId -> workspaceId
  projects: Map<string, string>; // projectId -> workspaceId
}

/**
 * Realtime fan-out. Every outbound frame to a browser re-checks membership, so a
 * removed member stops receiving data even if they kept a socket open.
 */
export class Hub implements Notifier {
  private clients = new Set<ClientConn>();
  private workers = new Map<string, WebSocket>();
  private alive = new WeakMap<WebSocket, boolean>();
  private heartbeat: NodeJS.Timeout;

  /**
   * Server-side liveness: every socket must answer a WebSocket ping within one
   * interval, or it is terminated. Without this a worker that vanished without
   * closing its TCP connection (VM died, network partition) would look online
   * and its sessions would look like they are still running.
   */
  constructor(
    private core: Core,
    heartbeatMs = 20_000,
  ) {
    this.heartbeat = setInterval(() => this.sweep(), heartbeatMs);
    this.heartbeat.unref();
  }

  private track(socket: WebSocket) {
    this.alive.set(socket, true);
    socket.on("pong", () => this.alive.set(socket, true));
  }

  private sweep() {
    const sockets = [...[...this.clients].map((c) => c.socket), ...this.workers.values()];
    for (const s of sockets) {
      if (this.alive.get(s) === false) {
        s.terminate(); // triggers "close" -> normal disconnect handling
        continue;
      }
      this.alive.set(s, false);
      try {
        s.ping();
      } catch {}
    }
  }

  // ------------------------------------------------------------ browsers

  attachClient(socket: WebSocket, userId: string) {
    const conn: ClientConn = { socket, userId, sessions: new Map(), projects: new Map() };
    this.clients.add(conn);
    this.track(socket);
    socket.on("message", (raw) => this.onClientMessage(conn, raw.toString()));
    socket.on("close", () => this.clients.delete(conn));
  }

  private send(conn: ClientConn, frame: ServerToClient) {
    if (conn.socket.readyState === conn.socket.OPEN) conn.socket.send(JSON.stringify(frame));
  }

  private onClientMessage(conn: ClientConn, raw: string) {
    let msg: ClientToServer;
    try {
      msg = ClientToServer.parse(JSON.parse(raw));
    } catch {
      return this.send(conn, { t: "error", message: "Malformed message" });
    }
    try {
      switch (msg.t) {
        case "ping":
          return this.send(conn, { t: "pong" });
        case "subscribe_session": {
          const { session } = this.core.requireSession(conn.userId, msg.sessionId, "viewer");
          // Register first, then replay synchronously: no event can slip between.
          conn.sessions.set(session.id, session.workspace_id);
          let after = msg.afterSeq;
          for (;;) {
            const batch = this.core.eventsAfter(session.id, after, 500);
            for (const event of batch) this.send(conn, { t: "event", event });
            if (batch.length < 500) break;
            after = batch[batch.length - 1]!.seq;
          }
          this.send(conn, { t: "session", session: this.core.sessionDto(session) });
          return this.send(conn, { t: "subscribed", sessionId: session.id });
        }
        case "unsubscribe_session":
          conn.sessions.delete(msg.sessionId);
          return;
        case "subscribe_project": {
          const project = this.core.getProject(conn.userId, msg.projectId);
          conn.projects.set(project.id, project.workspaceId);
          return this.send(conn, { t: "subscribed", projectId: project.id });
        }
      }
    } catch (err) {
      const message = err instanceof HttpError ? err.message : "Internal error";
      this.send(conn, { t: "error", message });
    }
  }

  private stillMember(conn: ClientConn, workspaceId: string) {
    return this.core.roleOf(conn.userId, workspaceId) !== null;
  }

  sessionEvent(workspaceId: string, event: SessionEvent) {
    for (const c of this.clients) {
      if (c.sessions.has(event.sessionId) && this.stillMember(c, workspaceId)) {
        this.send(c, { t: "event", event });
      }
    }
  }

  sessionUpdated(workspaceId: string, session: AgentSessionDTO) {
    for (const c of this.clients) {
      if (
        (c.sessions.has(session.id) || c.projects.has(session.projectId)) &&
        this.stillMember(c, workspaceId)
      ) {
        this.send(c, { t: "session", session });
      }
    }
  }

  workerUpdated(workspaceId: string, worker: WorkerDTO) {
    for (const c of this.clients) {
      if (c.projects.has(worker.projectId) && this.stillMember(c, workspaceId)) {
        this.send(c, { t: "worker", worker });
      }
    }
  }

  membershipRevoked(workspaceId: string, userId: string) {
    for (const c of this.clients) {
      if (c.userId !== userId) continue;
      for (const [sid, ws] of c.sessions) if (ws === workspaceId) c.sessions.delete(sid);
      for (const [pid, ws] of c.projects) if (ws === workspaceId) c.projects.delete(pid);
      this.send(c, {
        t: "error",
        message: "Your access to a workspace was removed",
        code: "revoked",
      });
    }
  }

  // ------------------------------------------------------------- workers

  isWorkerOnline(workerId: string) {
    const s = this.workers.get(workerId);
    return Boolean(s && s.readyState === s.OPEN);
  }

  sendToWorker(workerId: string, frame: unknown): boolean {
    const s = this.workers.get(workerId);
    if (!s || s.readyState !== s.OPEN) return false;
    s.send(JSON.stringify(frame));
    return true;
  }

  attachWorker(socket: WebSocket, workerId: string, projectId: string) {
    const previous = this.workers.get(workerId);
    if (previous && previous !== socket) previous.close(4000, "Replaced by a newer connection");
    this.track(socket);
    let helloDone = false;

    socket.on("message", (raw) => {
      let msg: WorkerToServer;
      try {
        msg = WorkerToServer.parse(JSON.parse(raw.toString()));
      } catch (err) {
        socket.send(
          JSON.stringify({ t: "error", message: `Malformed frame: ${String(err).slice(0, 300)}` }),
        );
        return;
      }
      try {
        if (msg.t === "hello") {
          // Register before reconciling so status broadcasts report the worker online.
          this.workers.set(workerId, socket);
          helloDone = true;
          socket.send(JSON.stringify({ t: "welcome", workerId, projectId }));
          const pending = this.core.onWorkerHello(workerId, msg.adapters, msg.liveSessions);
          for (const cmd of pending) socket.send(JSON.stringify(cmd));
          return;
        }
        if (!helloDone) {
          socket.send(JSON.stringify({ t: "error", message: "Send hello first" }));
          return;
        }
        switch (msg.t) {
          case "ping":
            socket.send(JSON.stringify({ t: "pong" }));
            return;
          case "event":
            this.core.ingestWorkerEvent(workerId, msg);
            // Ack duplicates too, so the worker can clear its outbox.
            socket.send(JSON.stringify({ t: "ack", id: msg.id }));
            return;
          case "command_ack":
            this.core.onCommandAck(workerId, msg.id, msg.ok, msg.error);
            return;
        }
      } catch (err) {
        const message = err instanceof HttpError ? err.message : "Internal error";
        if (msg.t === "event") {
          // Permanently invalid events are acked so they do not loop forever.
          socket.send(JSON.stringify({ t: "ack", id: msg.id, rejected: message }));
        }
        socket.send(JSON.stringify({ t: "error", message }));
      }
    });

    socket.on("close", () => {
      if (this.workers.get(workerId) === socket) {
        this.workers.delete(workerId);
        this.core.onWorkerDisconnected(workerId);
      }
    });
  }

  closeAll() {
    clearInterval(this.heartbeat);
    for (const c of this.clients) c.socket.close();
    for (const w of this.workers.values()) w.close();
  }
}
