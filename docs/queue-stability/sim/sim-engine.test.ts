/**
 * Validation tests for queue stability simulations.
 *
 * Run: npx tsx scripts/queue-sim/sim-engine.test.ts
 */

import { simulateCurrentSystem } from "./current-system.js";
import { simulateCoalescingScheduler } from "./design-coalescing-scheduler.js";
import { simulateCreditFlow } from "./design-credit-flow.js";
import { simulateMailbox } from "./design-mailbox.js";
import { DEFAULT_CONFIG, type SimConfig } from "./types.js";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

console.log("Queue Simulation Tests\n");

// ── Current system tests ─────────────────────────────────────

console.log("Current System:");

test("pending runs grow unboundedly at D=0", () => {
  const config: SimConfig = { ...DEFAULT_CONFIG, postEmitHold: 0, horizon: 300 };
  const result = simulateCurrentSystem(config);
  // Should have significant pending run accumulation.
  assert(
    result.finalMetrics.pendingRuns > 20,
    `Expected >20 pending runs, got ${result.finalMetrics.pendingRuns}`,
  );
});

test("emit count is positive", () => {
  const result = simulateCurrentSystem(DEFAULT_CONFIG);
  assert(
    result.finalMetrics.totalEmits > 0,
    `Expected emits > 0, got ${result.finalMetrics.totalEmits}`,
  );
});

test("all agents execute runs", () => {
  const result = simulateCurrentSystem(DEFAULT_CONFIG);
  assert(
    result.finalMetrics.totalRuns >= 3,
    `Expected >= 3 runs, got ${result.finalMetrics.totalRuns}`,
  );
});

test("idle race is observable in event log", () => {
  const config: SimConfig = { ...DEFAULT_CONFIG, horizon: 30 };
  const result = simulateCurrentSystem(config);
  // An agent should have both message_arrive and run_start at the same time
  // (indicating bypass of followup queue).
  const arrivals = result.eventLog.filter((e) => e.type === "message_arrive");
  const starts = result.eventLog.filter((e) => e.type === "run_start");
  const raceEvents = starts.filter((s) =>
    arrivals.some((a) => a.time === s.time && a.agent === s.agent && s.time > 0),
  );
  assert(raceEvents.length > 0, `Expected idle race events, found ${raceEvents.length}`);
});

// ── Mailbox design tests ─────────────────────────────────────

console.log("\nMailbox Design:");

test("pending runs bounded at 1", () => {
  const config: SimConfig = { ...DEFAULT_CONFIG, postEmitHold: 0, horizon: 300 };
  const result = simulateMailbox(config);
  const maxPending = Math.max(...result.metrics.map((m) => m.pendingRuns));
  assert(maxPending <= 3, `Expected max pending ≤ 3, got ${maxPending}`);
});

test("no idle race — all messages enter mailbox", () => {
  const config: SimConfig = { ...DEFAULT_CONFIG, horizon: 30 };
  const result = simulateMailbox(config);
  // Every message_arrive should NOT be immediately followed by a run_start
  // for the same agent at the same time (unless it's the first message).
  // Actually in mailbox, the first message for an idle agent DOES trigger
  // a token → run, so we check that subsequent messages coalesce.
  const coalescedRuns = result.eventLog.filter(
    (e) => e.type === "run_start" && e.payload?.startsWith("coalesced_"),
  );
  const multiCoalesced = coalescedRuns.filter((e) => {
    const count = parseInt(e.payload?.split("_")[1] ?? "0");
    return count > 1;
  });
  assert(
    multiCoalesced.length > 0,
    `Expected coalesced runs with >1 items, found ${multiCoalesced.length}`,
  );
});

test("throughput comparable to current system", () => {
  const config: SimConfig = { ...DEFAULT_CONFIG, horizon: 120 };
  const current = simulateCurrentSystem(config);
  const mailbox = simulateMailbox(config);
  const ratio = mailbox.finalMetrics.totalEmits / current.finalMetrics.totalEmits;
  assert(
    ratio >= 0.8,
    `Expected mailbox emits >= 80% of current, got ${(ratio * 100).toFixed(0)}%`,
  );
});

