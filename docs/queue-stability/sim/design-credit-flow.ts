/**
 * Design C: Credit-based Flow Control (Token Bucket)
 *
 * Core idea: each agent gets a fixed number of reply "credits" per time window.
 * When credits are exhausted, all messages are buffered until credits refill.
 * This caps the total output rate globally.
 *
 * Properties:
 * - Each agent starts with N credits (e.g., 3)
 * - Emitting a reply costs 1 credit
 * - Credits refill at a fixed rate (e.g., 1 credit per refillInterval)
 * - When credits = 0: messages buffer, no new runs start
 * - When credits refill: drain buffered messages (coalesced)
 * - Conversation-level credit pool (optional): shared credit cap
 *
 * This is a rate-limiting approach that bounds total system output
 * regardless of topology. It doesn't fix the idle race per se but
 * makes its impact bounded by the credit budget.
 *
 * Trade-off: adds latency to legitimate replies. Simpler to reason
 * about but less responsive than mailbox approach.
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

type CreditConfig = SimConfig & {
  /** Credits per agent per window. */
  creditsPerAgent: number;
  /** Credit refill interval (simulation time units). */
  creditRefillInterval: number;
  /** Optional conversation-level credit pool. */
  conversationCreditPool: number;
};

type CreditAgentState = {
  id: AgentId;
  runDuration: number;
  busy: boolean;
  inCooldown: boolean;
  credits: number;
  maxCredits: number;
  runsCompleted: number;
  emitCount: number;
  droppedCount: number;
  generation: number;
  buffer: QueuedMessage[];
};

