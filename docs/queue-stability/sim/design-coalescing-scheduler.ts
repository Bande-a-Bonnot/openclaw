/**
 * Design B: Conversation-scoped Coalescing Scheduler
 *
 * Core idea: replace the multi-layer queue with a single conversation-scoped
 * scheduler that maintains at most one pending run per agent and coalesces
 * across all layers.
 *
 * Properties:
 * - Single scheduling point for the entire conversation
 * - Pending run table: agent → { messages[], scheduledAt }
 * - When a message arrives for agent X:
 *   - If X has no pending entry and is not running: create entry, schedule drain
 *   - If X has a pending entry: append message to entry (coalesce)
 *   - If X is running: append to entry (will drain when run completes)
 * - Drain: pick highest-priority agent with pending entry, start run
 * - No separate followup queue or command lane — one unified structure
 *
 * This eliminates both the idle race and the cross-layer coalescing gap
 * by removing the layer separation entirely.
 */

import { EventQueue, computeLagMetrics } from "./sim-engine.js";
import type {
  Event,
  SimConfig,
  SimResult,
  SimMetrics,
  AgentId,
  QueuedMessage,
  EmitLagSample,
} from "./types.js";

type SchedulerEntry = {
  agent: AgentId;
  messages: QueuedMessage[];
  scheduledAt: number;
};

type CoalescingAgentState = {
  id: AgentId;
  runDuration: number;
  busy: boolean;
  inCooldown: boolean;
  runsCompleted: number;
  emitCount: number;
  droppedCount: number;
  generation: number;
};

