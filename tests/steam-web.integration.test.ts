import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import SteamWeb from "@/index";
import type { Session } from "@/types";

const refreshToken = process.env.STEAM_WEB_REFRESH_TOKEN;

const describeIfRefreshToken = refreshToken ? describe : describe.skip;

describeIfRefreshToken("steam-web integration", () => {
  let client: SteamWeb;
  let session: Session;

  beforeAll(async () => {
    client = new SteamWeb();
    session = await client.login(refreshToken as string);
  });

  afterAll(async () => {
    await client.logout();
  });

  it("reuses a previous session", async () => {
    const nextClient = new SteamWeb();

    await nextClient.setSession(session);
    await nextClient.logout();
  });

  it("fetches farmable games", async () => {
    const farmData = await client.getFarmableGames();

    expect(Array.isArray(farmData)).toBe(true);
  });

  it("fetches card inventory", async () => {
    const items = await client.getCardsInventory();

    expect(Array.isArray(items)).toBe(true);
  });

  it("rejects authenticated calls after logout", async () => {
    await client.logout();

    await expect(
      client.setSession({
        steamid: session.steamid,
        sessionid: session.sessionid,
        cookies: "",
      }),
    ).rejects.toMatchObject({
      name: "steam-web",
      message: "NotLoggedIn",
    });

    await expect(client.getFarmableGames()).rejects.toMatchObject({
      name: "steam-web",
      message: "NotLoggedIn",
    });
  });
});
