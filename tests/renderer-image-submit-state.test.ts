import { describe, expect, it } from "vitest";
import { imageAccountNeedsTopup } from "../src/renderer/image-submit-state";

describe("image submit balance gate", () => {
  it("blocks only connected accounts with no remaining paid balance", () => {
    expect(imageAccountNeedsTopup({ connected: true, totalUsd: 10, usedUsd: 10 })).toBe(true);
    expect(imageAccountNeedsTopup({ connected: true, totalUsd: 10, usedUsd: 9.99 })).toBe(false);
  });

  it("does not block unlimited, disconnected, or unknown-balance accounts", () => {
    expect(imageAccountNeedsTopup({ connected: true, totalUsd: 1_000_000, usedUsd: 1_000_000 })).toBe(false);
    expect(imageAccountNeedsTopup({ connected: false, totalUsd: 0, usedUsd: 0 })).toBe(false);
    expect(imageAccountNeedsTopup({ connected: true, totalUsd: null, usedUsd: null })).toBe(false);
    expect(imageAccountNeedsTopup(null)).toBe(false);
  });
});