export function simulateCoalescingScheduler(config: SimConfig): SimResult {
  const eq = new EventQueue();
  const eventLog: Event[] = [];
  const metrics: SimMetrics[] = [];
  const lagSamples: EmitLagSample[] = [];
  const agentIds = Object.keys(config.agents);

  // Per-agent: earliest message arrival consumed by current run.
  const runTriggerTime = new Map<AgentId, number>();
  const runCoalescedCount = new Map<AgentId, number>();

  // Agent states (no separate followupQueue — scheduler handles it).
  const agents = new Map<AgentId, CoalescingAgentState>();
  for (const [id, duration] of Object.entries(config.agents)) {
    agents.set(id, {
      id,
      runDuration: duration,
      busy: false,
      inCooldown: false,
      runsCompleted: 0,
      emitCount: 0,
      droppedCount: 0,
      generation: 0,
    });
  }

  // The unified scheduler: at most one entry per agent.
  const scheduler = new Map<AgentId, SchedulerEntry>();
  let activeRuns = 0;

  // Seed.
  for (const id of agentIds) {
    eq.push({ time: 0, type: "message_arrive", agent: id, payload: "human_seed" });
  }

  for (let t = config.sampleInterval; t <= config.horizon; t += config.sampleInterval) {
    eq.push({ time: t, type: "tick", agent: "_metrics" });
  }

  function handleMessageArrive(agentId: AgentId, time: number, event: Event): void {
    const agent = agents.get(agentId)!;
    eventLog.push({ time, type: "message_arrive", agent: agentId });

    const msg: QueuedMessage = {
      from: event.agent,
      prompt: event.payload ?? "",
      enqueuedAt: time,
    };

    const existing = scheduler.get(agentId);
    if (existing) {
      // Coalesce: append to existing entry.
      if (existing.messages.length >= config.queueCap) {
        // Drop oldest.
        existing.messages.shift();
        agent.droppedCount++;
      }
      existing.messages.push(msg);
      eventLog.push({ time, type: "coalesce", agent: agentId });
      return;
    }

    // No existing entry — create one.
    scheduler.set(agentId, {
      agent: agentId,
      messages: [msg],
      scheduledAt: time,
    });

    // Try to start immediately if possible.
    if (!agent.busy && !agent.inCooldown) {
      tryDrainScheduler(time);
    }
  }

  function tryDrainScheduler(time: number): void {
    while (activeRuns < config.concurrencyCap && scheduler.size > 0) {
      // Pick first available agent (FIFO by scheduledAt).
      let bestEntry: SchedulerEntry | undefined;
      for (const entry of scheduler.values()) {
        const agent = agents.get(entry.agent)!;
        if (agent.busy || agent.inCooldown) {
          continue;
        }
        if (!bestEntry || entry.scheduledAt < bestEntry.scheduledAt) {
          bestEntry = entry;
        }
      }
      if (!bestEntry) {
        break;
      }
      startRun(bestEntry, time);
    }
  }

  function startRun(entry: SchedulerEntry, time: number): void {
    const agent = agents.get(entry.agent)!;
    agent.busy = true;
    agent.generation++;
    activeRuns++;

    const coalescedCount = entry.messages.length;
    const earliestEnqueued =
      coalescedCount > 0 ? Math.min(...entry.messages.map((m) => m.enqueuedAt)) : time;
    // Remove entry from scheduler — messages are consumed.
    scheduler.delete(entry.agent);

    runTriggerTime.set(entry.agent, earliestEnqueued);
    runCoalescedCount.set(entry.agent, coalescedCount);

    eq.push({
      time: time + agent.runDuration,
      type: "run_end",
      agent: agent.id,
      generation: agent.generation,
    });
    eventLog.push({
      time,
      type: "run_start",
      agent: agent.id,
      payload: `coalesced_${coalescedCount}`,
    });
  }

  function completeRun(agentId: AgentId, time: number, generation: number): void {
    const agent = agents.get(agentId)!;
    if (generation !== agent.generation) {
      return;
    }
    agent.busy = false;
    activeRuns--;
    agent.runsCompleted++;
    eventLog.push({ time, type: "run_end", agent: agentId });

    // Emit.
    const maxRounds = config.maxEmitRounds;
    if (config.emitToAllPeers && (maxRounds <= 0 || agent.emitCount < maxRounds)) {
      emitToPeers(agent, time);
    }

    if (config.postEmitHold > 0) {
      agent.inCooldown = true;
      eq.push({
        time: time + config.postEmitHold,
        type: "cooldown_end",
        agent: agentId,
        generation: agent.generation,
      });
    } else {
      // If messages arrived during run, they're already in the scheduler.
      tryDrainScheduler(time + config.debounceMs);
    }
  }

  function emitToPeers(agent: CoalescingAgentState, time: number): void {
    agent.emitCount++;

    // Record lag sample.
    const trigger = runTriggerTime.get(agent.id) ?? time;
    const coalesced = runCoalescedCount.get(agent.id) ?? 1;
    lagSamples.push({
      agent: agent.id,
      emitTime: time,
      earliestMessageTime: trigger,
      lag: time - trigger,
      coalescedCount: coalesced,
    });
    runTriggerTime.delete(agent.id);
    runCoalescedCount.delete(agent.id);

    const peers = agentIds.filter((id) => id !== agent.id);
    for (const peerId of peers) {
      eq.push({
        time: time + config.deliveryDelay,
        type: "message_arrive",
        agent: peerId,
        payload: `emit_from_${agent.id}`,
      });
    }
    eventLog.push({ time, type: "emit", agent: agent.id });
  }

  function gatherMetrics(time: number): SimMetrics {
    let totalEmits = 0;
    let totalRuns = 0;
    const pendingByAgent: Record<string, number> = {};
    const queueDepthByAgent: Record<string, number> = {};
    const droppedByAgent: Record<string, number> = {};

    for (const [id, agent] of agents) {
      totalEmits += agent.emitCount;
      totalRuns += agent.runsCompleted;
      const entry = scheduler.get(id);
      queueDepthByAgent[id] = entry?.messages.length ?? 0;
      droppedByAgent[id] = agent.droppedCount;
      if (entry) {
        pendingByAgent[id] = 1; // At most 1 pending entry per agent.
      }
    }

    return {
      time,
      totalEmits,
      totalRuns,
      pendingRuns: scheduler.size,
      pendingByAgent,
      queueDepthByAgent,
      droppedByAgent,
      activeRuns,
      meanLagByAgent: {},
      maxLagByAgent: {},
    };
  }

  // Main loop.
  let prevTickTime = 0;
  let safetyCounter = 0;
  const MAX_EVENTS = 100_000;

  while (eq.size > 0 && safetyCounter < MAX_EVENTS) {
    const event = eq.pop()!;
    if (event.time > config.horizon) {
      break;
    }
    safetyCounter++;

    switch (event.type) {
      case "tick": {
        const m = gatherMetrics(event.time);
        const lag = computeLagMetrics(lagSamples, event.time, prevTickTime, agentIds);
        m.meanLagByAgent = lag.meanLagByAgent;
        m.maxLagByAgent = lag.maxLagByAgent;
        metrics.push(m);
        prevTickTime = event.time;
        break;
      }
      case "message_arrive": {
        handleMessageArrive(event.agent, event.time, event);
        break;
      }
      case "run_end": {
        if (event.generation !== undefined) {
          completeRun(event.agent, event.time, event.generation);
        }
        break;
      }
      case "cooldown_end": {
        const agent = agents.get(event.agent);
        if (agent) {
          agent.inCooldown = false;
          tryDrainScheduler(event.time + config.debounceMs);
        }
        break;
      }
    }
  }

  const finalMetrics = gatherMetrics(config.horizon);
  const finalLag = computeLagMetrics(lagSamples, config.horizon, prevTickTime, agentIds);
  finalMetrics.meanLagByAgent = finalLag.meanLagByAgent;
  finalMetrics.maxLagByAgent = finalLag.maxLagByAgent;
  metrics.push(finalMetrics);

  return {
    config,
    designName: "coalescing-scheduler",
    metrics,
    finalMetrics,
    eventLog,
    lagSamples,
  };
}
