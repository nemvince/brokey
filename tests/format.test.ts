import { describe, expect, test } from "bun:test";
import { formatCompact } from "../src/client/components/ui.tsx";

describe("formatCompact", () => {
  test("keeps small values fully grouped", () => {
    expect(formatCompact(0)).toBe("0");
    expect(formatCompact(1234)).toBe("1,234");
    expect(formatCompact(99_999)).toBe("99,999");
  });

  test("compacts large figures so they fit fixed-width slots", () => {
    expect(formatCompact(100_000)).toBe("100K");
    expect(formatCompact(123_456_789)).toBe("123.5M");
    expect(formatCompact(1_234_567_890)).toBe("1.2B");
  });
});
