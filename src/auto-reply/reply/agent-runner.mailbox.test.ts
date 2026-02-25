/**
 * Tests for the mailbox actor pattern: messages ALWAYS enter the followup queue,
 * regardless of whether a run is currently active. This eliminates the idle race
 * that causes unbounded backlog growth in multi-agent conversations.
 *
 * See: docs/queue-stability/SOLUTIONS.md (Design A: Mailbox Actor)
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

function createMailboxTestParams(overrides?: { shouldFollowup?: boolean; queueMode?: string }) {
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

let runReplyAgent: (typeof import("./agent-runner.js"))["runReplyAgent"];

describe("mailbox actor pattern", () => {
  beforeAll(async () => {
    ({ runReplyAgent } = await import("./agent-runner.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    state.runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "reply" }],
      meta: {},
    });
  });

  it("enqueues and schedules drain when shouldFollowup is true", async () => {
    const params = createMailboxTestParams({ shouldFollowup: true });

    const result = await runReplyAgent(params);

    expect(result).toBeUndefined();
    expect(enqueueFollowupRunMock).toHaveBeenCalledOnce();
    expect(scheduleFollowupDrainMock).toHaveBeenCalledOnce();
    // Should NOT have started a direct run — message goes through queue.
    expect(state.runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    // Typing should be cleaned up on the enqueue path.
    expect(params.typing.cleanup).toHaveBeenCalled();
  });

  it("enqueues message in steer mode", async () => {
    const params = createMailboxTestParams({
      shouldFollowup: false,
      queueMode: "steer",
    });

    const result = await runReplyAgent(params);

    expect(result).toBeUndefined();
    expect(enqueueFollowupRunMock).toHaveBeenCalledOnce();
    expect(scheduleFollowupDrainMock).toHaveBeenCalledOnce();
  });

  it("does not enqueue when shouldFollowup is false and mode is not steer", async () => {
    const params = createMailboxTestParams({
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
});