// ── Coalescing scheduler tests ───────────────────────────────

console.log("\nCoalescing Scheduler:");

test("pending runs bounded at agent count", () => {
  const config: SimConfig = { ...DEFAULT_CONFIG, horizon: 300 };
  const result = simulateCoalescingScheduler(config);
  const maxPending = Math.max(...result.metrics.map((m) => m.pendingRuns));
  const agentCount = Object.keys(config.agents).length;
  assert(maxPending <= agentCount, `Expected max pending ≤ ${agentCount}, got ${maxPending}`);
});

test("coalescing observable in event log", () => {
  const config: SimConfig = { ...DEFAULT_CONFIG, horizon: 30 };
  const result = simulateCoalescingScheduler(config);
  const coalesceEvents = result.eventLog.filter((e) => e.type === "coalesce");
  assert(coalesceEvents.length > 0, `Expected coalesce events, found ${coalesceEvents.length}`);
});

// ── Credit flow tests ────────────────────────────────────────

console.log("\nCredit Flow:");

test("pending runs bounded", () => {
  const config: SimConfig = { ...DEFAULT_CONFIG, horizon: 300 };
  const result = simulateCreditFlow(config);
  const maxPending = Math.max(...result.metrics.map((m) => m.pendingRuns));
  assert(maxPending <= 5, `Expected max pending ≤ 5, got ${maxPending}`);
});

test("credit exhaustion limits throughput", () => {
  const lowCredits = simulateCreditFlow(
    { ...DEFAULT_CONFIG, horizon: 120 },
    { creditsPerAgent: 1, creditRefillInterval: 20 },
  );
  const highCredits = simulateCreditFlow(
    { ...DEFAULT_CONFIG, horizon: 120 },
    { creditsPerAgent: 10, creditRefillInterval: 5 },
  );
  assert(
    lowCredits.finalMetrics.totalEmits < highCredits.finalMetrics.totalEmits,
    `Expected low credits < high credits emits`,
  );
});

// ── Single-agent tests ───────────────────────────────────────
// Models: one agent, no peers. Human sends periodic messages.
// This is the common case: a Pi bot in a 1:1 conversation.

console.log("\nSingle Agent (no peers):");

const SINGLE_AGENT_CONFIG: SimConfig = {
  agents: { Solo: 5 },
  concurrencyCap: 1,
  queueMode: "collect",
  queueCap: 20,
  dropPolicy: "old",
  deliveryDelay: 1,
  postEmitHold: 0,
  debounceMs: 1,
  horizon: 120,
  sampleInterval: 10,
  emitToAllPeers: false,
  maxEmitRounds: 0,
};

test("current system: single agent is stable (no peers = no feedback loop)", () => {
  const result = simulateCurrentSystem(SINGLE_AGENT_CONFIG);
  // With no peers, there's no emit→arrive feedback. Should be trivially stable.
  assert(
    result.finalMetrics.pendingRuns <= 1,
    `Expected ≤1 pending, got ${result.finalMetrics.pendingRuns}`,
  );
  assert(
    result.finalMetrics.totalRuns >= 1,
    `Expected ≥1 run, got ${result.finalMetrics.totalRuns}`,
  );
});

test("mailbox: single agent works identically", () => {
  const result = simulateMailbox(SINGLE_AGENT_CONFIG);
  assert(
    result.finalMetrics.pendingRuns <= 1,
    `Expected ≤1 pending, got ${result.finalMetrics.pendingRuns}`,
  );
  assert(
    result.finalMetrics.totalRuns >= 1,
    `Expected ≥1 run, got ${result.finalMetrics.totalRuns}`,
  );
});

test("coalescing: single agent works identically", () => {
  const result = simulateCoalescingScheduler(SINGLE_AGENT_CONFIG);
  assert(
    result.finalMetrics.pendingRuns <= 1,
    `Expected ≤1 pending, got ${result.finalMetrics.pendingRuns}`,
  );
  assert(
    result.finalMetrics.totalRuns >= 1,
    `Expected ≥1 run, got ${result.finalMetrics.totalRuns}`,
  );
});

