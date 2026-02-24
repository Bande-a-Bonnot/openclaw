/**
 * Reporting utilities for simulation results.
 * Produces tables, comparisons, and event timelines.
 */

import type { SimResult } from "./types.js";

function pad(s: string, len: number): string {
  return s.padEnd(len);
}

function rpad(s: string, len: number): string {
  return s.padStart(len);
}

export function formatMetricsTable(result: SimResult): string {
  const lines: string[] = [];
  lines.push(`\n=== ${result.designName.toUpperCase()} ===`);
  lines.push(
    `Config: agents=${Object.keys(result.config.agents).join(",")}, ` +
      `cap=${result.config.concurrencyCap}, queueMode=${result.config.queueMode}, ` +
      `queueCap=${result.config.queueCap}, D=${result.config.postEmitHold}, ` +
      `E=${result.config.deliveryDelay}, horizon=${result.config.horizon}`,
  );
  lines.push("");

  const header = [
    rpad("t", 6),
    rpad("emits", 7),
    rpad("runs", 6),
    rpad("pend", 6),
    rpad("active", 7),
    pad("meanLag", 20),
    pad("maxLag", 20),
    pad("queueByAgent", 24),
  ].join(" | ");
  lines.push(header);
  lines.push("-".repeat(header.length));

  for (const m of result.metrics) {
    const mla =
      Object.entries(m.meanLagByAgent ?? {})
        .map(([k, v]) => `${k}:${v}`)
        .join(" ") || "-";
    const xla =
      Object.entries(m.maxLagByAgent ?? {})
        .map(([k, v]) => `${k}:${v}`)
        .join(" ") || "-";
    const qba =
      Object.entries(m.queueDepthByAgent)
        .map(([k, v]) => `${k}:${v}`)
        .join(" ") || "-";
    lines.push(
      [
        rpad(String(m.time), 6),
        rpad(String(m.totalEmits), 7),
        rpad(String(m.totalRuns), 6),
        rpad(String(m.pendingRuns), 6),
        rpad(String(m.activeRuns), 7),
        pad(mla, 20),
        pad(xla, 20),
        pad(qba, 24),
      ].join(" | "),
    );
  }

  return lines.join("\n");
}

export function formatComparison(results: SimResult[]): string {
  const lines: string[] = [];
  lines.push("\n╔══════════════════════════════════════════════════════════════╗");
  lines.push("║                   COMPARISON SUMMARY                        ║");
  lines.push("╚══════════════════════════════════════════════════════════════╝");
  lines.push("");

  const header = [
    pad("Design", 24),
    rpad("Emits", 7),
    rpad("Runs", 6),
    rpad("PendRuns", 10),
    rpad("MeanLag", 9),
    rpad("MaxLag", 8),
    rpad("Drops", 7),
  ].join(" | ");
  lines.push(header);
  lines.push("=".repeat(header.length));

  for (const r of results) {
    const fm = r.finalMetrics;
    const totalDrops = Object.values(fm.droppedByAgent).reduce((a, b) => a + b, 0);
    // Compute overall mean/max lag from samples.
    const samples = r.lagSamples ?? [];
    const overallMeanLag =
      samples.length > 0
        ? Math.round((samples.reduce((a, s) => a + s.lag, 0) / samples.length) * 100) / 100
        : 0;
    const overallMaxLag = samples.length > 0 ? Math.max(...samples.map((s) => s.lag)) : 0;
    lines.push(
      [
        pad(r.designName, 24),
        rpad(String(fm.totalEmits), 7),
        rpad(String(fm.totalRuns), 6),
        rpad(String(fm.pendingRuns), 10),
        rpad(String(overallMeanLag), 9),
        rpad(String(overallMaxLag), 8),
        rpad(String(totalDrops), 7),
      ].join(" | "),
    );
  }

  return lines.join("\n");
}

export function formatEventTimeline(result: SimResult, maxEvents = 50): string {
  const lines: string[] = [];
  lines.push(`\n--- Event Timeline: ${result.designName} (first ${maxEvents}) ---`);

  const events = result.eventLog.slice(0, maxEvents);
  for (const e of events) {
    const parts = [`t=${rpad(String(e.time), 4)}`, pad(e.type, 20), `agent=${e.agent}`];
    if (e.payload) {
      parts.push(`payload=${e.payload}`);
    }
    if (e.target) {
      parts.push(`target=${e.target}`);
    }
    lines.push(parts.join("  "));
  }

  if (result.eventLog.length > maxEvents) {
    lines.push(`... (${result.eventLog.length - maxEvents} more events)`);
  }

  return lines.join("\n");
}

