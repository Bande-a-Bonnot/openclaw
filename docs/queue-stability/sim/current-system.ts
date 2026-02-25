/**
 * Simulation of the CURRENT OpenClaw queue architecture.
 *
 * Models the three-layer queue system:
 * 1. Followup queue (per-session, in-memory, bounded by cap + drop policy)
 * 2. Command lane (per-lane serialization with configurable concurrency)
 * 3. Conversation-level concurrency cap
 *
 * Key behaviors modelled:
 * - Idle race: if agent is idle when message arrives, immediate run (bypasses followup queue)
 * - Followup drain at run completion: schedules drain of followup queue
 * - Collect mode: batches queued items into single prompt
 * - Post-emit hold (D parameter): delays agent availability after emitting
 * - Delivery delay (E parameter): time for emitted message to reach peer
 *
 * The idle race is the core pathology: it allows run-task fanout even with bounded queues.
 */

import {
  EventQueue,
  createConversationState,
  collectMetrics,
  computeLagMetrics,
  applyDropPolicy,
} from "./sim-engine.js";
import type {
  Event,
  SimConfig,
  SimResult,
  SimMetrics,
  AgentState,
  AgentId,
  EmitLagSample,
} from "./types.js";

export function simulateCurrentSystem(config: SimConfig): SimResult {
  const state = createConversationState(config);
  const eq = new EventQueue();
  const eventLog: Event[] = [];
  const metrics: SimMetrics[] = [];
  const lagSamples: EmitLagSample[] = [];
  const agentIds = [...state.agents.keys()];

  // Per-agent: earliest message arrival time for the current run.
  const runTriggerTime = new Map<AgentId, number>();
  // Per-agent: count of messages coalesced into the current run.
  const runCoalescedCount = new Map<AgentId, number>();

  // Seed: human sends one message to each agent at t=0.
  for (const id of agentIds) {
    eq.push({ time: 0, type: "message_arrive", agent: id, payload: "human_seed" });
  }

  // Schedule metric ticks.
  for (let t = config.sampleInterval; t <= config.horizon; t += config.sampleInterval) {
    eq.push({ time: t, type: "tick", agent: "_metrics" });
  }

  function tryStartRun(agent: AgentState, time: number, triggerTime?: number): void {
    if (agent.busy || agent.inCooldown) {
      const existing = state.pendingRuns.find((p) => p.agent === agent.id);
      if (config.queueMode === "collect" && existing) {
        existing.coalescedCount++;
        return;
      }
      state.pendingRuns.push({ agent: agent.id, enqueuedAt: time, coalescedCount: 1 });
      return;
    }
    if (state.activeRuns >= state.concurrencyCap) {
      state.pendingRuns.push({ agent: agent.id, enqueuedAt: time, coalescedCount: 1 });
      return;
    }
    startRun(agent, time, triggerTime);
  }

  function startRun(agent: AgentState, time: number, triggerTime?: number): void {
    agent.busy = true;
    agent.generation++;
    state.activeRuns++;
    // Record earliest message time for this run.
    const existing = runTriggerTime.get(agent.id);
    const effective = triggerTime ?? time;
    runTriggerTime.set(agent.id, existing != null ? Math.min(existing, effective) : effective);
    runCoalescedCount.set(agent.id, (runCoalescedCount.get(agent.id) ?? 0) + 1);
    eq.push({
      time: time + agent.runDuration,
      type: "run_end",
      agent: agent.id,
      generation: agent.generation,
    });
    eventLog.push({ time, type: "run_start", agent: agent.id });
  }

  function completeRun(agent: AgentState, time: number, generation: number): void {
    if (generation !== agent.generation) {
      return;
    }
    agent.busy = false;
    state.activeRuns--;
    agent.runsCompleted++;
    eventLog.push({ time, type: "run_end", agent: agent.id });

    // Emit to all peers.
    if (config.emitToAllPeers) {
      const maxRounds = config.maxEmitRounds;
      if (maxRounds > 0 && agent.emitCount >= maxRounds) {
        // Hit emit cap — don't emit.
      } else {
        emitToPeers(agent, time);
      }
    }

    // Drain followup queue.
    drainFollowupQueue(agent, time);

    // Try to start pending runs from outer scheduler.
    tryDrainPendingRuns(time);
  }

  function emitToPeers(agent: AgentState, time: number): void {
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
    // Reset for next run.
    runTriggerTime.delete(agent.id);
    runCoalescedCount.delete(agent.id);

    const peers = agentIds.filter((id) => id !== agent.id);
    for (const peerId of peers) {
      const deliveryTime = time + config.deliveryDelay;
      eq.push({
        time: deliveryTime,
        type: "message_arrive",
        agent: peerId,
        target: peerId,
        payload: `emit_from_${agent.id}`,
      });
    }
    eventLog.push({ time, type: "emit", agent: agent.id });

    // Post-emit hold.
    if (config.postEmitHold > 0) {
      agent.inCooldown = true;
      eq.push({
        time: time + config.postEmitHold,
        type: "cooldown_end",
        agent: agent.id,
        generation: agent.generation,
      });
    }
  }

  function handleMessageArrive(agent: AgentState, time: number, event: Event): void {
    eventLog.push({ time, type: "message_arrive", agent: agent.id });

    // THE IDLE RACE: if agent is not active, start immediate run.
    if (!agent.busy && !agent.inCooldown) {
      tryStartRun(agent, time, time);
      return;
    }

    // Agent is busy — enqueue in followup queue (with cap + drop policy).
    const shouldEnqueue = applyDropPolicy(agent, config.queueCap, config.dropPolicy);
    if (shouldEnqueue) {
      agent.followupQueue.push({
        from: event.agent,
        prompt: event.payload ?? "",
        enqueuedAt: time,
      });
      eventLog.push({ time, type: "enqueue_followup", agent: agent.id });
    }
  }

  function drainFollowupQueue(agent: AgentState, time: number): void {
    if (agent.followupQueue.length === 0) {
      return;
    }

    if (config.queueMode === "collect") {
      // Collect mode: drain all queued items as one batch.
      const batchSize = agent.followupQueue.length;
      const earliestEnqueued = Math.min(...agent.followupQueue.map((m) => m.enqueuedAt));
      agent.followupQueue.length = 0;
      eventLog.push({
        time,
        type: "drain_followup",
        agent: agent.id,
        payload: `batch_${batchSize}`,
      });
      // Track trigger time for the followup run.
      const existing = runTriggerTime.get(agent.id);
      runTriggerTime.set(
        agent.id,
        existing != null ? Math.min(existing, earliestEnqueued) : earliestEnqueued,
      );
      runCoalescedCount.set(agent.id, (runCoalescedCount.get(agent.id) ?? 0) + batchSize);
      tryStartRun(agent, time + config.debounceMs, earliestEnqueued);
    } else {
      // Steer mode: drain one item at a time.
      const item = agent.followupQueue.shift()!;
      eventLog.push({ time, type: "drain_followup", agent: agent.id });
      runTriggerTime.set(agent.id, item.enqueuedAt);
      runCoalescedCount.set(agent.id, 1);
      tryStartRun(agent, time + config.debounceMs, item.enqueuedAt);
    }
  }

  function tryDrainPendingRuns(time: number): void {
    // Skip busy/cooldown agents instead of blocking on the first one.
    // The real outer scheduler doesn't use strict FIFO — it picks the
    // next available agent, so head-of-line blocking is unrealistic.
    let i = 0;
    while (state.activeRuns < state.concurrencyCap && i < state.pendingRuns.length) {
      const entry = state.pendingRuns[i];
      const agent = state.agents.get(entry.agent);
      if (!agent || agent.busy || agent.inCooldown) {
        i++;
        continue;
      }
      state.pendingRuns.splice(i, 1);
      startRun(agent, time, entry.enqueuedAt);
    }
  }

  // Main simulation loop.
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
        const m = collectMetrics(state, event.time);
        const lag = computeLagMetrics(lagSamples, event.time, prevTickTime, agentIds);
        m.meanLagByAgent = lag.meanLagByAgent;
        m.maxLagByAgent = lag.maxLagByAgent;
        metrics.push(m);
        prevTickTime = event.time;
        break;
      }
      case "message_arrive": {
        const agent = state.agents.get(event.agent);
        if (agent) {
          handleMessageArrive(agent, event.time, event);
        }
        break;
      }
      case "run_end": {
        const agent = state.agents.get(event.agent);
        if (agent && event.generation !== undefined) {
          completeRun(agent, event.time, event.generation);
        }
        break;
      }
      case "cooldown_end": {
        const agent = state.agents.get(event.agent);
        if (agent) {
          agent.inCooldown = false;
          tryDrainPendingRuns(event.time);
          if (agent.followupQueue.length > 0 && !agent.busy) {
            drainFollowupQueue(agent, event.time);
          }
        }
        break;
      }
    }
  }

  // Final metrics snapshot.
  const finalMetrics = collectMetrics(state, config.horizon);
  const finalLag = computeLagMetrics(lagSamples, config.horizon, prevTickTime, agentIds);
  finalMetrics.meanLagByAgent = finalLag.meanLagByAgent;
  finalMetrics.maxLagByAgent = finalLag.maxLagByAgent;
  metrics.push(finalMetrics);

  return {
    config,
    designName: "current",
    metrics,
    finalMetrics,
    eventLog,
    lagSamples,
  };
}