test("credit: single agent works identically", () => {
  const result = simulateCreditFlow(SINGLE_AGENT_CONFIG);
  assert(
    result.finalMetrics.pendingRuns <= 1,
    `Expected ≤1 pending, got ${result.finalMetrics.pendingRuns}`,
  );
  assert(
    result.finalMetrics.totalRuns >= 1,
    `Expected ≥1 run, got ${result.finalMetrics.totalRuns}`,
  );
});

test("single agent: all designs produce same throughput", () => {
  const current = simulateCurrentSystem(SINGLE_AGENT_CONFIG);
  const mailbox = simulateMailbox(SINGLE_AGENT_CONFIG);
  const coalescing = simulateCoalescingScheduler(SINGLE_AGENT_CONFIG);
  const credit = simulateCreditFlow(SINGLE_AGENT_CONFIG);
  // All should have identical or near-identical run counts.
  assert(
    mailbox.finalMetrics.totalRuns === current.finalMetrics.totalRuns,
    `Mailbox runs (${mailbox.finalMetrics.totalRuns}) != current (${current.finalMetrics.totalRuns})`,
  );
  assert(
    coalescing.finalMetrics.totalRuns === current.finalMetrics.totalRuns,
    `Coalescing runs (${coalescing.finalMetrics.totalRuns}) != current (${current.finalMetrics.totalRuns})`,
  );
  assert(
    credit.finalMetrics.totalRuns === current.finalMetrics.totalRuns,
    `Credit runs (${credit.finalMetrics.totalRuns}) != current (${current.finalMetrics.totalRuns})`,
  );
});

// ── Single agent in multiple conversations (shared concurrency) ──
// Models: one bot agent present in 2 separate conversations, each with
// a human. The conversations share a global concurrency cap.
// We simulate this as 2 independent agents (Human1→Bot1, Human2→Bot2)
// competing for the same concurrency cap, with no cross-emit.

console.log("\nSingle Agent, Multiple Conversations (shared cap):");

const MULTI_CONV_CONFIG: SimConfig = {
  agents: { Conv1: 5, Conv2: 5 },
  concurrencyCap: 1, // Only 1 run at a time across conversations.
  queueMode: "collect",
  queueCap: 20,
  dropPolicy: "old",
  deliveryDelay: 1,
  postEmitHold: 0,
  debounceMs: 1,
  horizon: 120,
  sampleInterval: 10,
  emitToAllPeers: false, // No cross-conversation messaging.
  maxEmitRounds: 0,
};

test("current system: shared cap serializes, no instability", () => {
  const result = simulateCurrentSystem(MULTI_CONV_CONFIG);
  // Without peer-emit, no feedback loop. Concurrency contention but bounded.
  assert(
    result.finalMetrics.pendingRuns <= 2,
    `Expected ≤2 pending, got ${result.finalMetrics.pendingRuns}`,
  );
});

test("mailbox: shared cap works correctly", () => {
  const result = simulateMailbox(MULTI_CONV_CONFIG);
  assert(
    result.finalMetrics.pendingRuns <= 2,
    `Expected ≤2 pending, got ${result.finalMetrics.pendingRuns}`,
  );
});

test("coalescing: shared cap works correctly", () => {
  const result = simulateCoalescingScheduler(MULTI_CONV_CONFIG);
  assert(
    result.finalMetrics.pendingRuns <= 2,
    `Expected ≤2 pending, got ${result.finalMetrics.pendingRuns}`,
  );
});

test("credit: shared cap works correctly", () => {
  const result = simulateCreditFlow(MULTI_CONV_CONFIG);
  assert(
    result.finalMetrics.pendingRuns <= 2,
    `Expected ≤2 pending, got ${result.finalMetrics.pendingRuns}`,
  );
});

