import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONVERSATION_LANE_DRAIN_DELAY_MS,
  resolveConversationLaneDrainDelay,
} from "./agent-limits.js";
import { loadConfig } from "./config.js";
import { withTempHome } from "./test-helpers.js";
import { OpenClawSchema } from "./zod-schema.js";

describe("resolveConversationLaneDrainDelay (per-channel cascade)", () => {
  const globalDefault = DEFAULT_CONVERSATION_LANE_DRAIN_DELAY_MS;

  it("returns global default (0) when no config", () => {
    expect(resolveConversationLaneDrainDelay({})).toBe(globalDefault);
  });

  it("returns agent-level value when channel param is missing", () => {
    expect(
      resolveConversationLaneDrainDelay({
        cfg: { agents: { defaults: { conversationLaneDrainDelayMs: 500 } } },
      }),
    ).toBe(500);
  });

  it("accepts 0 as a valid drain delay", () => {
    expect(
      resolveConversationLaneDrainDelay({
        cfg: { agents: { defaults: { conversationLaneDrainDelayMs: 0 } } },
      }),
    ).toBe(0);
  });

  // --- Discord cascade: channel → guild → provider → global ---

  it("discord: resolves channel > guild > provider > global", () => {
    const cfg = {
      agents: { defaults: { conversationLaneDrainDelayMs: 100 } },
      channels: {
        discord: {
          conversationLaneDrainDelayMs: 200,
          guilds: {
            g1: {
              conversationLaneDrainDelayMs: 300,
              channels: {
                c1: { conversationLaneDrainDelayMs: 400 },
              },
            },
          },
        },
      },
    };
    expect(
      resolveConversationLaneDrainDelay({
        cfg,
        channel: "discord",
        groupSpace: "g1",
        peerId: "channel:c1",
      }),
    ).toBe(400);
  });

  it("discord: falls back to guild when channel not set", () => {
    const cfg = {
      channels: {
        discord: {
          conversationLaneDrainDelayMs: 200,
          guilds: {
            g1: {
              conversationLaneDrainDelayMs: 300,
              channels: { c1: {} },
            },
          },
        },
      },
    };
    expect(
      resolveConversationLaneDrainDelay({
        cfg,
        channel: "discord",
        groupSpace: "g1",
        peerId: "channel:c1",
      }),
    ).toBe(300);
  });

  it("discord: falls back to provider when guild not set", () => {
    const cfg = {
      channels: {
        discord: {
          conversationLaneDrainDelayMs: 200,
          guilds: { g1: { channels: { c1: {} } } },
        },
      },
    };
    expect(
      resolveConversationLaneDrainDelay({
        cfg,
        channel: "discord",
        groupSpace: "g1",
        peerId: "channel:c1",
      }),
    ).toBe(200);
  });

  it("discord: falls back to global when provider not set", () => {
    const cfg = {
      agents: { defaults: { conversationLaneDrainDelayMs: 500 } },
      channels: { discord: {} },
    };
    expect(
      resolveConversationLaneDrainDelay({
        cfg,
        channel: "discord",
        groupSpace: "g1",
        peerId: "channel:c1",
      }),
    ).toBe(500);
  });

  it("discord: channel override of 0 stops cascade", () => {
    const cfg = {
      agents: { defaults: { conversationLaneDrainDelayMs: 500 } },
      channels: {
        discord: {
          conversationLaneDrainDelayMs: 200,
          guilds: {
            g1: {
              conversationLaneDrainDelayMs: 300,
              channels: {
                c1: { conversationLaneDrainDelayMs: 0 },
              },
            },
          },
        },
      },
    };
    expect(
      resolveConversationLaneDrainDelay({
        cfg,
        channel: "discord",
        groupSpace: "g1",
        peerId: "channel:c1",
      }),
    ).toBe(0);
  });

  // --- Telegram cascade: group → provider → global ---

  it("telegram: resolves group > provider > global", () => {
    const cfg = {
      channels: {
        telegram: {
          conversationLaneDrainDelayMs: 200,
          groups: {
            "100123": { conversationLaneDrainDelayMs: 300 },
          },
        },
      },
    };
    expect(
      resolveConversationLaneDrainDelay({
        cfg,
        channel: "telegram",
        peerId: "group:100123",
      }),
    ).toBe(300);
  });

  it("telegram: falls back to provider when group not set", () => {
    const cfg = {
      channels: {
        telegram: {
          conversationLaneDrainDelayMs: 200,
          groups: { "100123": {} },
        },
      },
    };
    expect(
      resolveConversationLaneDrainDelay({
        cfg,
        channel: "telegram",
        peerId: "group:100123",
      }),
    ).toBe(200);
  });

  it("telegram: uses groupSpace when provided", () => {
    const cfg = {
      channels: {
        telegram: {
          groups: { "100123": { conversationLaneDrainDelayMs: 400 } },
        },
      },
    };
    expect(
      resolveConversationLaneDrainDelay({
        cfg,
        channel: "telegram",
        groupSpace: "100123",
        peerId: "user:999",
      }),
    ).toBe(400);
  });

  // --- Slack cascade: channel → provider → global ---

  it("slack: resolves channel > provider > global", () => {
    const cfg = {
      channels: {
        slack: {
          conversationLaneDrainDelayMs: 200,
          channels: {
            C0123: { conversationLaneDrainDelayMs: 300 },
          },
        },
      },
    };
    expect(
      resolveConversationLaneDrainDelay({
        cfg,
        channel: "slack",
        peerId: "channel:C0123",
      }),
    ).toBe(300);
  });

  it("slack: falls back to provider when channel not set", () => {
    const cfg = {
      channels: {
        slack: {
          conversationLaneDrainDelayMs: 200,
          channels: { C0123: {} },
        },
      },
    };
    expect(
      resolveConversationLaneDrainDelay({
        cfg,
        channel: "slack",
        peerId: "channel:C0123",
      }),
    ).toBe(200);
  });

  // --- peerId prefix stripping ---

  it("strips channel: prefix from peerId", () => {
    const cfg = {
      channels: {
        discord: {
          guilds: {
            g1: {
              channels: { "123456789": { conversationLaneDrainDelayMs: 500 } },
            },
          },
        },
      },
    };
    expect(
      resolveConversationLaneDrainDelay({
        cfg,
        channel: "discord",
        groupSpace: "g1",
        peerId: "channel:123456789",
      }),
    ).toBe(500);
  });

  it("works with bare peerId (no prefix)", () => {
    const cfg = {
      channels: {
        slack: {
          channels: { C999: { conversationLaneDrainDelayMs: 750 } },
        },
      },
    };
    expect(
      resolveConversationLaneDrainDelay({
        cfg,
        channel: "slack",
        peerId: "C999",
      }),
    ).toBe(750);
  });

  // --- Flat providers ---

  it("flat provider: falls back to global", () => {
    const cfg = {
      agents: { defaults: { conversationLaneDrainDelayMs: 300 } },
      channels: { signal: {} },
    };
    expect(
      resolveConversationLaneDrainDelay({
        cfg,
        channel: "signal",
        peerId: "user:abc",
      }),
    ).toBe(300);
  });

  it("flat provider: uses provider-level value", () => {
    const cfg = {
      channels: { matrix: { conversationLaneDrainDelayMs: 250 } },
    };
    expect(
      resolveConversationLaneDrainDelay({
        cfg,
        channel: "matrix",
        peerId: "user:abc",
      }),
    ).toBe(250);
  });
});

