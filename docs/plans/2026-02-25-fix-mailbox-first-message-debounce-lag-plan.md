---
title: "Fix mailbox first-message debounce lag"
type: fix
date: 2026-02-25
---

# Fix mailbox first-message debounce lag

## Overview

The mailbox actor pattern (feat/mailbox-actor-queue) introduced ~1s latency on the first message to an idle agent. Before the change, idle agents started runs immediately (bypassing the queue). Now all messages enter the queue and go through `waitForQueueDebounce`, which adds up to `DEFAULT_QUEUE_DEBOUNCE_MS` (1000ms) even when there's nothing to coalesce with.

## Problem Statement

In the conversation log (`channel-1475971813698834439-raw-20260225T055643Z.jsonl`), users observed that the mailbox branch introduced noticeable response delay. The root cause is `waitForQueueDebounce(queue)` at `drain.ts:28` — it fires on every drain loop iteration, including the very first drain of a fresh queue where debounce serves no purpose.

The debounce's purpose is to coalesce rapid successive messages into a single run. When the first message arrives to an idle agent, there are no subsequent messages to wait for — the debounce just adds dead time.

## Proposed Solution

Skip the debounce on the **first iteration** of a fresh drain. The debounce only has value when messages are still arriving (subsequent iterations). Two approaches:

### Approach A: Track drain iteration in drain.ts (minimal change)

Add a `firstIteration` flag in `scheduleFollowupDrain`. Skip `waitForQueueDebounce` on the first pass.

### Approach B: Use `lastEnqueuedAt` as signal (zero new state)

The debounce in `waitForQueueDebounce` checks `Date.now() - queue.lastEnqueuedAt >= debounceMs`. If the queue was just created and the message was just enqueued, `lastEnqueuedAt` is essentially `Date.now()`, so the debounce will wait the full interval. We could instead check if this is the first drain (queue was not previously draining) and skip debounce.

**Chosen: Approach A** — clearest intent, no risk of side effects.

## Implementation

### Step 1: Skip debounce on first drain iteration

**File:** `src/auto-reply/reply/queue/drain.ts:26-28`

Current code (lines 26-28):

```typescript
      const collectState = { forceIndividualCollect: false };
      while (queue.items.length > 0 || queue.droppedCount > 0) {
        await waitForQueueDebounce(queue);
```

Changed to:

```typescript
      const collectState = { forceIndividualCollect: false };
      let isFirstDrainPass = true;
      while (queue.items.length > 0 || queue.droppedCount > 0) {
        if (!isFirstDrainPass) {
          await waitForQueueDebounce(queue);
        }
        isFirstDrainPass = false;
```

This preserves debounce for all subsequent iterations (coalescing still works for rapid successive messages) while eliminating the dead wait on the very first drain.

### Step 2: Update tests

**File:** `src/auto-reply/reply/agent-runner.mailbox.test.ts`

Add a test verifying that the first message to an idle agent doesn't incur debounce delay. The test should:

1. Enqueue a single message to a fresh queue with a real (non-zero) debounce
2. Verify `runFollowup` is called without waiting for debounce
3. Confirm debounce still applies on a second iteration

### Step 3: Run tests

```bash
pnpm test src/auto-reply/reply/ src/utils/queue-helpers.test.ts
```

## Acceptance Criteria

- [ ] First message to idle agent processes without debounce delay
- [ ] Subsequent messages in a drain cycle still debounce (coalescing preserved)
- [ ] Existing tests pass
- [ ] Simulation tests still pass

## Files Touched

| File                                                | Change                            |
| --------------------------------------------------- | --------------------------------- |
| `src/auto-reply/reply/queue/drain.ts`               | Skip debounce on first drain pass |
| `src/auto-reply/reply/agent-runner.mailbox.test.ts` | Test for no first-message lag     |

## Risks

- **None significant**: the debounce is only skipped for the first iteration; all subsequent coalescing behavior is preserved.
