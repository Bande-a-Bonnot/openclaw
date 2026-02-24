# Root Cause Analysis: Multi-Agent Queue Instability

## 1. Problem Statement

When multiple AI agents operate in the same OpenClaw conversation, the system becomes unstable: pending run tasks grow unboundedly over time, agents fall progressively further behind the information horizon, and the conversation eventually stalls or exhibits degraded behavior. This manifests as:

- Backlog of 80+ pending run tasks after 5 minutes of operation (3 agents)
- Agent reply lag growing to 200+ time units (agent replies to information that is minutes stale)
- Queue drops as bounded queues overflow
- Effective throughput no different than stable alternatives, but with massive hidden backlog

The instability scales with agent count and conversation duration: more agents and longer conversations make it worse, with no self-correcting mechanism.

## 2. Architecture Overview

OpenClaw's queue system has three layers:

```
Layer 1: Followup Queue (per-session, in-memory)
  └─ Bounded by cap (default 20) + drop policy (old/new/summarize)
  └─ Modes: collect (batch), steer (one-at-a-time)

Layer 2: Command Lane (per-lane serialization)
  └─ Lanes: Main, Cron, Subagent, Nested
  └─ Each lane has its own queue + max concurrency

Layer 3: Conversation Concurrency Cap
  └─ Global cap across all lanes for one conversation
  └─ Default: 2 concurrent runs
```

When a message arrives for an agent, the system decides:

- If the agent is **idle**: bypass the followup queue, start a run immediately
- If the agent is **busy**: enqueue in the followup queue

When a run completes, the system drains the followup queue and schedules the next run.

## 3. Root Cause

### The Idle Race (`agent-runner.ts:238`)

The critical code path:

```typescript
// agent-runner.ts, line ~238
if (isActive && (shouldFollowup || resolvedQueue.mode === "steer")) {
  enqueueFollowupRun(queueKey, followupRun, resolvedQueue);
  await touchActiveSessionEntry();
  typing.cleanup();
  return undefined;
}
// If we reach here, agent is idle → start run immediately
```

`isActive` is checked once at the top of the handler. If the agent is idle when a message arrives, the message **bypasses the followup queue entirely** and materializes directly as a run task in the outer command lane scheduler.

### Why This Causes Instability

In a multi-agent conversation:

1. Agent A completes a run and emits a reply to peers B and C
2. The delivery delay means messages arrive at B and C nearly simultaneously
3. If B or C happens to be idle at that moment, the arriving message bypasses the queue and creates a new run task directly
4. When B finishes its run, it emits to A and C — same pattern repeats
5. Each emit creates N-1 messages (one per peer), each potentially creating a separate run task

The key insight: **once a message materializes as a run task in the command lane scheduler, it cannot be retroactively coalesced with other run tasks for the same agent**. So if 2 messages arrive while an agent is idle, they create 2 separate run tasks instead of being batched into 1.

This is a **positive feedback loop**:

```
more agents → more emits per round
           → more messages arriving at idle agents
           → more materialized run tasks (bypassing queue)
           → pending run backlog grows
           → agents take longer to process
           → but idle windows still exist between runs
           → cycle continues, backlog grows linearly
```

### The Coalescing Gap

Even when messages do enter the followup queue (agent is busy), the collect mode batches them locally. But when the drain fires and schedules a new run, that run enters the command lane as a single task. If another drain fires before the first run starts, it creates a **second** task. The command lane scheduler has no mechanism to merge these.

## 4. Evidence

### Simulation Results

We built a discrete-event simulation that faithfully models the three-layer architecture. Configuration: 3 agents (run durations 4, 5, 6), concurrency cap 2, collect mode.

#### Pending run growth (D=0, no post-emit hold)

