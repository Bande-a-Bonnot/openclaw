import type { OpenClawConfig } from "./types.js";

export const DEFAULT_AGENT_MAX_CONCURRENT = 4;
export const DEFAULT_SUBAGENT_MAX_CONCURRENT = 8;
// Keep depth-1 subagents as leaves unless config explicitly opts into nesting.
export const DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH = 1;
export const DEFAULT_AGENT_MAX_CONCURRENT_PER_CONVERSATION = 1;
export const DEFAULT_CONVERSATION_LANE_DRAIN_DELAY_MS = 0;

export function resolveAgentMaxConcurrent(cfg?: OpenClawConfig): number {
  const raw = cfg?.agents?.defaults?.maxConcurrent;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.floor(raw));
  }
  return DEFAULT_AGENT_MAX_CONCURRENT;
}

/** Hard ceiling matching the zod schema `.max(10)` — enforced at runtime too. */
export const MAX_CONCURRENT_PER_CONVERSATION = 10;

export function resolveAgentMaxConcurrentPerConversation(cfg?: OpenClawConfig): number {
  const raw = cfg?.agents?.defaults?.maxConcurrentPerConversation;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.min(MAX_CONCURRENT_PER_CONVERSATION, Math.max(1, Math.floor(raw)));
  }
  return DEFAULT_AGENT_MAX_CONCURRENT_PER_CONVERSATION;
}

export function resolveSubagentMaxConcurrent(cfg?: OpenClawConfig): number {
  const raw = cfg?.agents?.defaults?.subagents?.maxConcurrent;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.floor(raw));
  }
  return DEFAULT_SUBAGENT_MAX_CONCURRENT;
}

// ---------------------------------------------------------------------------
// Per-channel conversation concurrency override
// ---------------------------------------------------------------------------

/** Strip delivery-target prefixes (channel:, group:, user:, thread:) to get bare config lookup ID. */
function stripPeerPrefix(peerId: string | undefined): string | undefined {
  if (!peerId) {
    return undefined;
  }
  const idx = peerId.indexOf(":");
  return idx >= 0 ? peerId.slice(idx + 1) : peerId;
}

/** Return value as a positive integer, or undefined if invalid/missing. */
function asPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return undefined;
  }
  return Math.min(MAX_CONCURRENT_PER_CONVERSATION, Math.floor(value));
}

/** Return value as a non-negative integer, or undefined if invalid/missing. */
function asNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

// ---------------------------------------------------------------------------
// Generic per-channel config cascade resolver
// ---------------------------------------------------------------------------

type CascadeParams = {
  cfg?: OpenClawConfig;
  channel?: string;
  groupSpace?: string | null;
  peerId?: string;
};

/**
 * Resolve a numeric config field using the established channel config cascade:
 *
 *   Discord:  channel → guild → provider → global
 *   Telegram: group → provider → global
 *   Slack:    channel → provider → global
 *   Others:   provider → global
 */
function resolvePerChannelValue(
  params: CascadeParams,
  field: string,
  validate: (v: unknown) => number | undefined,
  globalDefault: number,
): number {
  const channelKey = params.channel?.toLowerCase();
  if (!channelKey) {
    return globalDefault;
  }

  // Safety: the `as` cast is unavoidable here because ChannelsConfig uses
  // `[key: string]: any` for extension providers, and the typed providers
  // (discord, telegram, slack) pass through nested objects whose shape varies.
  // The `validate` callback performs full runtime type-checking (typeof + isFinite
  // + bounds), so an incorrect field type will return `undefined` and fall through
  // to the next cascade level rather than producing a bad value.
  const get = (obj: unknown): number | undefined =>
    validate((obj as Record<string, unknown> | undefined)?.[field]);

  if (channelKey === "discord") {
    const config = params.cfg?.channels?.discord;
    const guild = params.groupSpace ? config?.guilds?.[params.groupSpace] : undefined;
    const channelId = stripPeerPrefix(params.peerId);
    const channel = channelId ? guild?.channels?.[channelId] : undefined;
    return get(channel) ?? get(guild) ?? get(config) ?? globalDefault;
  }

  if (channelKey === "telegram") {
    const config = params.cfg?.channels?.telegram;
    // groupSpace is NOT populated for Telegram; extract group ID from peerId
    const groupId = stripPeerPrefix(params.groupSpace ?? params.peerId);
    const group = groupId ? config?.groups?.[groupId] : undefined;
    return get(group) ?? get(config) ?? globalDefault;
  }

  if (channelKey === "slack") {
    const config = params.cfg?.channels?.slack;
    const channelId = stripPeerPrefix(params.peerId);
    const channel = channelId ? config?.channels?.[channelId] : undefined;
    return get(channel) ?? get(config) ?? globalDefault;
  }

  // Flat providers: provider-level only via dynamic key
  return get(params.cfg?.channels?.[channelKey]) ?? globalDefault;
}

export function resolveMaxConcurrentPerConversation(params: CascadeParams): number {
  return resolvePerChannelValue(
    params,
    "maxConcurrentPerConversation",
    asPositiveInt,
    resolveAgentMaxConcurrentPerConversation(params.cfg),
  );
}

// ---------------------------------------------------------------------------
// Per-channel conversation lane drain delay override
// ---------------------------------------------------------------------------

function resolveAgentConversationLaneDrainDelay(cfg?: OpenClawConfig): number {
  const raw = cfg?.agents?.defaults?.conversationLaneDrainDelayMs;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  return DEFAULT_CONVERSATION_LANE_DRAIN_DELAY_MS;
}

export function resolveConversationLaneDrainDelay(params: CascadeParams): number {
  return resolvePerChannelValue(
    params,
    "conversationLaneDrainDelayMs",
    asNonNegativeInt,
    resolveAgentConversationLaneDrainDelay(params.cfg),
  );
}
