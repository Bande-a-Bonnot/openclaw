#!/usr/bin/env npx tsx
/**
 * Live terminal visualization of queue stability simulations.
 *
 * Replays simulation events with real-time animated dashboard showing
 * agent states, queue depths, active runs, lag, and event feed.
 *
 * Usage:
 *   npx tsx docs/queue-stability/sim/visualize.ts [options]
 *
 * Options:
 *   --design <name>        Design: current, mailbox, coalescing, credit (default: mailbox)
 *   --tick <ms>            Real-time delay per sim time unit in ms (default: 500)
 *   --agents <spec>        Agent durations, e.g., "A=4,B=5,C=6"
 *   --cap <n>              Concurrency cap (default: 2)
 *   --hold <n>             Post-emit hold D (default: 0)
 *   --debounce <n>         Debounce interval (default: 1)
 *   --horizon <n>          Simulation horizon (default: 60)
 *   --sample <n>           Metrics sample interval (default: 5)
 *   --max-emits <n>        Max emit rounds, 0=unlimited (default: 0)
 *   --credits <n>          Credits for credit design (default: 3)
 *   --credit-refill <n>    Credit refill interval (default: 10)
 *   --side-by-side         Run two designs side by side (e.g., "current,mailbox")
 *   --help                 Show this help
 *
 * Examples:
 *   npx tsx docs/queue-stability/sim/visualize.ts
 *   npx tsx docs/queue-stability/sim/visualize.ts --design current --tick 200
 *   npx tsx docs/queue-stability/sim/visualize.ts --side-by-side current,mailbox
 *   npx tsx docs/queue-stability/sim/visualize.ts --design credit --credits 5
 */

import { simulateCurrentSystem } from "./current-system.js";
import { simulateCoalescingScheduler } from "./design-coalescing-scheduler.js";
import { simulateCreditFlow } from "./design-credit-flow.js";
import { simulateMailbox } from "./design-mailbox.js";
import type { SimConfig, SimResult, Event, SimMetrics } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