| Time  | Current System | Mailbox | Coalescing | Credit |
| ----- | -------------- | ------- | ---------- | ------ |
| t=30  | 4              | 1       | 3          | 1      |
| t=60  | 13             | 1       | 3          | 0      |
| t=120 | 31             | 1       | 2          | 0      |
| t=180 | 47             | 1       | 3          | 0      |
| t=240 | 64             | 1       | 3          | 0      |
| t=300 | **81**         | **1**   | **2**      | **1**  |

The current system's pending runs grow linearly without bound. All alternatives stay bounded.

#### Event-horizon lag (D=0, t=300)

"Lag" = time from when the earliest triggering message arrived to when the agent emits its reply. This measures how far behind the agent is from current information.

| Design     | Mean Lag | Max Lag | Trend             |
| ---------- | -------- | ------- | ----------------- |
| Current    | 28.9     | **234** | GROWING (agent A) |
| Mailbox    | 13.5     | 17      | STABLE            |
| Coalescing | 13.5     | 17      | STABLE            |
| Credit     | 12.5     | 27      | STABLE            |

In the current system, agent A's lag spikes to **234 time units** — meaning it's replying to information from nearly 4 minutes ago. This lag grows with every cycle and never recovers.

#### Idle race observed in event log

At t=5, agent B completes a run and becomes idle. A peer message arrives at t=5 and is immediately converted to a run (no `enqueue_followup` event). Meanwhile, a message arriving at busy agent C at the same time enters the followup queue properly. This confirms the idle bypass path.

### Band-Aid Analysis: Post-Emit Hold (D=2)

The `postEmitHold` parameter (D) delays agent availability after emitting. At D=2, t=120:

| Mode         | Pending Runs       |
| ------------ | ------------------ |
| collect, D=0 | 31 (unstable)      |
| collect, D=2 | 2 (appears stable) |
| steer, D=0   | 31 (unstable)      |
| steer, D=2   | **33** (worse)     |

D=2 accidentally helps in collect mode by serializing agents enough to prevent the feedback loop. But it fails in steer mode and is a parameter-dependent band-aid that doesn't address the root cause. It also adds unnecessary latency to all replies.

## 5. Impact Assessment

### Who is affected?

| Setup                                | Affected?      | Why                                       |
| ------------------------------------ | -------------- | ----------------------------------------- |
| Single agent, single conversation    | **No**         | No peers to create feedback loop          |
| Single agent, multiple conversations | **No**         | No cross-conversation messaging           |
| 2 agents, same conversation          | **Yes**        | Peer emits create feedback loop           |
| 3+ agents, same conversation         | **Yes, worse** | More peers = more messages per emit round |

### Severity

- **Conversations with 2+ agents** will accumulate unbounded backlog over time
- Agent replies become progressively staler (lag grows linearly)
- The system wastes resources processing a growing queue of run tasks that will be superseded by newer information
- Users perceive agents as "slow" or "confused" because they're responding to stale context

### Not affected

- **Single-agent setups are completely unaffected.** A Pi bot serving multiple 1:1 conversations, even with a shared concurrency cap, does not trigger the feedback loop. The instability requires peer-to-peer messaging within a conversation.

## 6. Contributing Factors

1. **No atomic check-and-enqueue**: The `isActive` check and the subsequent action (bypass vs enqueue) are not atomic. Between the check and the action, the state can change.

2. **Layer separation prevents retroactive coalescing**: Once a run task enters the command lane, it's opaque to the followup queue layer. Two run tasks for the same agent in the command lane cannot be merged.

3. **N-1 fan-out per emit**: Each agent emits to all peers. With 3 agents, each emit creates 2 messages. With 5 agents, each emit creates 4. The fan-out amplifies the idle race.

4. **No backpressure signal**: The command lane's growing backlog doesn't signal upstream to slow down message processing. Agents keep emitting at full speed regardless of the backlog.

## 7. Timeline

- The idle race has existed since the followup queue was introduced
- It was masked in single-agent deployments (the common case)
- Multi-agent conversations exposed it as a critical stability issue
- The `postEmitHold` parameter was added as a mitigation but only works incidentally in collect mode