export function formatLagAnalysis(results: SimResult[]): string {
  const lines: string[] = [];
  lines.push("\n╔══════════════════════════════════════════════════════════════╗");
  lines.push("║              EVENT-HORIZON LAG ANALYSIS                     ║");
  lines.push("╚══════════════════════════════════════════════════════════════╝");
  lines.push("");
  lines.push("Lag = time from earliest triggering message to agent's emit reply.");
  lines.push("Trend: GROWING = agent falls further behind over time.");
  lines.push("       STABLE  = lag stays bounded.");
  lines.push("       SHRINK  = lag decreases (catching up).");
  lines.push("");

  for (const r of results) {
    lines.push(`── ${r.designName} ──`);
    const samples = r.lagSamples ?? [];
    if (samples.length === 0) {
      lines.push("  No lag samples recorded.\n");
      continue;
    }

    // Group by agent.
    const agentIds = [...new Set(samples.map((s) => s.agent))].toSorted();
    for (const agentId of agentIds) {
      const agentSamples = samples.filter((s) => s.agent === agentId);
      const lags = agentSamples.map((s) => s.lag);
      const mean = Math.round((lags.reduce((a, b) => a + b, 0) / lags.length) * 100) / 100;
      const max = Math.max(...lags);
      const min = Math.min(...lags);

      // Determine trend: compare first-half average to second-half average.
      const half = Math.floor(lags.length / 2);
      let trend = "STABLE";
      if (lags.length >= 4) {
        const firstHalf = lags.slice(0, half);
        const secondHalf = lags.slice(half);
        const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
        const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
        const ratio = avgSecond / (avgFirst || 1);
        if (ratio > 1.3) {
          trend = "GROWING";
        } else if (ratio < 0.7) {
          trend = "SHRINK";
        }
      }

      // Show evolution: lag at each emit.
      const evolution = agentSamples.map((s) => `t=${s.emitTime}→${s.lag}`).join(", ");

      lines.push(
        `  Agent ${agentId}: trend=${trend}  mean=${mean}  max=${max}  min=${min}  samples=${lags.length}`,
      );
      lines.push(`    evolution: ${evolution}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function formatStabilityAnalysis(results: SimResult[]): string {
  const lines: string[] = [];
  lines.push("\n--- Stability Analysis ---");

  for (const r of results) {
    const pendingOverTime = r.metrics.map((m) => m.pendingRuns);
    const emitsOverTime = r.metrics.map((m) => m.totalEmits);

    // Check if pending runs are growing unboundedly.
    const isGrowing =
      pendingOverTime.length >= 3 &&
      pendingOverTime[pendingOverTime.length - 1] >
        pendingOverTime[Math.floor(pendingOverTime.length / 2)] &&
      pendingOverTime[Math.floor(pendingOverTime.length / 2)] > pendingOverTime[0];

    // Compute emit rate (emits per time unit in last half).
    const halfIdx = Math.floor(emitsOverTime.length / 2);
    const emitRateFirst = halfIdx > 0 ? emitsOverTime[halfIdx] / r.metrics[halfIdx].time : 0;
    const emitRateLast =
      emitsOverTime.length > halfIdx + 1
        ? (emitsOverTime[emitsOverTime.length - 1] - emitsOverTime[halfIdx]) /
          (r.metrics[r.metrics.length - 1].time - r.metrics[halfIdx].time)
        : 0;

    const maxPending = Math.max(...pendingOverTime, 0);
    const stability = isGrowing ? "UNSTABLE (growing backlog)" : "STABLE";

    lines.push(`\n  ${r.designName}:`);
    lines.push(`    Stability: ${stability}`);
    lines.push(`    Max pending runs: ${maxPending}`);
    lines.push(`    Emit rate (first half): ${emitRateFirst.toFixed(2)}/t`);
    lines.push(`    Emit rate (second half): ${emitRateLast.toFixed(2)}/t`);
    lines.push(`    Final emits: ${r.finalMetrics.totalEmits}`);
    lines.push(`    Final pending: ${r.finalMetrics.pendingRuns}`);
  }

  return lines.join("\n");
}
