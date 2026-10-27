import { useEffect, useRef, useState } from "react";
import type { ServerToClient } from "@pairloom/shared";

type Listener = (msg: ServerToClient) => void;

/**
 * Single shared socket with automatic reconnect. Subscriptions are replayed on
 * reconnect, and session subscriptions resume from the last seq the caller saw,
 * so a dropped connection never loses or duplicates events.
 */
class Realtime {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private sessionSubs = new Map<string, () => number>();
  private projectSubs = new Set<string>();
  private backoff = 500;
  private statusListeners = new Set<(online: boolean) => void>();
  online = false;

  connect() {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const s = new WebSocket(`${proto}://${location.host}/ws`);
    this.socket = s;
    s.onopen = () => {
      this.backoff = 500;
      this.setOnline(true);
      for (const [id, lastSeq] of this.sessionSubs)
        this.send({ t: "subscribe_session", sessionId: id, afterSeq: lastSeq() });
      for (const id of this.projectSubs) this.send({ t: "subscribe_project", projectId: id });
    };
    s.onmessage = (e) => {
      const msg = JSON.parse(e.data) as ServerToClient;
      for (const l of this.listeners) l(msg);
    };
    s.onclose = (e) => {
      this.setOnline(false);
      if (e.code === 4001) {
        window.dispatchEvent(new Event("pl:unauthenticated"));
        return;
      }
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 15000);
    };
  }

  private setOnline(v: boolean) {
    this.online = v;
    for (const l of this.statusListeners) l(v);
  }

  onStatus(l: (online: boolean) => void) {
    this.statusListeners.add(l);
    return () => this.statusListeners.delete(l);
  }

  private send(msg: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
  }

  on(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  subscribeSession(sessionId: string, lastSeq: () => number) {
    this.connect();
    this.sessionSubs.set(sessionId, lastSeq);
    this.send({ t: "subscribe_session", sessionId, afterSeq: lastSeq() });
    return () => {
      this.sessionSubs.delete(sessionId);
      this.send({ t: "unsubscribe_session", sessionId });
    };
  }

  subscribeProject(projectId: string) {
    this.connect();
    this.projectSubs.add(projectId);
    this.send({ t: "subscribe_project", projectId });
    return () => {
      this.projectSubs.delete(projectId);
    };
  }
}

export const realtime = new Realtime();

export function useRealtime(listener: Listener, deps: unknown[]) {
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => {
    const off = realtime.on((m) => ref.current(m));
    return () => {
      off();
    };
  }, deps);
}

export function useRealtimeOnline() {
  const [online, setOnline] = useState(realtime.online);
  useEffect(() => {
    realtime.connect();
    const off = realtime.onStatus(setOnline);
    return () => {
      off();
    };
  }, []);
  return online;
}
