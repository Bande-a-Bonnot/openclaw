/**
 * Tests for the mailbox actor pattern: messages ALWAYS enter the followup queue,
 * regardless of whether a run is currently active. This eliminates the idle race
 * that causes unbounded backlog growth in multi-agent conversations.
 *
 * See: docs/queue-stability/SOLUTIONS.md (Design A: Mailbox Actor)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { createMockTypingController } from "./test-helpers.js";

const state = vi.hoisted(() => ({
  runEmbeddedPiAgentMock: vi.fn(),
}));

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: async ({
    provider,
    model,
    run,
  }: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => ({
    result: await run(provider, model),
    provider,
    model,
    attempts: [],
  }),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: (params: unknown) => state.runEmbeddedPiAgentMock(params),
}));

vi.mock("../../agents/cli-runner.js", () => ({
  runCliAgent: vi.fn(),
}));

const enqueueFollowupRunMock = vi.fn().mockReturnValue(true);
const scheduleFollowupDrainMock = vi.fn();

vi.mock("./queue.js", () => ({
  enqueueFollowupRun: (...args: unknown[]) => enqueueFollowupRunMock(...args),
  scheduleFollowupDrain: (...args: unknown[]) => scheduleFollowupDrainMock(...args),
}));

function createMailboxTestParams(overrides?: {
  isActive?: boolean;
  shouldFollowup?: boolean;
  queueMode?: string;
}) {
  const typing = createMockTypingController();
  const sessionCtx = {
    Provider: "whatsapp",
    OriginatingTo: "+15550001111",
    AccountId: "primary",
    MessageSid: "msg-1",
  } as unknown as TemplateContext;

  const resolvedQueue = {
    mode: overrides?.queueMode ?? "collect",
  } as unknown as QueueSettings;

  const followupRun = {
    prompt: "hello from peer agent",
    enqueuedAt: Date.now(),
    run: {
      sessionId: "session-1",
      sessionKey: "key-1",
      config: {},
      provider: "anthropic",
      model: "claude-opus-4-5",
      bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
  } as unknown as FollowupRun;

  return {
    commandBody: "hello from peer",
    followupRun,
    queueKey: "session-1",
    resolvedQueue,
    shouldSteer: false,
    shouldFollowup: overrides?.shouldFollowup ?? true,
    isActive: overrides?.isActive ?? false,
    isStreaming: false,
    opts: undefined,
    typing,
    sessionCtx,
    defaultModel: "anthropic/claude-opus-4-5",
    resolvedVerboseLevel: "off" as const,
    isNewSession: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end" as const,
    shouldInjectGroupIntro: false,
    typingMode: "instant" as const,
  };
}

describe("mailbox actor pattern", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "reply" }],
      meta: {},
    });
  });

  it("enqueues message when agent is idle (no bypass)", async () => {
    const { runReplyAgent } = await import("./agent-runner.js");
    const params = createMailboxTestParams({ isActive: false, shouldFollowup: true });

    const result = await runReplyAgent(params);

    expect(result).toBeUndefined();
    expect(enqueueFollowupRunMock).toHaveBeenCalledOnce();
    expect(scheduleFollowupDrainMock).toHaveBeenCalledOnce();
    // Should NOT have started a direct run — message goes through queue.
    expect(state.runEmbeddedPiAgentMock).not.toHaveBeenCalled();
  });

  it("enqueues message when agent is active", async () => {
    const { runReplyAgent } = await import("./agent-runner.js");
    const params = createMailboxTestParams({ isActive: true, shouldFollowup: true });

    const result = await runReplyAgent(params);

    expect(result).toBeUndefined();
    expect(enqueueFollowupRunMock).toHaveBeenCalledOnce();
    expect(scheduleFollowupDrainMock).toHaveBeenCalledOnce();
    expect(state.runEmbeddedPiAgentMock).not.toHaveBeenCalled();
  });

  it("enqueues message in steer mode regardless of active state", async () => {
    const { runReplyAgent } = await import("./agent-runner.js");
    const params = createMailboxTestParams({
      isActive: false,
      shouldFollowup: false,
      queueMode: "steer",
    });

    const result = await runReplyAgent(params);

    expect(result).toBeUndefined();
    expect(enqueueFollowupRunMock).toHaveBeenCalledOnce();
    expect(scheduleFollowupDrainMock).toHaveBeenCalledOnce();
  });

  it("scheduleFollowupDrain receives the followup runner", async () => {
    const { runReplyAgent } = await import("./agent-runner.js");
    const params = createMailboxTestParams({ isActive: false, shouldFollowup: true });

    await runReplyAgent(params);

    // The second argument to scheduleFollowupDrain should be a function
    // (the followup runner created by createFollowupRunner).
    const drainArgs = scheduleFollowupDrainMock.mock.calls[0];
    expect(drainArgs[0]).toBe("session-1");
    expect(typeof drainArgs[1]).toBe("function");
  });

  it("does not enqueue when shouldFollowup is false and mode is not steer", async () => {
    const { runReplyAgent } = await import("./agent-runner.js");
    const params = createMailboxTestParams({
      isActive: false,
      shouldFollowup: false,
      queueMode: "interrupt",
    });

    await runReplyAgent(params);

    // Should fall through to direct run (no enqueue).
    expect(enqueueFollowupRunMock).not.toHaveBeenCalled();
    // Direct run should proceed.
    expect(state.runEmbeddedPiAgentMock).toHaveBeenCalled();
    // Note: scheduleFollowupDrain IS called at the end of the run
    // via finalizeWithFollowup — that's expected and correct.
  });

  it("cleans up typing on enqueue path", async () => {
    const { runReplyAgent } = await import("./agent-runner.js");
    const params = createMailboxTestParams({ isActive: false, shouldFollowup: true });

    await runReplyAgent(params);

    expect(params.typing.cleanup).toHaveBeenCalled();
  });
});
