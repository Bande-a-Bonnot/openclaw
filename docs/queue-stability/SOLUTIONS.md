# Proposed Solutions

Three alternative queue designs that eliminate the instability described in [ROOT-CAUSE-ANALYSIS.md](ROOT-CAUSE-ANALYSIS.md). Each was simulated with a deterministic discrete-event simulator across multiple parameter configurations.

All simulation code is in [sim/](sim/). Run `npx tsx docs/queue-stability/sim/cli.ts --design all --horizon 300` to reproduce the results below.

---

## Simulation Baseline

**Configuration**: 3 agents (A=4, B=5, C=6 run duration), concurrency cap 2, collect mode, queue cap 20, D=0, t=300.

**Current system results** (the problem):

| Metric                 | Value                      |
| ---------------------- | -------------------------- |
| Pending runs at t=300  | 81 (growing linearly)      |
| Mean event-horizon lag | 28.9                       |
| Max event-horizon lag  | 234 (agent A)              |
| Lag trend              | GROWING for agents A and B |
| Total emits            | 101                        |

---

## Design A: Mailbox Actor (Recommended)

### Concept

Each session has exactly one mailbox. Messages **always** enter the mailbox first — there is no bypass path. When the mailbox transitions from empty to non-empty and no run is active, schedule exactly one "runnable token" in the outer scheduler. When a run starts, drain the entire mailbox (coalesce). When a run completes, if new messages accumulated during the run, schedule one new token.

```
Message arrives → Mailbox (always)
                    ↓
              Mailbox empty→non-empty AND no active run AND no token?
                    ↓ yes
              Schedule 1 token in command lane
                    ↓
              Token fires → drain mailbox → start run
                    ↓
              Run completes → check mailbox → schedule token if non-empty
```

### Key Change

Remove the `isActive` bypass in `agent-runner.ts`. Add `hasToken: boolean` to `FollowupQueueState`. Messages always enter the queue. The `scheduleToken` function is the single gatekeeper.

### Simulation Results

| Metric               | Current | Mailbox    | Delta |
| -------------------- | ------- | ---------- | ----- |
| Pending runs (t=300) | 81      | **1**      | -99%  |
| Mean lag             | 28.9    | **13.5**   | -53%  |
| Max lag              | 234     | **17**     | -93%  |
| Lag trend            | GROWING | **STABLE** | Fixed |
| Total emits          | 101     | 100        | -1%   |
| Total runs           | 101     | 100        | -1%   |

#### Lag Evolution (t=300, D=0)

- Agent A: trend=STABLE, oscillates between 11 and 15 (was: spikes to 234)
- Agent B: trend=STABLE, oscillates between 12 and 16 (was: spikes to 108)
- Agent C: trend=STABLE, oscillates between 13 and 17 (was: stable at 11, unaffected)

### Single-Agent Impact

**No impact.** Single-agent setups (with or without shared concurrency cap across conversations) produce identical throughput and behavior to the current system. The mailbox path is the same as the current "agent is busy" path — it just also handles the "agent is idle" case.

Verified by simulation:

- Single agent, no peers: 1 run completed, 0 pending (same as current)
- Two conversations sharing cap=1, no cross-emit: ≤2 pending (same as current), throughput identical

### Pros

- **Smallest change**: ~200 LOC across 2 PRs
- **Provably eliminates the idle race**: messages can never bypass the queue
- **Bounded pending runs**: at most 1 token per agent in the scheduler at any time
- **Stable lag**: never grows over time, oscillates within a bounded range
- **Throughput preserved**: 99% of current system throughput
- **Preserves existing semantics**: collect/steer modes work unchanged
- **Actor model is well-understood**: easy to reason about correctness, well-documented pattern
- **Zero impact on single-agent setups**: identical behavior for the common case

### Cons

- Adds one hop of indirection (message → mailbox → token → run): ~1 debounce interval of added latency to the very first message for an idle agent
- Doesn't address the cross-layer coalescing gap (runs in the command lane still can't merge after materialization)
- Still relies on existing command lane infrastructure

---

## Design B: Coalescing Scheduler

### Concept

Replace the multi-layer queue (followup queue + command lane) with a single conversation-scoped scheduler. The scheduler maintains a table: at most one entry per agent. When a message arrives, it either creates a new entry or appends to an existing one (coalesce). No separate followup queue or command lane — one unified structure.

```
Message arrives → Scheduler table
                    ↓
              Entry for agent exists?
              ├─ yes → append message to entry (coalesce)
              └─ no  → create entry, schedule drain
                    ↓
              Drain: pick highest-priority entry, start run
                    ↓
              Run completes → if entry accumulated new messages, re-drain
```

### Simulation Results

| Metric               | Current | Coalescing | Delta |
| -------------------- | ------- | ---------- | ----- |
| Pending runs (t=300) | 81      | **2**      | -98%  |
| Mean lag             | 28.9    | **13.5**   | -53%  |
| Max lag              | 234     | **17**     | -93%  |
| Lag trend            | GROWING | **STABLE** | Fixed |
| Total emits          | 101     | 100        | -1%   |

#### Lag Evolution (t=300, D=0)

- Agent A: trend=STABLE, oscillates between 11 and 15
- Agent B: trend=STABLE, oscillates between 12 and 16
- Agent C: trend=STABLE, oscillates between 13 and 17

### Single-Agent Impact

**No impact.** Identical throughput and behavior to current system in single-agent setups.

### Pros

- **Eliminates both the idle race AND the cross-layer coalescing gap**: the single scheduler is the only path
- **Simplest mental model**: one table, one entry per agent, append or create
- **Naturally prevents all forms of run-task fanout**
- **Maximum pending entries = agent count** (mathematical invariant)
- Same lag and throughput as mailbox

