#!/usr/bin/env npx tsx
/**
 * CLI for running queue stability simulations.
 *
 * Usage:
 *   npx tsx docs/queue-stability/sim/cli.ts [options]
 *
 * Options:
 *   --design <name>        Run specific design: current, mailbox, coalescing, credit, all (default: all)
 *   --agents <spec>        Agent durations, e.g., "A=4,B=5,C=6" (default: A=4,B=5,C=6)
 *   --cap <n>              Conversation concurrency cap (default: 2)
 *   --queue-mode <mode>    Queue mode: collect | steer (default: collect)
 *   --queue-cap <n>        Per-agent queue cap (default: 20)
 *   --drop <policy>        Drop policy: old | new | summarize (default: old)
 *   --delay <n>            Delivery delay E (default: 1)
 *   --hold <n>             Post-emit hold D (default: 0)
 *   --debounce <n>         Debounce interval (default: 1)
 *   --horizon <n>          Simulation horizon (default: 120)
 *   --sample <n>           Metrics sample interval (default: 10)
 *   --max-emits <n>        Max emit rounds per agent, 0=unlimited (default: 0)
 *   --credits <n>          Credits per agent for credit design (default: 3)
 *   --credit-refill <n>    Credit refill interval (default: 10)
 *   --timeline             Show event timeline
 *   --timeline-limit <n>   Max timeline events to show (default: 50)
 *   --json                 Output raw JSON results
 *   --compare-holds        Run comparison across D=0 and D=2
 *   --compare-horizons     Run comparison across t=120 and t=300
 *   --sweep                Full parameter sweep (D×horizon×design)
 *   --help                 Show this help
 *
 * Examples:
 *   bun scripts/queue-sim/cli.ts --design all --horizon 300
 *   bun scripts/queue-sim/cli.ts --compare-holds
 *   bun scripts/queue-sim/cli.ts --design current --hold 2 --horizon 300 --timeline
 *   bun scripts/queue-sim/cli.ts --sweep
 *   bun scripts/queue-sim/cli.ts --design credit --credits 5 --credit-refill 8
 */

import { simulateCurrentSystem } from "./current-system.js";
import { simulateCoalescingScheduler } from "./design-coalescing-scheduler.js";
import { simulateCreditFlow } from "./design-credit-flow.js";
import { simulateMailbox } from "./design-mailbox.js";
import {
  formatMetricsTable,
  formatComparison,
  formatEventTimeline,
  formatStabilityAnalysis,
  formatLagAnalysis,
} from "./report.js";
import { DEFAULT_CONFIG, type SimConfig, type SimResult } from "./types.js";

