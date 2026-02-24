/**
 * Discrete-event simulation engine.
 *
 * Priority queue backed by a sorted array (sufficient for simulation sizes).
 * Deterministic: no randomness, events processed in strict time order.
 */

import type {
  Event,
  SimMetrics,
  AgentId,
  ConversationState,
  AgentState,
  SimConfig,
  EmitLagSample,
} from "./types.js";

export class EventQueue {
  private events: Event[] = [];

  push(event: Event): void {
    // Binary insertion to maintain sorted order (ascending time).
    let lo = 0;
    let hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.events[mid].time <= event.time) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    this.events.splice(lo, 0, event);
  }

  pop(): Event | undefined {
    return this.events.shift();
  }

  get size(): number {
    return this.events.length;
  }

  /** Remove all pending events for a given agent of a given type. */
  removeFor(agent: AgentId, type: Event["type"]): number {
    const before = this.events.length;
    this.events = this.events.filter((e) => !(e.agent === agent && e.type === type));
    return before - this.events.length;
  }

  /** Remove pending events matching predicate. */
  removeWhere(predicate: (e: Event) => boolean): number {
    const before = this.events.length;
    this.events = this.events.filter((e) => !predicate(e));
    return before - this.events.length;
  }

  peek(): Event | undefined {
    return this.events[0];
  }
}

export function createConversationState(config: SimConfig): ConversationState {
  const agents = new Map<AgentId, AgentState>();
  for (const [id, duration] of Object.entries(config.agents)) {
    agents.set(id, {
      id,
      runDuration: duration,
      busy: false,
      followupQueue: [],
      runsCompleted: 0,
      emitCount: 0,
      droppedCount: 0,
      inCooldown: false,
      generation: 0,
    });
  }
  return {
    agents,
    concurrencyCap: config.concurrencyCap,
    activeRuns: 0,
    pendingRuns: [],
  };
}

export function collectMetrics(state: ConversationState, time: number): SimMetrics {
  let totalEmits = 0;
  let totalRuns = 0;
  const pendingByAgent: Record<string, number> = {};
  const queueDepthByAgent: Record<string, number> = {};
  const droppedByAgent: Record<string, number> = {};

  for (const [id, agent] of state.agents) {
    totalEmits += agent.emitCount;
    totalRuns += agent.runsCompleted;
    queueDepthByAgent[id] = agent.followupQueue.length;
    droppedByAgent[id] = agent.droppedCount;
  }

  // Count pending runs per agent.
  for (const pending of state.pendingRuns) {
    pendingByAgent[pending.agent] = (pendingByAgent[pending.agent] ?? 0) + 1;
  }

  return {
    time,
    totalEmits,
    totalRuns,
    pendingRuns: state.pendingRuns.length,
    pendingByAgent,
    queueDepthByAgent,
    droppedByAgent,
    activeRuns: state.activeRuns,
    meanLagByAgent: {},
    maxLagByAgent: {},
  };
}

/**
 * Compute lag metrics for a sample tick from accumulated lag samples.
 * Uses samples in the window [prevTime, time] for "current window" stats.
 * Falls back to all samples up to `time` for cumulative averages.
 */
export function computeLagMetrics(
  samples: EmitLagSample[],
  time: number,
  prevTime: number,
  agentIds: string[],
): { meanLagByAgent: Record<string, number>; maxLagByAgent: Record<string, number> } {
  const meanLagByAgent: Record<string, number> = {};
  const maxLagByAgent: Record<string, number> = {};

  for (const agentId of agentIds) {
    // Window samples: emits in (prevTime, time].
    const windowSamples = samples.filter(
      (s) => s.agent === agentId && s.emitTime > prevTime && s.emitTime <= time,
    );
    if (windowSamples.length === 0) {
      // No emits this window — report cumulative last known lag.
      const allPrior = samples.filter((s) => s.agent === agentId && s.emitTime <= time);
      if (allPrior.length > 0) {
        const last = allPrior[allPrior.length - 1];
        meanLagByAgent[agentId] = last.lag;
        maxLagByAgent[agentId] = last.lag;
      }
      continue;
    }
    const lags = windowSamples.map((s) => s.lag);
    meanLagByAgent[agentId] =
      Math.round((lags.reduce((a, b) => a + b, 0) / lags.length) * 100) / 100;
    maxLagByAgent[agentId] = Math.max(...lags);
  }

  return { meanLagByAgent, maxLagByAgent };
}

/**
 * Apply drop policy to a followup queue.
 * Returns true if the new item should be enqueued.
 */
export function applyDropPolicy(
  agent: AgentState,
  cap: number,
  policy: SimConfig["dropPolicy"],
): boolean {
  if (cap <= 0 || agent.followupQueue.length < cap) {
    return true;
  }
  if (policy === "new") {
    agent.droppedCount++;
    return false;
  }
  // "old" or "summarize": drop oldest
  agent.followupQueue.shift();
  agent.droppedCount++;
  return true;
}