// ─── ANSI helpers ──────────────────────────────────────────────────────────

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const RED = `${ESC}31m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const BLUE = `${ESC}34m`;
const MAGENTA = `${ESC}35m`;
const CYAN = `${ESC}36m`;
const WHITE = `${ESC}37m`;
const BG_RED = `${ESC}41m`;
const BG_GREEN = `${ESC}42m`;
const BG_YELLOW = `${ESC}43m`;
const BG_BLUE = `${ESC}44m`;
const BG_MAGENTA = `${ESC}45m`;
const BG_CYAN = `${ESC}46m`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const CLEAR_SCREEN = `${ESC}2J${ESC}H`;

function bar(value: number, max: number, width: number, fill = "█", empty = "░"): string {
  const filled = max > 0 ? Math.round((value / max) * width) : 0;
  return fill.repeat(Math.min(filled, width)) + empty.repeat(Math.max(0, width - filled));
}

function colorForAgent(agentId: string): string {
  const colors = [CYAN, MAGENTA, YELLOW, GREEN, BLUE, RED];
  const idx = agentId.charCodeAt(0) % colors.length;
  return colors[idx];
}

function bgForAgent(agentId: string): string {
  const colors = [BG_CYAN, BG_MAGENTA, BG_YELLOW, BG_GREEN, BG_BLUE, BG_RED];
  const idx = agentId.charCodeAt(0) % colors.length;
  return colors[idx];
}

// ─── Arg parsing ───────────────────────────────────────────────────────────

function parseArgs(): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--side-by-side") {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args["side-by-side"] = next;
        i++;
      }
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

function parseAgents(spec: string): Record<string, number> {
  const agents: Record<string, number> = {};
  for (const part of spec.split(",")) {
    const [name, dur] = part.split("=");
    if (name && dur) {
      agents[name.trim()] = Number(dur);
    }
  }
  return agents;
}

function buildConfig(args: Record<string, string | boolean>): SimConfig {
  const config = { ...DEFAULT_CONFIG };
  if (typeof args.agents === "string") {
    config.agents = parseAgents(args.agents);
  }
  if (typeof args.cap === "string") {
    config.concurrencyCap = Number(args.cap);
  }
  if (typeof args.hold === "string") {
    config.postEmitHold = Number(args.hold);
  }
  if (typeof args.debounce === "string") {
    config.debounceMs = Number(args.debounce);
  }
  if (typeof args.horizon === "string") {
    config.horizon = Number(args.horizon);
  }
  if (typeof args.sample === "string") {
    config.sampleInterval = Number(args.sample);
  }
  if (typeof args["max-emits"] === "string") {
    config.maxEmitRounds = Number(args["max-emits"]);
  }
  return config;
}

function runDesign(
  design: string,
  config: SimConfig,
  args: Record<string, string | boolean>,
): SimResult {
  switch (design) {
    case "current":
      return simulateCurrentSystem(config);
    case "mailbox":
      return simulateMailbox(config);
    case "coalescing":
      return simulateCoalescingScheduler(config);
    case "credit":
      return simulateCreditFlow(config, {
        creditsPerAgent: typeof args.credits === "string" ? Number(args.credits) : undefined,
        creditRefillInterval:
          typeof args["credit-refill"] === "string" ? Number(args["credit-refill"]) : undefined,
      });
    default:
      throw new Error(`Unknown design: ${design}`);
  }
}

// ─── Visualization state ───────────────────────────────────────────────────

type AgentVizState = {
  id: string;
  busy: boolean;
  cooldown: boolean;
  queueDepth: number;
  runsCompleted: number;
  emitCount: number;
  lastAction: string;
  meanLag: number;
  maxLag: number;
};

type VizState = {
  time: number;
  agents: Map<string, AgentVizState>;
  activeRuns: number;
  pendingRuns: number;
  totalEmits: number;
  totalRuns: number;
  recentEvents: string[];
  designName: string;
};

function createVizState(result: SimResult): VizState {
  const agents = new Map<string, AgentVizState>();
  for (const id of Object.keys(result.config.agents)) {
    agents.set(id, {
      id,
      busy: false,
      cooldown: false,
      queueDepth: 0,
      runsCompleted: 0,
      emitCount: 0,
      lastAction: "idle",
      meanLag: 0,
      maxLag: 0,
    });
  }
  return {
    time: 0,
    agents,
    activeRuns: 0,
    pendingRuns: 0,
    totalEmits: 0,
    totalRuns: 0,
    recentEvents: [],
    designName: result.designName,
  };
}

function applyEvent(viz: VizState, event: Event): void {
  const agent = viz.agents.get(event.agent);

  switch (event.type) {
    case "message_arrive": {
      if (agent) {
        agent.lastAction = `← msg ${event.payload ? `(${event.payload.slice(0, 20)})` : ""}`;
      }
      break;
    }
    case "run_start": {
      if (agent) {
        agent.busy = true;
        agent.lastAction = `▶ run ${event.payload ?? ""}`;
      }
      viz.activeRuns++;
      break;
    }
    case "run_end": {
      if (agent) {
        agent.busy = false;
        agent.runsCompleted++;
        agent.lastAction = "■ done";
      }
      viz.activeRuns = Math.max(0, viz.activeRuns - 1);
      viz.totalRuns++;
      break;
    }
    case "emit": {
      if (agent) {
        agent.emitCount++;
        agent.lastAction = "→ emit";
      }
      viz.totalEmits++;
      break;
    }
    case "enqueue_followup": {
      if (agent) {
        agent.queueDepth++;
        agent.lastAction = "⏳ queued";
      }
      break;
    }
    case "drain_followup": {
      if (agent) {
        agent.queueDepth = Math.max(0, agent.queueDepth - 1);
        agent.lastAction = "↓ drain";
      }
      break;
    }
    case "cooldown_end": {
      if (agent) {
        agent.cooldown = false;
        agent.lastAction = "⏰ ready";
      }
      break;
    }
    case "coalesce": {
      if (agent) {
        agent.lastAction = "⊕ coalesce";
      }
      break;
    }
  }

  // Format event for the feed.
  const symbol = eventSymbol(event.type);
  const label = `${DIM}t=${String(event.time).padStart(4)}${RESET} ${symbol} ${colorForAgent(event.agent)}${event.agent}${RESET} ${event.type}${event.payload ? ` ${DIM}${event.payload.slice(0, 25)}${RESET}` : ""}`;
  viz.recentEvents.push(label);
  if (viz.recentEvents.length > 12) {
    viz.recentEvents.shift();
  }
}

function applyMetrics(viz: VizState, metrics: SimMetrics): void {
  viz.time = metrics.time;
  viz.activeRuns = metrics.activeRuns;
  viz.pendingRuns = metrics.pendingRuns;
  viz.totalEmits = metrics.totalEmits;
  viz.totalRuns = metrics.totalRuns;

  for (const [id, agent] of viz.agents) {
    agent.queueDepth = metrics.queueDepthByAgent[id] ?? 0;
    agent.meanLag = metrics.meanLagByAgent[id] ?? 0;
    agent.maxLag = metrics.maxLagByAgent[id] ?? 0;
  }
}

function eventSymbol(type: string): string {
  switch (type) {
    case "message_arrive":
      return `${GREEN}←${RESET}`;
    case "run_start":
      return `${BLUE}▶${RESET}`;
    case "run_end":
      return `${BLUE}■${RESET}`;
    case "emit":
      return `${YELLOW}→${RESET}`;
    case "enqueue_followup":
      return `${MAGENTA}⏳${RESET}`;
    case "drain_followup":
      return `${CYAN}↓${RESET}`;
    case "cooldown_end":
      return `${GREEN}⏰${RESET}`;
    case "coalesce":
      return `${MAGENTA}⊕${RESET}`;
    default:
      return " ";
  }
}

// ─── Render ────────────────────────────────────────────────────────────────

function renderDashboard(viz: VizState, horizon: number, tickMs: number): string {
  const lines: string[] = [];
  const W = Math.min(process.stdout.columns || 80, 100);

  // Header.
  const progress = Math.round((viz.time / horizon) * 100);
  const progressBar = bar(viz.time, horizon, 30);
  lines.push(
    `${BOLD}${bgForAgent(viz.designName.charAt(0))} ${viz.designName.toUpperCase()} ${RESET} ${DIM}tick=${tickMs}ms${RESET}`,
  );
  lines.push(
    `${BOLD}t=${viz.time}${RESET}/${horizon}  ${GREEN}${progressBar}${RESET} ${progress}%`,
  );
  lines.push("─".repeat(W));

  // Global stats row.
  lines.push(
    `  ${BOLD}Runs:${RESET} ${viz.totalRuns}  ${BOLD}Emits:${RESET} ${viz.totalEmits}  ${BOLD}Active:${RESET} ${viz.activeRuns}  ${BOLD}Pending:${RESET} ${viz.pendingRuns}`,
  );
  lines.push("─".repeat(W));

  // Agent cards.
  lines.push(`${BOLD}  AGENTS${RESET}`);
  for (const [id, agent] of viz.agents) {
    const color = colorForAgent(id);
    const statusIcon = agent.busy
      ? `${BG_BLUE}${WHITE} BUSY ${RESET}`
      : agent.cooldown
        ? `${BG_YELLOW}${WHITE} COOL ${RESET}`
        : `${BG_GREEN}${WHITE} IDLE ${RESET}`;

    const qBar = bar(agent.queueDepth, 20, 10);
    const lagDisplay =
      agent.meanLag > 0
        ? `${agent.meanLag > 10 ? RED : agent.meanLag > 5 ? YELLOW : GREEN}μ=${agent.meanLag}${RESET} ${agent.maxLag > 15 ? RED : ""}↑${agent.maxLag}${RESET}`
        : `${DIM}--${RESET}`;

    lines.push(
      `  ${color}${BOLD}${id}${RESET} ${statusIcon}  q:${qBar} ${agent.queueDepth}  runs:${agent.runsCompleted}  emits:${agent.emitCount}  lag:${lagDisplay}`,
    );
    lines.push(`    ${DIM}${agent.lastAction}${RESET}`);
  }

  lines.push("─".repeat(W));

  // Event feed.
  lines.push(`${BOLD}  EVENT FEED${RESET}`);
  if (viz.recentEvents.length === 0) {
    lines.push(`  ${DIM}(waiting for events...)${RESET}`);
  } else {
    for (const e of viz.recentEvents) {
      lines.push(`  ${e}`);
    }
  }

  lines.push("─".repeat(W));
  lines.push(`${DIM}  Press Ctrl+C to exit${RESET}`);

  return lines.join("\n");
}

// ─── Playback ──────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function playback(result: SimResult, tickMs: number): Promise<void> {
  const viz = createVizState(result);
  const events = result.eventLog;
  const metrics = result.metrics;

  // Build a time→events map.
  const eventsByTime = new Map<number, Event[]>();
  for (const e of events) {
    const list = eventsByTime.get(e.time) ?? [];
    list.push(e);
    eventsByTime.set(e.time, list);
  }

  // Build a time→metrics map.
  const metricsByTime = new Map<number, SimMetrics>();
  for (const m of metrics) {
    metricsByTime.set(m.time, m);
  }

  // Get all unique time steps, sorted.
  const allTimes = new Set<number>();
  for (const e of events) {
    allTimes.add(e.time);
  }
  for (const m of metrics) {
    allTimes.add(m.time);
  }
  const sortedTimes = [...allTimes].toSorted((a, b) => a - b);

  process.stdout.write(HIDE_CURSOR);

  // Cleanup on exit.
  const cleanup = () => {
    process.stdout.write(SHOW_CURSOR);
    process.stdout.write("\n");
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });

  try {
    let prevTime = -1;

    for (const time of sortedTimes) {
      // Real-time delay proportional to sim time elapsed.
      if (prevTime >= 0 && time > prevTime) {
        const elapsed = time - prevTime;
        await sleep(elapsed * tickMs);
      }
      prevTime = time;

      // Apply all events at this time.
      const eventsAtTime = eventsByTime.get(time) ?? [];
      for (const e of eventsAtTime) {
        applyEvent(viz, e);
      }

      // Apply metrics if available at this time.
      const m = metricsByTime.get(time);
      if (m) {
        applyMetrics(viz, m);
      }

      viz.time = time;

      // Render.
      process.stdout.write(CLEAR_SCREEN);
      process.stdout.write(renderDashboard(viz, result.config.horizon, tickMs));
    }

    // Final summary.
    process.stdout.write("\n\n");
    process.stdout.write(`${BOLD}${GREEN}  Simulation complete.${RESET}\n`);
    process.stdout.write(
      `  Total: ${viz.totalRuns} runs, ${viz.totalEmits} emits, ${result.lagSamples.length} lag samples\n`,
    );
    if (result.lagSamples.length > 0) {
      const meanLag =
        Math.round(
          (result.lagSamples.reduce((a, s) => a + s.lag, 0) / result.lagSamples.length) * 100,
        ) / 100;
      const maxLag = Math.max(...result.lagSamples.map((s) => s.lag));
      process.stdout.write(`  Overall lag: mean=${meanLag} max=${maxLag}\n`);
    }
  } finally {
    cleanup();
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

function showHelp(): void {
  console.log(`${BOLD}Queue Stability Simulator — Live Visualization${RESET}

