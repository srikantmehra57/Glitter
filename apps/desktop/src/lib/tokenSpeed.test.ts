import { describe, expect, it } from "vitest";
import { formatTokenSpeed, readTokenSpeed, recordTokenSpeed } from "./tokenSpeed";

describe("token speed", () => {
  it("estimates the active stream rate from text and renderer timestamps", () => {
    let speed = recordTokenSpeed(undefined, "a".repeat(40), 1_000);
    speed = recordTokenSpeed(speed, "a".repeat(40), 2_000);

    expect(speed).toEqual({ characters: 80, activeMs: 1_000, lastAt: 2_000 });
    expect(readTokenSpeed(speed, 2_000)).toEqual({ tokensPerSecond: 20, idle: false });
    expect(formatTokenSpeed(readTokenSpeed(speed, 2_000)!.tokensPerSecond)).toBe("~20 tok/s");
  });

  it("caps long tool or approval gaps and marks a quiet live stream stale", () => {
    let speed = recordTokenSpeed(undefined, "a".repeat(40), 0);
    speed = recordTokenSpeed(speed, "a".repeat(40), 1_000);
    speed = recordTokenSpeed(speed, "a".repeat(40), 11_000);

    // 30 estimated tokens over two active seconds, not over the ten-second pause.
    expect(readTokenSpeed(speed, 11_000)?.tokensPerSecond).toBe(15);
    expect(readTokenSpeed(speed, 13_000)?.idle).toBe(false);
    expect(readTokenSpeed(speed, 13_001)?.idle).toBe(true);
  });

  it("ignores empty chunks and uses a one-second floor for short bursts", () => {
    expect(recordTokenSpeed(undefined, "", 0)).toBeUndefined();
    const speed = recordTokenSpeed(undefined, "abcd", 500);
    expect(readTokenSpeed(speed, 500)?.tokensPerSecond).toBe(1);
    expect(formatTokenSpeed(8.44)).toBe("~8.4 tok/s");
    expect(formatTokenSpeed(0)).toBe("");
  });
});