function parseArgs(): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--timeline") {
      args.timeline = true;
      continue;
    }
    if (arg === "--json") {
      args.json = true;
      continue;
    }
    if (arg === "--compare-holds") {
      args["compare-holds"] = true;
      continue;
    }
    if (arg === "--compare-horizons") {
      args["compare-horizons"] = true;
      continue;
    }
    if (arg === "--sweep") {
      args.sweep = true;
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
  if (typeof args["queue-mode"] === "string") {
    config.queueMode = args["queue-mode"] as SimConfig["queueMode"];
  }
  if (typeof args["queue-cap"] === "string") {
    config.queueCap = Number(args["queue-cap"]);
  }
  if (typeof args.drop === "string") {
    config.dropPolicy = args.drop as SimConfig["dropPolicy"];
  }
  if (typeof args.delay === "string") {
    config.deliveryDelay = Number(args.delay);
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

function showHelp(): void {
  const helpText = `Queue Stability Simulator

Usage: bun scripts/queue-sim/cli.ts [options]

Designs:
  current     Current OpenClaw queue architecture (multi-layer, idle race)
  mailbox     Design A: Single-runnable mailbox per session (actor model)
  coalescing  Design B: Conversation-scoped coalescing scheduler
  credit      Design C: Credit-based flow control (token bucket)

Options:
  --design <name>        Run specific design or "all" (default: all)
  --agents <spec>        Agent durations, e.g., "A=4,B=5,C=6"
  --cap <n>              Conversation concurrency cap (default: 2)
  --queue-mode <mode>    collect | steer (default: collect)
  --queue-cap <n>        Per-agent queue cap (default: 20)
  --drop <policy>        old | new | summarize (default: old)
  --delay <n>            Delivery delay E (default: 1)
  --hold <n>             Post-emit hold D (default: 0)
  --debounce <n>         Debounce interval (default: 1)
  --horizon <n>          Simulation horizon (default: 120)
  --max-emits <n>        Max emit rounds, 0=unlimited (default: 0)
  --credits <n>          Credits for credit design (default: 3)
  --credit-refill <n>    Credit refill interval (default: 10)
  --timeline             Show event timeline
  --json                 JSON output
  --compare-holds        Compare D=0 vs D=2
  --compare-horizons     Compare t=120 vs t=300
  --sweep                Full parameter sweep

Examples:
  bun scripts/queue-sim/cli.ts --design all
  bun scripts/queue-sim/cli.ts --compare-holds
  bun scripts/queue-sim/cli.ts --sweep
  bun scripts/queue-sim/cli.ts --design credit --credits 5 --horizon 300`;

  console.log(helpText);
}

const ALL_DESIGNS = ["current", "mailbox", "coalescing", "credit"];

function main(): void {
  const args = parseArgs();

  if (args.help) {
    showHelp();
    return;
  }

  // Full parameter sweep mode.
  if (args.sweep) {
    console.log("╔══════════════════════════════════════════════════════════╗");
    console.log("║           FULL PARAMETER SWEEP                          ║");
    console.log("╚══════════════════════════════════════════════════════════╝");

    const holds = [0, 2];
    const horizons = [120, 300];
    const allResults: SimResult[] = [];

    for (const horizon of horizons) {
      for (const hold of holds) {
        const config = buildConfig({ ...args, hold: String(hold), horizon: String(horizon) });
        const results: SimResult[] = [];
        for (const design of ALL_DESIGNS) {
          const r = runDesign(design, config, args);
          r.designName = `${design} (D=${hold}, t=${horizon})`;
          results.push(r);
          allResults.push(r);
        }
        console.log(formatComparison(results));
      }
    }
    console.log(formatStabilityAnalysis(allResults));
    console.log(formatLagAnalysis(allResults));
    return;
  }

  // Compare-holds mode.
  if (args["compare-holds"]) {
    const results: SimResult[] = [];
    for (const hold of [0, 2]) {
      const config = buildConfig({ ...args, hold: String(hold) });
      for (const design of ALL_DESIGNS) {
        const r = runDesign(design, config, args);
        r.designName = `${design} (D=${hold})`;
        results.push(r);
      }
    }
    console.log(formatComparison(results));
    console.log(formatStabilityAnalysis(results));
    console.log(formatLagAnalysis(results));
    return;
  }

  // Compare-horizons mode.
  if (args["compare-horizons"]) {
    const results: SimResult[] = [];
    for (const horizon of [120, 300]) {
      const config = buildConfig({ ...args, horizon: String(horizon) });
      for (const design of ALL_DESIGNS) {
        const r = runDesign(design, config, args);
        r.designName = `${design} (t=${horizon})`;
        results.push(r);
      }
    }
    console.log(formatComparison(results));
    console.log(formatStabilityAnalysis(results));
    console.log(formatLagAnalysis(results));
    return;
  }

  // Standard single or multi-design run.
  const designArg = typeof args.design === "string" ? args.design : "all";
  const designs = designArg === "all" ? ALL_DESIGNS : [designArg];
  const config = buildConfig(args);
  const results: SimResult[] = [];

  for (const design of designs) {
    const r = runDesign(design, config, args);
    results.push(r);

    if (args.json) {
      console.log(JSON.stringify(r, null, 2));
    } else {
      console.log(formatMetricsTable(r));
      if (args.timeline) {
        const limit =
          typeof args["timeline-limit"] === "string" ? Number(args["timeline-limit"]) : 50;
        console.log(formatEventTimeline(r, limit));
      }
    }
  }

  if (!args.json && results.length > 1) {
    console.log(formatComparison(results));
    console.log(formatStabilityAnalysis(results));
    console.log(formatLagAnalysis(results));
  }
}

main();