${BOLD}Usage:${RESET} npx tsx docs/queue-stability/sim/visualize.ts [options]

${BOLD}Designs:${RESET}
  current     Current system (idle race)
  mailbox     Design A: Mailbox actor
  coalescing  Design B: Coalescing scheduler
  credit      Design C: Credit-based flow

${BOLD}Options:${RESET}
  --design <name>        Design to visualize (default: mailbox)
  --tick <ms>            Real-time delay per sim time unit (default: 500)
  --agents <spec>        Agent durations, e.g., "A=4,B=5,C=6"
  --cap <n>              Concurrency cap (default: 2)
  --hold <n>             Post-emit hold D (default: 0)
  --debounce <n>         Debounce interval (default: 1)
  --horizon <n>          Simulation horizon (default: 60)
  --max-emits <n>        Max emit rounds, 0=unlimited (default: 0)
  --credits <n>          Credits for credit design (default: 3)
  --help                 Show this help

${BOLD}Examples:${RESET}
  npx tsx docs/queue-stability/sim/visualize.ts
  npx tsx docs/queue-stability/sim/visualize.ts --design current --tick 200
  npx tsx docs/queue-stability/sim/visualize.ts --design current --tick 100 --horizon 300`);
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    showHelp();
    return;
  }

  const tickMs = typeof args.tick === "string" ? Number(args.tick) : 500;
  const designName = typeof args.design === "string" ? args.design : "mailbox";

  // Override defaults for visualization (shorter horizon for watchability).
  if (!args.horizon) {
    args.horizon = "60";
  }
  if (!args.sample) {
    args.sample = "5";
  }

  const config = buildConfig(args);

  console.log(`${BOLD}Running ${designName} simulation...${RESET}`);
  const result = runDesign(designName, config, args);
  console.log(
    `${GREEN}Done.${RESET} ${result.eventLog.length} events over t=${config.horizon}. Starting playback at ${tickMs}ms/unit...\n`,
  );
  await sleep(800);

  await playback(result, tickMs);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
