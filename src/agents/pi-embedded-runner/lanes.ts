import {
  resolveConversationLaneDrainDelay,
  resolveMaxConcurrentPerConversation,
} from "../../config/agent-limits.js";
import type { OpenClawConfig } from "../../config/types.js";
import {
  enqueueCommandInLane,
  setCommandLaneConcurrency,
  setCommandLaneDrainDelay,
} from "../../process/command-queue.js";
import { CommandLane, CONV_LANE_PREFIX } from "../../process/lanes.js";

export function resolveSessionLane(key: string) {
  const cleaned = key.trim() || CommandLane.Main;
  return cleaned.startsWith("session:") ? cleaned : `session:${cleaned}`;
}

export function resolveGlobalLane(lane?: string) {
  const cleaned = lane?.trim();
  return cleaned ? cleaned : CommandLane.Main;
}

export function resolveEmbeddedSessionLane(key: string) {
  return resolveSessionLane(key);
}

export function resolveConversationLane(params: {
  channel?: string;
  accountId?: string;
  peerId?: string;
}): string {
  const channel = (params.channel ?? "").trim().toLowerCase();
  const accountId = (params.accountId ?? "").trim().toLowerCase() || "default";
  const peerId = (params.peerId ?? "").trim().toLowerCase();
  if (!channel && !peerId) {
    return "";
  }
  return `${CONV_LANE_PREFIX}${channel || "unknown"}:${accountId}:${peerId || "unknown"}`;
}

export function parseConversationPartsFromSessionKey(sessionKey?: string): {
  channel: string;
  peerId: string;
} {
  const raw = (sessionKey ?? "").trim().toLowerCase();
  if (!raw) {
    return { channel: "", peerId: "" };
  }
  const parts = raw.split(":");
  if (parts[0] !== "agent" || parts.length < 5) {
    return { channel: "", peerId: "" };
  }
  return { channel: parts[2] ?? "", peerId: parts[4] ?? "" };
}

/**
 * Resolve the conversation lane for an agent invocation, configure its
 * concurrency and drain delay, and return an enqueue function.
 * Returns a passthrough when no conversation lane applies.
 */
export function setupConversationLane(params: {
  cfg?: OpenClawConfig;
  channel?: string;
  accountId?: string;
  peerId?: string;
  groupSpace?: string | null;
}): <T>(task: () => Promise<T>) => Promise<T> {
  const convLane = resolveConversationLane({
    channel: params.channel,
    accountId: params.accountId,
    peerId: params.peerId,
  });
  if (!convLane) {
    return <T>(task: () => Promise<T>) => task();
  }
  setCommandLaneConcurrency(
    convLane,
    resolveMaxConcurrentPerConversation({
      cfg: params.cfg,
      channel: params.channel,
      groupSpace: params.groupSpace,
      peerId: params.peerId,
    }),
  );
  setCommandLaneDrainDelay(
    convLane,
    resolveConversationLaneDrainDelay({
      cfg: params.cfg,
      channel: params.channel,
      groupSpace: params.groupSpace,
      peerId: params.peerId,
    }),
  );
  return <T>(task: () => Promise<T>) => enqueueCommandInLane(convLane, task);
}
