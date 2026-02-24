# Queue Stability Analysis

Root cause analysis and proposed solutions for OpenClaw's multi-agent queue instability.

## Contents

| File                                             | Description                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| [ROOT-CAUSE-ANALYSIS.md](ROOT-CAUSE-ANALYSIS.md) | Full RCA: problem statement, investigation, root cause, evidence, and impact    |
| [SOLUTIONS.md](SOLUTIONS.md)                     | Three proposed solutions with pros/cons, simulation results, and recommendation |
| [sim/](sim/)                                     | Simulation scripts (discrete-event simulator, CLI, tests)                       |

## Quick Start

Run all simulations and see the comparison:

```bash
npx tsx docs/queue-stability/sim/cli.ts --design all --horizon 300
```

Run the full parameter sweep (D x horizon x design):

```bash
npx tsx docs/queue-stability/sim/cli.ts --sweep
```

Run tests (26 tests covering stability, lag, single-agent, multi-conversation):

```bash
npx tsx docs/queue-stability/sim/sim-engine.test.ts
```

## CLI Reference

```
npx tsx docs/queue-stability/sim/cli.ts [options]

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
```

## Key Finding

The instability only manifests in **multi-agent conversations** (2+ agents in the same conversation that emit replies to each other). Single-agent setups — including one bot serving multiple conversations with a shared concurrency cap — are unaffected. See [SOLUTIONS.md](SOLUTIONS.md) for details.