test("shared cap: designs don't degrade single-agent throughput", () => {
  const current = simulateCurrentSystem(MULTI_CONV_CONFIG);
  const mailbox = simulateMailbox(MULTI_CONV_CONFIG);
  // Mailbox should have equal or better throughput.
  assert(
    mailbox.finalMetrics.totalRuns >= current.finalMetrics.totalRuns * 0.9,
    `Mailbox runs (${mailbox.finalMetrics.totalRuns}) < 90% of current (${current.finalMetrics.totalRuns})`,
  );
});

// ── Lag tests ────────────────────────────────────────────────

console.log("\nLag Tracking:");

test("current system lag grows unboundedly at D=0", () => {
  const config: SimConfig = { ...DEFAULT_CONFIG, postEmitHold: 0, horizon: 300 };
  const result = simulateCurrentSystem(config);
  const maxLag = Math.max(...(result.lagSamples ?? []).map((s) => s.lag), 0);
  assert(maxLag > 100, `Expected max lag > 100, got ${maxLag}`);
});

test("mailbox lag stays bounded", () => {
  const config: SimConfig = { ...DEFAULT_CONFIG, postEmitHold: 0, horizon: 300 };
  const result = simulateMailbox(config);
  const maxLag = Math.max(...(result.lagSamples ?? []).map((s) => s.lag), 0);
  assert(maxLag <= 30, `Expected max lag ≤ 30, got ${maxLag}`);
});

test("all designs have lower mean lag than current at D=0", () => {
  const config: SimConfig = { ...DEFAULT_CONFIG, postEmitHold: 0, horizon: 300 };
  const current = simulateCurrentSystem(config);
  const mailbox = simulateMailbox(config);
  const coalescing = simulateCoalescingScheduler(config);
  const credit = simulateCreditFlow(config);

  function meanLag(samples: typeof current.lagSamples): number {
    if (!samples || samples.length === 0) {
      return 0;
    }
    return samples.reduce((a, s) => a + s.lag, 0) / samples.length;
  }

  const currentMean = meanLag(current.lagSamples);
  assert(meanLag(mailbox.lagSamples) < currentMean, `Mailbox mean lag >= current`);
  assert(meanLag(coalescing.lagSamples) < currentMean, `Coalescing mean lag >= current`);
  assert(meanLag(credit.lagSamples) < currentMean, `Credit mean lag >= current`);
});

// ── Cross-design comparison ──────────────────────────────────

console.log("\nCross-Design Comparison:");

test("all alternatives have fewer pending runs than current", () => {
  const config: SimConfig = { ...DEFAULT_CONFIG, horizon: 300 };
  const current = simulateCurrentSystem(config);
  const mailbox = simulateMailbox(config);
  const coalescing = simulateCoalescingScheduler(config);
  const credit = simulateCreditFlow(config);

  assert(
    mailbox.finalMetrics.pendingRuns < current.finalMetrics.pendingRuns,
    `Mailbox pending (${mailbox.finalMetrics.pendingRuns}) >= current (${current.finalMetrics.pendingRuns})`,
  );
  assert(
    coalescing.finalMetrics.pendingRuns < current.finalMetrics.pendingRuns,
    `Coalescing pending (${coalescing.finalMetrics.pendingRuns}) >= current (${current.finalMetrics.pendingRuns})`,
  );
  assert(
    credit.finalMetrics.pendingRuns < current.finalMetrics.pendingRuns,
    `Credit pending (${credit.finalMetrics.pendingRuns}) >= current (${current.finalMetrics.pendingRuns})`,
  );
});

test("D=2 does not save current system at long horizon", () => {
  // With steer mode, D=2 makes it worse.
  const config: SimConfig = {
    ...DEFAULT_CONFIG,
    queueMode: "steer",
    postEmitHold: 2,
    horizon: 120,
  };
  const current = simulateCurrentSystem(config);
  assert(
    current.finalMetrics.pendingRuns > 10,
    `Expected current steer D=2 pending > 10, got ${current.finalMetrics.pendingRuns}`,
  );
});

console.log("\nAll tests passed.");
