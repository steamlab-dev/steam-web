import { config as loadEnv } from "dotenv";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ERRORS, SteamWeb } from "@/index";

loadEnv({ path: new URL("../.env", import.meta.url).pathname });

const getRefreshToken = (): string | null => {
  const value = process.env.STEAM_WEB_REFRESH_TOKEN?.trim();
  return value ? value : null;
};

async function canReachSteam(): Promise<boolean> {
  try {
    await fetch("https://login.steampowered.com/", {
      method: "HEAD",
      signal: AbortSignal.timeout(5_000),
    });
    return true;
  } catch {
    return false;
  }
}

async function getLiveSteamTestConfig(): Promise<{
  enabled: boolean;
  refreshToken: string | null;
  suiteName: string;
}> {
  const refreshToken = getRefreshToken();

  if (!refreshToken) {
    return {
      enabled: false,
      refreshToken: null,
      suiteName: "steam-web integration (skipped: set STEAM_WEB_REFRESH_TOKEN in tests/.env)",
    };
  }

  if (!(await canReachSteam())) {
    return {
      enabled: false,
      refreshToken: null,
      suiteName: "steam-web integration (skipped: Steam login endpoint unreachable)",
    };
  }

  return {
    enabled: true,
    refreshToken,
    suiteName: "steam-web integration",
  };
}

async function expectFarmableGamesOrVanityRedirect(client: SteamWeb): Promise<void> {
  try {
    const farmData = await client.getFarmableGames();

    expect(Array.isArray(farmData)).toBe(true);
  } catch (error) {
    expect(error).toBeInstanceOf(Response);

    const response = error as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("location") ?? "").toContain("/id/");
  }
}

const liveSteamTest = await getLiveSteamTestConfig();
const describeLiveSteam = liveSteamTest.enabled ? describe : describe.skip;

describeLiveSteam(liveSteamTest.suiteName, () => {
  let client: SteamWeb;
  let session: Awaited<ReturnType<SteamWeb["login"]>>;

  beforeAll(async () => {
    client = new SteamWeb();
    session = await client.login(liveSteamTest.refreshToken as string);
  });

  afterAll(async () => {
    await client.logout();
  });

  it("reuses a logged-in session on a separate client", async () => {
    const nextClient = new SteamWeb();

    try {
      nextClient.setSession(session);
      await expect(nextClient.getCardsInventory()).resolves.toSatisfy(Array.isArray);
    } finally {
      await nextClient.logout();
    }
  });

  it("fetches farmable games or returns the expected manual redirect", async () => {
    await expectFarmableGamesOrVanityRedirect(client);
  });

  it("fetches card inventory", async () => {
    const items = await client.getCardsInventory();

    expect(Array.isArray(items)).toBe(true);
  });

  it("rejects authenticated calls after logout", async () => {
    await client.logout();

    await expect(client.getFarmableGames()).rejects.toMatchObject({
      name: "steam-web",
      message: ERRORS.NOT_LOGGEDIN,
    });

    await client.login(liveSteamTest.refreshToken as string);
  });
});
