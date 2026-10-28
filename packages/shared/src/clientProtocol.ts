import { z } from "zod";
import type { AgentSessionDTO, SessionEvent, WorkerDTO } from "./domain.js";

/** Browser <-> server realtime protocol. Authenticated by the session cookie at upgrade. */
export const ClientToServer = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("subscribe_session"),
    sessionId: z.string().max(64),
    /** Replay events with seq > afterSeq, then stream live. */
    afterSeq: z.number().int().min(0),
  }),
  z.object({ t: z.literal("subscribe_project"), projectId: z.string().max(64) }),
  z.object({ t: z.literal("unsubscribe_session"), sessionId: z.string().max(64) }),
  z.object({ t: z.literal("ping") }),
]);
export type ClientToServer = z.infer<typeof ClientToServer>;

export type ServerToClient =
  | { t: "event"; event: SessionEvent }
  | { t: "session"; session: AgentSessionDTO }
  | { t: "worker"; worker: WorkerDTO }
  | { t: "subscribed"; sessionId?: string; projectId?: string }
  | { t: "error"; message: string; code?: string }
  | { t: "pong" };