### Cons

- **Largest refactor**: ~700 LOC across 3-4 PRs
- Replaces both the followup queue and command lane integration
- **Risk of touching hot paths** that other contributors depend on
- **Higher review burden** for an open-source project with limited human bandwidth
- Could conflict with in-progress PRs from other contributors

---

## Design C: Credit-based Flow Control (Token Bucket)

### Concept

Each agent gets N reply credits per time window. Emitting a reply costs 1 credit. When credits are exhausted, messages buffer until credits refill at a fixed interval. This caps total output rate regardless of topology.

```
Message arrives → Buffer (always)
                    ↓
              Agent idle AND has credits?
              ├─ yes → start run
              └─ no  → wait for credit refill
                    ↓
              Run completes → has credits?
              ├─ yes → emit to peers, consume 1 credit
              └─ no  → suppress emit (backpressure)
```

### Simulation Results

| Metric               | Current | Credit     | Delta   |
| -------------------- | ------- | ---------- | ------- |
| Pending runs (t=300) | 81      | **1**      | -99%    |
| Mean lag             | 28.9    | **12.5**   | -57%    |
| Max lag              | 234     | **27**     | -88%    |
| Lag trend            | GROWING | **STABLE** | Fixed   |
| Total emits          | 101     | 95         | **-6%** |

#### Lag Evolution (t=300, D=0)

- Agent A: trend=STABLE, settles to oscillating between 13-14
- Agent B: trend=STABLE, oscillates between 10-14
- Agent C: trend=STABLE, oscillates between 12-15 (one early spike to 27)

### Single-Agent Impact

**Minimal impact.** Single-agent setups are stable. Credit refill is generous enough that a single agent in a 1:1 conversation never hits the limit. However, the credit mechanism adds a small overhead to each reply cycle.

### Pros

- **Hard ceiling on system output rate**: good for cost/resource management
- **Effective as a supplementary layer** on top of mailbox or coalescing scheduler
- **Simple to tune**: credits per agent, refill interval
- **Prevents runaway conversations** even in pathological topologies

### Cons

- **Doesn't fix the idle race**: it just makes the race's impact bounded by the credit budget
- **Adds latency to all replies**, including legitimate ones (credit exhaustion delays even valid responses)
- **6% throughput reduction** vs other designs
- **Higher max lag spike** (27 vs 17) due to credit exhaustion buffering
- **Configuration complexity**: wrong parameters degrade UX significantly (too low = unresponsive, too high = no protection)

---

## Head-to-Head Comparison

### Stability and Performance (D=0, t=300, 3 agents)

|              | Current      | Mailbox | Coalescing | Credit   |
| ------------ | ------------ | ------- | ---------- | -------- |
| Pending runs | 81           | **1**   | 2          | **1**    |
| Mean lag     | 28.9         | 13.5    | 13.5       | **12.5** |
| Max lag      | 234          | **17**  | **17**     | 27       |
| Total emits  | 101          | 100     | 100        | 95       |
| Lag trend    | GROWING      | STABLE  | STABLE     | STABLE   |
| Stability    | **UNSTABLE** | STABLE  | STABLE     | STABLE   |

### Implementation Cost

|                       | Mailbox | Coalescing  | Credit         |
| --------------------- | ------- | ----------- | -------------- |
| LOC changed           | ~200    | ~700        | ~350           |
| PRs needed            | 2       | 3-4         | 2              |
| Files touched         | 3-4     | 8-10        | 4-5            |
| Fixes root cause      | Yes     | Yes         | No (bounds it) |
| Risk to existing code | Low     | Medium-High | Low            |

### Impact on Single-Agent Setups

|                                  | Current | Mailbox     | Coalescing  | Credit           |
| -------------------------------- | ------- | ----------- | ----------- | ---------------- |
| 1 agent, 1 conversation          | Stable  | Stable      | Stable      | Stable           |
| 1 agent, 2 conversations (cap=1) | Stable  | Stable      | Stable      | Stable           |
| Throughput change                | -       | 0%          | 0%          | 0%               |
| Added latency                    | -       | ~1 debounce | ~1 debounce | credit-dependent |

**All designs are fully backwards-compatible with single-agent setups.** No throughput degradation, no behavior change, no configuration required.

### Parameter Sensitivity

| Configuration | Current                   | Mailbox | Coalescing | Credit |
| ------------- | ------------------------- | ------- | ---------- | ------ |
| D=0, collect  | UNSTABLE                  | STABLE  | STABLE     | STABLE |
| D=2, collect  | Appears stable            | STABLE  | STABLE     | STABLE |
| D=0, steer    | UNSTABLE                  | STABLE  | STABLE     | STABLE |
| D=2, steer    | **UNSTABLE** (33 pending) | STABLE  | STABLE     | STABLE |

The current system's stability depends on parameter choice (D=2 in collect mode only). All alternatives are stable regardless of parameter configuration.

---

## Recommendation

### Ship Design A (Mailbox) first.

It is the smallest surgical fix (~200 LOC, 2 PRs) that provably eliminates the root cause. It produces identical throughput and the same bounded lag as the more ambitious redesign, with a fraction of the risk for an active open-source codebase under heavy contribution load with limited human review bandwidth.

### Consider Design C (Credit Flow) as a supplementary safety net.

It provides a hard ceiling on output rate that's valuable for resource management, independent of the mailbox fix. Can be layered on top.

### Defer Design B (Coalescing Scheduler) to a future milestone.

It's the cleanest long-term architecture but the refactor scope (700 LOC, 3-4 PRs, 8-10 files) is inappropriate for the current project velocity. The mailbox design achieves the same stability and lag outcomes with 3.5x less code change.
