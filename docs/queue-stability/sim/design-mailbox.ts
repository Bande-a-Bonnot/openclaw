/**
 * Design A: Mailbox Actor (Single-Runnable Token per Session)
 *
 * Core idea: each session has exactly one mailbox and at most one
 * "runnable token" in the outer scheduler at any time.
 *
 * Properties:
 * - Messages always go to the mailbox (never bypass it)
 * - When mailbox goes from empty→non-empty AND no active run AND no pending token,
 *   schedule exactly one token in the outer scheduler
 * - When a run starts, it drains/coalesces the entire mailbox
 * - When a run ends, if mailbox has new items, schedule one new token
 * - Prevents run-task fanout: N messages → at most 1 pending run
 *
 * This eliminates the idle race because messages ALWAYS enter the mailbox.
 * The mailbox→token transition is the only path to starting a run.
 */

import {
  EventQueue,
  createConversationState,
  collectMetrics,
  computeLagMetrics,
  applyDropPolicy,
} from "./sim-engine.js";
import type { Event, SimConfig, SimResult, AgentState, AgentId, EmitLagSample } from "./types.js";

type MailboxAgentState = AgentState & {
  /** Is there a pending runnable token in the outer scheduler? */
  hasToken: boolean;
};

export function simulateMailbox(config: SimConfig): SimResult {
  const baseState = createConversationState(config);
  const eq = new EventQueue();
  const eventLog: Event[] = [];
  const metrics: ReturnType<typeof collectMetrics>[] = [];
  const lagSamples: EmitLagSample[] = [];
  const agentIds = [...baseState.agents.keys()];

  // Extend agent state with mailbox token tracking.
  const agents = new Map<AgentId, MailboxAgentState>();
  for (const [id, base] of baseState.agents) {
    agents.set(id, { ...base, hasToken: false });
  }

  const state = { ...baseState, agents };

  // Per-agent: earliest message arrival time consumed by the current run.
  const runTriggerTime = new Map<AgentId, number>();
  const runCoalescedCount = new Map<AgentId, number>();

  // Seed messages.
  for (const id of agentIds) {
    eq.push({ time: 0, type: "message_arrive", agent: id, payload: "human_seed" });
  }

  // Metric ticks.
  for (let t = config.sampleInterval; t <= config.horizon; t += config.sampleInterval) {
    eq.push({ time: t, type: "tick", agent: "_metrics" });
  }

  function scheduleToken(agent: MailboxAgentState, time: number): void {
    if (agent.hasToken || agent.busy || agent.inCooldown) {
      return;
    }
    if (agent.followupQueue.length === 0) {
      return;
    }
    agent.hasToken = true;
    state.pendingRuns.push({ agent: agent.id, enqueuedAt: time, coalescedCount: 1 });
    tryDrainPendingRuns(time);
  }

  function startRun(agent: MailboxAgentState, time: number): void {
    agent.busy = true;
    agent.hasToken = false;
    agent.generation++;
    state.activeRuns++;

    // Drain/coalesce entire mailbox into this run.
    const coalescedCount = agent.followupQueue.length;
    const earliestEnqueued =
      coalescedCount > 0 ? Math.min(...agent.followupQueue.map((m) => m.enqueuedAt)) : time;
    agent.followupQueue.length = 0;

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

  function completeRun(agent: MailboxAgentState, time: number, generation: number): void {
    if (generation !== agent.generation) {
      return;
    }
    agent.busy = false;
    state.activeRuns--;
    agent.runsCompleted++;
    eventLog.push({ time, type: "run_end", agent: agent.id });

    // Emit to peers.
    const maxRounds = config.maxEmitRounds;
    if (config.emitToAllPeers && (maxRounds <= 0 || agent.emitCount < maxRounds)) {
      emitToPeers(agent, time);
    }

    // If mailbox has items accumulated during this run, schedule a new token.
    if (config.postEmitHold > 0) {
      agent.inCooldown = true;
      eq.push({
        time: time + config.postEmitHold,
        type: "cooldown_end",
        agent: agent.id,
        generation: agent.generation,
      });
    } else {
      scheduleToken(agent, time + config.debounceMs);
    }

    tryDrainPendingRuns(time);
  }

  function emitToPeers(agent: MailboxAgentState, time: number): void {
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

  function handleMessageArrive(agent: MailboxAgentState, time: number, event: Event): void {
    eventLog.push({ time, type: "message_arrive", agent: agent.id });

    // KEY DIFFERENCE: messages ALWAYS go to the mailbox first.
    const shouldEnqueue = applyDropPolicy(agent, config.queueCap, config.dropPolicy);
    if (shouldEnqueue) {
      agent.followupQueue.push({
        from: event.agent,
        prompt: event.payload ?? "",
        enqueuedAt: time,
      });
    }

    // If mailbox just became non-empty and no active run/token, schedule token.
    scheduleToken(agent, time);
  }

  function tryDrainPendingRuns(time: number): void {
    while (state.activeRuns < state.concurrencyCap && state.pendingRuns.length > 0) {
      const next = state.pendingRuns.shift()!;
      const agent = agents.get(next.agent);
      if (!agent || agent.busy || agent.inCooldown) {
        state.pendingRuns.unshift(next);
        break;
      }
      startRun(agent, time);
    }
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
        const m = collectMetrics(
          { ...state, agents: state.agents as Record<string, unknown> },
          event.time,
        );
        const lag = computeLagMetrics(lagSamples, event.time, prevTickTime, agentIds);
        m.meanLagByAgent = lag.meanLagByAgent;
        m.maxLagByAgent = lag.maxLagByAgent;
        metrics.push(m);
        prevTickTime = event.time;
        break;
      }
      case "message_arrive": {
        const agent = agents.get(event.agent);
        if (agent) {
          handleMessageArrive(agent, event.time, event);
        }
        break;
      }
      case "run_end": {
        const agent = agents.get(event.agent);
        if (agent && event.generation !== undefined) {
          completeRun(agent, event.time, event.generation);
        }
        break;
      }
      case "cooldown_end": {
        const agent = agents.get(event.agent);
        if (agent) {
          agent.inCooldown = false;
          scheduleToken(agent, event.time + config.debounceMs);
          tryDrainPendingRuns(event.time);
        }
        break;
      }
    }
  }

  const finalMetrics = collectMetrics(
    { ...state, agents: state.agents as Record<string, unknown> },
    config.horizon,
  );
  const finalLag = computeLagMetrics(lagSamples, config.horizon, prevTickTime, agentIds);
  finalMetrics.meanLagByAgent = finalLag.meanLagByAgent;
  finalMetrics.maxLagByAgent = finalLag.maxLagByAgent;
  metrics.push(finalMetrics);

  return {
    config,
    designName: "mailbox",
    metrics,
    finalMetrics,
    eventLog,
    lagSamples,
  };
}