export function simulateCreditFlow(
  config: SimConfig,
  creditConfig?: Partial<CreditConfig>,
): SimResult {
  const creditsPerAgent = creditConfig?.creditsPerAgent ?? 3;
  const creditRefillInterval = creditConfig?.creditRefillInterval ?? 10;
  const conversationCreditPool = creditConfig?.conversationCreditPool ?? 0;

  const eq = new EventQueue();
  const eventLog: Event[] = [];
  const metrics: SimMetrics[] = [];
  const lagSamples: EmitLagSample[] = [];
  const agentIds = Object.keys(config.agents);

  // Per-agent: earliest message arrival consumed by current run.
  const runTriggerTime = new Map<AgentId, number>();
  const runCoalescedCount = new Map<AgentId, number>();

  const agents = new Map<AgentId, CreditAgentState>();
  for (const [id, duration] of Object.entries(config.agents)) {
    agents.set(id, {
      id,
      runDuration: duration,
      busy: false,
      inCooldown: false,
      credits: creditsPerAgent,
      maxCredits: creditsPerAgent,
      runsCompleted: 0,
      emitCount: 0,
      droppedCount: 0,
      generation: 0,
      buffer: [],
    });
  }

  let conversationCredits = conversationCreditPool > 0 ? conversationCreditPool : Infinity;
  let activeRuns = 0;
  const pendingRuns: { agent: AgentId; enqueuedAt: number; coalescedCount: number }[] = [];

  // Seed.
  for (const id of agentIds) {
    eq.push({ time: 0, type: "message_arrive", agent: id, payload: "human_seed" });
  }

  // Metric ticks.
  for (let t = config.sampleInterval; t <= config.horizon; t += config.sampleInterval) {
    eq.push({ time: t, type: "tick", agent: "_metrics" });
  }

  // Credit refill ticks.
  for (let t = creditRefillInterval; t <= config.horizon; t += creditRefillInterval) {
    eq.push({ time: t, type: "cooldown_end", agent: "_credit_refill" });
  }

  function hasCredits(agent: CreditAgentState): boolean {
    return agent.credits > 0 && conversationCredits > 0;
  }

  function consumeCredit(agent: CreditAgentState): void {
    agent.credits = Math.max(0, agent.credits - 1);
    if (conversationCreditPool > 0) {
      conversationCredits = Math.max(0, conversationCredits - 1);
    }
  }

  function refillCredits(time: number): void {
    for (const agent of agents.values()) {
      agent.credits = Math.min(agent.maxCredits, agent.credits + 1);
    }
    if (conversationCreditPool > 0) {
      conversationCredits = Math.min(conversationCreditPool, conversationCredits + agentIds.length);
    }
    // After refill, try to drain any buffered messages.
    for (const agent of agents.values()) {
      if (agent.buffer.length > 0 && !agent.busy && !agent.inCooldown && hasCredits(agent)) {
        tryStartRun(agent, time);
      }
    }
  }

  function handleMessageArrive(agentId: AgentId, time: number, event: Event): void {
    const agent = agents.get(agentId)!;
    eventLog.push({ time, type: "message_arrive", agent: agentId });

    const msg: QueuedMessage = {
      from: event.agent,
      prompt: event.payload ?? "",
      enqueuedAt: time,
    };

    // Always buffer first.
    if (agent.buffer.length >= config.queueCap) {
      agent.buffer.shift();
      agent.droppedCount++;
    }
    agent.buffer.push(msg);

    if (!agent.busy && !agent.inCooldown && hasCredits(agent)) {
      tryStartRun(agent, time);
    }
  }

  function tryStartRun(agent: CreditAgentState, time: number): void {
    if (agent.busy || agent.inCooldown || !hasCredits(agent)) {
      return;
    }
    if (agent.buffer.length === 0) {
      return;
    }
    if (activeRuns >= config.concurrencyCap) {
      // Add to pending, but coalesce if already present.
      const existing = pendingRuns.find((p) => p.agent === agent.id);
      if (existing) {
        existing.coalescedCount++;
      } else {
        pendingRuns.push({ agent: agent.id, enqueuedAt: time, coalescedCount: 1 });
      }
      return;
    }
    startRun(agent, time);
  }

  function startRun(agent: CreditAgentState, time: number): void {
    agent.busy = true;
    agent.generation++;
    activeRuns++;

    // Drain entire buffer into this run.
    const coalescedCount = agent.buffer.length;
    const earliestEnqueued =
      coalescedCount > 0 ? Math.min(...agent.buffer.map((m) => m.enqueuedAt)) : time;
    agent.buffer.length = 0;

    runTriggerTime.set(agent.id, earliestEnqueued);
    runCoalescedCount.set(agent.id, coalescedCount);

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

    // Emit costs a credit.
    const maxRounds = config.maxEmitRounds;
    if (config.emitToAllPeers && (maxRounds <= 0 || agent.emitCount < maxRounds)) {
      if (hasCredits(agent)) {
        consumeCredit(agent);
        emitToPeers(agent, time);
      }
      // If no credits, the emit is suppressed (backpressure).
    }

    if (config.postEmitHold > 0) {
      agent.inCooldown = true;
      eq.push({
        time: time + config.postEmitHold,
        type: "cooldown_end",
        agent: agentId,
        generation: agent.generation,
      });
    } else if (agent.buffer.length > 0 && hasCredits(agent)) {
      tryStartRun(agent, time + config.debounceMs);
    }

    tryDrainPendingRuns(time);
  }

  function emitToPeers(agent: CreditAgentState, time: number): void {
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

  function tryDrainPendingRuns(time: number): void {
    while (activeRuns < config.concurrencyCap && pendingRuns.length > 0) {
      const next = pendingRuns.shift()!;
      const agent = agents.get(next.agent);
      if (!agent || agent.busy || agent.inCooldown || !hasCredits(agent)) {
        pendingRuns.unshift(next);
        break;
      }
      if (agent.buffer.length === 0) {
        continue;
      }
      startRun(agent, time);
    }
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
      queueDepthByAgent[id] = agent.buffer.length;
      droppedByAgent[id] = agent.droppedCount;
    }
    for (const p of pendingRuns) {
      pendingByAgent[p.agent] = (pendingByAgent[p.agent] ?? 0) + 1;
    }

    return {
      time,
      totalEmits,
      totalRuns,
      pendingRuns: pendingRuns.length,
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
        if (event.agent !== "_credit_refill") {
          handleMessageArrive(event.agent, event.time, event);
        }
        break;
      }
      case "run_end": {
        if (event.generation !== undefined) {
          completeRun(event.agent, event.time, event.generation);
        }
        break;
      }
      case "cooldown_end": {
        if (event.agent === "_credit_refill") {
          refillCredits(event.time);
        } else {
          const agent = agents.get(event.agent);
          if (agent) {
            agent.inCooldown = false;
            if (agent.buffer.length > 0 && hasCredits(agent)) {
              tryStartRun(agent, event.time + config.debounceMs);
            }
            tryDrainPendingRuns(event.time);
          }
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
    designName: "credit-flow",
    metrics,
    finalMetrics,
    eventLog,
    lagSamples,
  };
}
