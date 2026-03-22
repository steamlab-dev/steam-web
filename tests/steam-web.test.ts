import { describe, expect, it } from "vitest";
import SteamWeb, { ERRORS, SteamWebError } from "@/index";

describe("steam-web", () => {
  it("throws a steam-web error for malformed tokens", async () => {
    const client = new SteamWeb();

    await expect(client.login("invalid-token")).rejects.toMatchObject({
      name: "steam-web",
      message: ERRORS.INVALID_TOKEN,
    });
  });

  it("preserves the custom error name", () => {
    const error = new SteamWebError("boom");

    expect(error.name).toBe("steam-web");
    expect(error.message).toBe("boom");
  });
});
