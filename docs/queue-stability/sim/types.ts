/**
 * Shared types for queue stability simulations.
 *
 * Discrete-event simulation framework for modelling OpenClaw's
 * multi-agent queue architecture and proposed alternatives.
 */

export type AgentId = string;

export type Event = {
  time: number;
  type: EventType;
  agent: AgentId;
  /** Optional target agent (for peer messages). */
  target?: AgentId;
  /** Payload text/identifier. */
  payload?: string;
  /** Generation counter for stale-event detection. */
  generation?: number;
};

export type EventType =
  | "message_arrive" // External message arrives at agent
  | "run_start" // Agent run begins
  | "run_end" // Agent run completes
  | "emit" // Agent emits reply to peers
  | "enqueue_followup" // Message enters followup queue
  | "drain_followup" // Followup queue drain triggers
  | "enqueue_lane" // Run enqueued in command lane
  | "lane_start" // Command lane starts executing run
  | "cooldown_end" // Post-emit cooldown expires
  | "coalesce" // Mailbox/token coalescing event
  | "tick"; // Clock tick for metrics

export type AgentState = {
  id: AgentId;
  /** Fixed run duration for deterministic simulation. */
  runDuration: number;
  /** Is agent currently executing a run? */
  busy: boolean;
  /** Per-agent followup queue (messages waiting while busy). */
  followupQueue: QueuedMessage[];
  /** Number of runs completed. */
  runsCompleted: number;
  /** Number of messages emitted. */
  emitCount: number;
  /** Number of items dropped from followup queue. */
  droppedCount: number;
  /** Is agent in cooldown after emit? */
  inCooldown: boolean;
  /** Current run generation (for stale detection). */
  generation: number;
};

export type QueuedMessage = {
  from: AgentId;
  prompt: string;
  enqueuedAt: number;
};

export type ConversationState = {
  agents: Map<AgentId, AgentState>;
  /** Max concurrent runs across conversation. */
  concurrencyCap: number;
  /** Currently active run count. */
  activeRuns: number;
  /** Pending run requests in outer scheduler. */
  pendingRuns: PendingRun[];
};

export type PendingRun = {
  agent: AgentId;
  enqueuedAt: number;
  /** Coalesced message count. */
  coalescedCount: number;
};

export type SimConfig = {
  /** Agent definitions: id -> run duration. */
  agents: Record<string, number>;
  /** Conversation concurrency cap. */
  concurrencyCap: number;
  /** Queue mode: collect | steer. */
  queueMode: "collect" | "steer";
  /** Per-agent busy queue cap. */
  queueCap: number;
  /** Drop policy. */
  dropPolicy: "old" | "new" | "summarize";
  /** Delivery delay: time for emitted message to reach peer. */
  deliveryDelay: number;
  /** Post-emit hold duration. */
  postEmitHold: number;
  /** Debounce interval for queue drain. */
  debounceMs: number;
  /** Simulation horizon (max time). */
  horizon: number;
  /** Metrics sampling interval. */
  sampleInterval: number;
  /** Whether agents emit to all peers after each run. */
  emitToAllPeers: boolean;
  /** Max emit rounds (0 = unlimited). */
  maxEmitRounds: number;
};

/**
 * A single lag sample: one agent's emit event with timing.
 * "Event-horizon lag" = time from earliest triggering message arrival
 * to the moment the agent emits its reply.
 */
export type EmitLagSample = {
  agent: AgentId;
  emitTime: number;
  /** Arrival time of the earliest message consumed by this run. */
  earliestMessageTime: number;
  /** lag = emitTime - earliestMessageTime */
  lag: number;
  /** How many messages were coalesced into this run. */
  coalescedCount: number;
};

export type SimMetrics = {
  time: number;
  totalEmits: number;
  totalRuns: number;
  pendingRuns: number;
  pendingByAgent: Record<string, number>;
  queueDepthByAgent: Record<string, number>;
  droppedByAgent: Record<string, number>;
  activeRuns: number;
  /** Mean event-horizon lag per agent at this sample tick. */
  meanLagByAgent: Record<string, number>;
  /** Max event-horizon lag per agent at this sample tick. */
  maxLagByAgent: Record<string, number>;
};

export type SimResult = {
  config: SimConfig;
  designName: string;
  metrics: SimMetrics[];
  finalMetrics: SimMetrics;
  eventLog: Event[];
  /** All emit lag samples, ordered by emitTime. */
  lagSamples: EmitLagSample[];
};

export const DEFAULT_CONFIG: SimConfig = {
  agents: { A: 4, B: 5, C: 6 },
  concurrencyCap: 2,
  queueMode: "collect",
  queueCap: 20,
  dropPolicy: "old",
  deliveryDelay: 1,
  postEmitHold: 0,
  debounceMs: 1,
  horizon: 120,
  sampleInterval: 10,
  emitToAllPeers: true,
  maxEmitRounds: 0,
};
