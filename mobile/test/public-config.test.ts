import { describe, expect, it } from "vitest";

describe("public API configuration", () => {
  it("keeps the Cloudflare API as the safe default", async () => {
    const { publicConfig } = await import("../src/public-config.js");
    expect(publicConfig.apiUrl).toMatch(/^https:\/\/intern-notifs(?:-dev)?\.jdkrasnick\.workers\.dev$/u);
  });
});