describe("conversationLaneDrainDelayMs zod schema validation", () => {
  it("accepts valid values at discord channel level", () => {
    const parsed = OpenClawSchema.parse({
      channels: {
        discord: {
          guilds: {
            g1: {
              channels: { c1: { conversationLaneDrainDelayMs: 300 } },
            },
          },
        },
      },
    });
    expect(parsed.channels?.discord?.guilds?.g1?.channels?.c1?.conversationLaneDrainDelayMs).toBe(
      300,
    );
  });

  it("accepts valid values at discord guild level", () => {
    const parsed = OpenClawSchema.parse({
      channels: {
        discord: {
          guilds: { g1: { conversationLaneDrainDelayMs: 500 } },
        },
      },
    });
    expect(parsed.channels?.discord?.guilds?.g1?.conversationLaneDrainDelayMs).toBe(500);
  });

  it("accepts valid values at discord provider level", () => {
    const parsed = OpenClawSchema.parse({
      channels: { discord: { conversationLaneDrainDelayMs: 200 } },
    });
    expect(parsed.channels?.discord?.conversationLaneDrainDelayMs).toBe(200);
  });

  it("accepts valid values at telegram group level", () => {
    const parsed = OpenClawSchema.parse({
      channels: {
        telegram: {
          groups: { "-100123": { conversationLaneDrainDelayMs: 400 } },
        },
      },
    });
    expect(parsed.channels?.telegram?.groups?.["-100123"]?.conversationLaneDrainDelayMs).toBe(400);
  });

  it("accepts valid values at telegram provider level", () => {
    const parsed = OpenClawSchema.parse({
      channels: { telegram: { conversationLaneDrainDelayMs: 250 } },
    });
    expect(parsed.channels?.telegram?.conversationLaneDrainDelayMs).toBe(250);
  });

  it("accepts valid values at slack channel level", () => {
    const parsed = OpenClawSchema.parse({
      channels: {
        slack: {
          channels: { C0123: { conversationLaneDrainDelayMs: 200 } },
        },
      },
    });
    expect(parsed.channels?.slack?.channels?.C0123?.conversationLaneDrainDelayMs).toBe(200);
  });

  it("accepts valid values at slack provider level", () => {
    const parsed = OpenClawSchema.parse({
      channels: { slack: { conversationLaneDrainDelayMs: 150 } },
    });
    expect(parsed.channels?.slack?.conversationLaneDrainDelayMs).toBe(150);
  });

  it("accepts 0 (disabled)", () => {
    const parsed = OpenClawSchema.parse({
      channels: { discord: { conversationLaneDrainDelayMs: 0 } },
    });
    expect(parsed.channels?.discord?.conversationLaneDrainDelayMs).toBe(0);
  });

  it("rejects negative values", () => {
    expect(() =>
      OpenClawSchema.parse({
        channels: { discord: { conversationLaneDrainDelayMs: -1 } },
      }),
    ).toThrow();
  });

  it("rejects values above 10000", () => {
    expect(() =>
      OpenClawSchema.parse({
        channels: { discord: { conversationLaneDrainDelayMs: 10001 } },
      }),
    ).toThrow();
  });

  it("accepts config without the field (optional)", () => {
    const parsed = OpenClawSchema.parse({
      channels: { discord: {} },
    });
    expect(parsed.channels?.discord?.conversationLaneDrainDelayMs).toBeUndefined();
  });

  it("accepts at agent defaults level", () => {
    const parsed = OpenClawSchema.parse({
      agents: { defaults: { conversationLaneDrainDelayMs: 1000 } },
    });
    expect(parsed.agents?.defaults?.conversationLaneDrainDelayMs).toBe(1000);
  });
});

describe("conversationLaneDrainDelayMs defaults injection", () => {
  it("injects drain delay default on load", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify({}, null, 2),
        "utf-8",
      );

      const cfg = loadConfig();
      expect(cfg.agents?.defaults?.conversationLaneDrainDelayMs).toBe(
        DEFAULT_CONVERSATION_LANE_DRAIN_DELAY_MS,
      );
    });
  });
});
