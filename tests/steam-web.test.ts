import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SteamWeb, { ERRORS, SteamWebError } from "@/index";
import {
  parseAvatarFrameFromProfileHtml,
  parseFarmableGamesFromBadgesHtml,
} from "@/internal/html-parsers";

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");
const badgesHtml = readFileSync(resolve(fixturesDir, "badges-page.html"), "utf8");
const profileHtml = readFileSync(resolve(fixturesDir, "profile-page.html"), "utf8");

function createJwt(overrides: Partial<{ aud: string[]; exp: number; sub: string }> = {}): string {
  const payload = {
    iss: "steam",
    sub: "76561197960410044",
    aud: ["web"],
    exp: Math.floor(Date.now() / 1000) + 60 * 60,
    nbf: 0,
    iat: 0,
    jti: "token-id",
    oat: 0,
    per: 0,
    ip_subject: "127.0.0.1",
    ip_confirmer: "127.0.0.1",
    ...overrides,
  };

  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64")}.signature`;
}

function textResponse(text: string, init?: ResponseInit): Response {
  return new Response(text, { status: 200, ...init });
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200,
    ...init,
  });
}

describe("steam-web", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

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

  it("parses crafted badge rows with entity decoding and detail removal", () => {
    const craftedHtml = `
      <div class="badge_row">
        <div class="progress_info_bold">3 tasks remaining</div>
      </div>
      <div class="badge_row">
        <div class="progress_info_bold">0 card drops remaining</div>
        <div class="badge_title_stats_playtime">&nbsp;</div>
        <div class="badge_title">Skipped</div>
        <a class="badge_row_overlay" href="/gamecards/1"></a>
      </div>
      <div class="badge_row">
        <div class="progress_info_bold">4 card drops remaining</div>
        <div class="badge_title_stats_playtime">1,234.5 hrs on record</div>
        <div class="badge_title">Test &amp; Game<div class="badge_view_details">details</div></div>
        <a class="badge_row_overlay" href=/gamecards/730></a>
        <div class="card_drop_info_header">Card drops received: 7</div>
      </div>
      <div class="badge_row">
        <div class="progress_info_bold">2 card drops remaining</div>
        <div class="badge_title_stats_playtime">3.0 hrs on record</div>
        <div class="badge_title">Ignored</div>
        <a class="badge_row_overlay" href="/foo/bar"></a>
      </div>
    `;

    expect(parseFarmableGamesFromBadgesHtml(craftedHtml)).toEqual([
      {
        appId: 730,
        droppedCards: 7,
        name: "Test & Game",
        playTime: 1234.5,
        remainingCards: 4,
      },
    ]);
  });

  it("parses farmable games from the badges fixture", () => {
    expect(parseFarmableGamesFromBadgesHtml(badgesHtml)).toEqual([
      {
        appId: 865360,
        droppedCards: 0,
        name: "We Were Here Together",
        playTime: 0,
        remainingCards: 5,
      },
      {
        appId: 677160,
        droppedCards: 0,
        name: "We Were Here Too",
        playTime: 0,
        remainingCards: 5,
      },
    ]);
  });

  it("parses the avatar frame from the profile fixture", () => {
    expect(parseAvatarFrameFromProfileHtml(profileHtml)).toBe(
      "https://shared.fastly.steamstatic.com/community_assets/images/items/1299120/48bc0153b3bd4ce9eca5cdbef97d5d7d062985f4.png",
    );
  });

  it("returns null when the profile frame is missing or the class name only partially matches", () => {
    expect(parseAvatarFrameFromProfileHtml("<div class='other'></div>")).toBeNull();
    expect(
      parseAvatarFrameFromProfileHtml(
        "<div class='profile_avatar_frame_hidden'><img src='https://example.com/frame.png'></div>",
      ),
    ).toBeNull();
  });

  it("handles malformed avatar-frame markup defensively", () => {
    expect(parseAvatarFrameFromProfileHtml("profile_avatar_frame")).toBeNull();
    expect(
      parseAvatarFrameFromProfileHtml("<div class='profile_avatar_frame'><span></span></div>"),
    ).toBeNull();
    expect(
      parseAvatarFrameFromProfileHtml("<div class='profile_avatar_frame'><img alt='x'></div>"),
    ).toBeNull();
    expect(
      parseAvatarFrameFromProfileHtml(
        "<img class='profile_avatar_frame' src='https://example.com/frame.png'>",
      ),
    ).toBeNull();
    expect(
      parseAvatarFrameFromProfileHtml(
        "<div class='profile_avatar_frame'><img src='https://example.com/frame.png'></div",
      ),
    ).toBeNull();
    expect(
      parseAvatarFrameFromProfileHtml("<1 class='profile_avatar_frame'>ignored</1>"),
    ).toBeNull();
    expect(
      parseAvatarFrameFromProfileHtml(
        "<div data-kind='profile_avatar_frame'><img src='https://example.com/frame.png'></div>",
      ),
    ).toBeNull();
    expect(
      parseAvatarFrameFromProfileHtml(
        "<? class='profile_avatar_frame'>ignored<div class='profile_avatar_frame'><img src='https://example.com/frame.png'></div>",
      ),
    ).toBe("https://example.com/frame.png");
    expect(
      parseAvatarFrameFromProfileHtml(
        "<section class='profile_avatar_frame'><img src='https://example.com/fallback.png'></span>",
      ),
    ).toBeNull();
  });

  it("skips malformed badge rows while preserving valid ones", () => {
    const malformedHtml = `
      <div class="badge_row">
        <div class="progress_info_bold">2 card drops remaining</div>
      </div>
      <div class="badge_row">
        <div class="progress_info_bold">2 card drops remaining</div>
        <div class="badge_title_stats_playtime">hrs on record</div>
      </div>
      <div class="badge_row">
        <div class="progress_info_bold">2 card drops remaining</div>
        <div class="badge_title_stats_playtime">hrs on record</div>
        <div class="badge_title"><div class="badge_view_details">only details</div></div>
      </div>
      <div class="badge_row">
        <div class="progress_info_bold">2 card drops remaining</div>
        <div class="badge_title_stats_playtime">hrs on record</div>
        <div class="badge_title">Missing overlay</div>
      </div>
      <div class="badge_row">
        <div class="progress_info_bold">2 card drops remaining</div>
        <div class="badge_title_stats_playtime">hrs on record</div>
        <div class="badge_title">Missing href</div>
        <a class="badge_row_overlay"></a>
      </div>
      <div class="badge_row">
        <div class="progress_info_bold">2 card drops remaining</div>
        <div class="badge_title_stats_playtime">hrs on record</div>
        <div class="badge_title">Missing app id</div>
        <a class="badge_row_overlay" href="/gamecards/no-id"></a>
      </div>
      <div class="badge_row">
        <div class="progress_info_bold">2 card drops remaining</div>
        <div class="badge_title_stats_playtime">&#x31;&#50;&#51; hrs on record</div>
        <div class="badge_title">Good &#39; &quot; &apos; &lt;Tag&gt;</div>
        <a class="badge_row_overlay" href="/gamecards/12345"></a>
      </div>
    `;

    expect(parseFarmableGamesFromBadgesHtml(malformedHtml)).toEqual([
      {
        appId: 12345,
        droppedCards: 0,
        name: `Good ' " ' <Tag>`,
        playTime: 123,
        remainingCards: 2,
      },
    ]);
  });

  it("maps logged-out badge HTML to the existing not-logged-in error", () => {
    const client = new SteamWeb();
    const parseFarmingData = (client as any).parseFarmingData.bind(client) as (
      html: string,
    ) => unknown;

    expect(() =>
      parseFarmingData(
        '<a class="global_action_link" href="https://store.steampowered.com/login/">login</a>',
      ),
    ).toThrowError(new SteamWebError(ERRORS.NOT_LOGGEDIN));
  });

  it("rethrows unexpected farming parser errors", () => {
    const client = new SteamWeb();
    const parseFarmingData = (client as any).parseFarmingData.bind(client) as (
      html: unknown,
    ) => unknown;

    expect(() => parseFarmingData(null)).toThrow(TypeError);
  });

  it("logs in with a valid token and stores returned cookies", async () => {
    fetchMock.mockResolvedValueOnce(
      textResponse("ok", {
        headers: {
          "set-cookie": "sessionid=session-2; Path=/, steamLoginSecure=secure-token; Path=/",
        },
      }),
    );

    const client = new SteamWeb();
    const session = await client.login(createJwt());

    expect(session).toEqual({
      cookies: expect.stringContaining("steamLoginSecure=secure-token"),
      sessionid: "session-2",
      steamid: "76561197960410044",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects tokens with an invalid audience or expiration", () => {
    const client = new SteamWeb();
    const verifyToken = (client as any).verifyToken.bind(client) as (token: string) => unknown;

    expect(() => verifyToken(createJwt({ aud: ["renew"] }))).toThrowError(
      new SteamWebError(ERRORS.INVALID_TOKEN),
    );
    expect(() => verifyToken(createJwt({ exp: Math.floor(Date.now() / 1000) + 30 }))).toThrowError(
      new SteamWebError(ERRORS.INVALID_TOKEN),
    );
  });

  it("reuses a previous session", async () => {
    const client = new SteamWeb();

    await client.setSession({
      cookies: "steamLoginSecure=secure; sessionid=existing;",
      sessionid: "existing",
      steamid: "76561197960410044",
    });

    expect((client as any).sessionid).toBe("existing");
    expect((client as any).steamid).toBe("76561197960410044");
    expect((client as any).fetchOptions.headers.get("Cookie")).toContain("steamLoginSecure=secure");
  });

  it("logs out and clears cookies", async () => {
    fetchMock.mockResolvedValueOnce(textResponse("bye"));

    const client = new SteamWeb();
    (client as any).sessionid = "session-1";
    (client as any).fetchOptions.headers.set("Cookie", "steamLoginSecure=secure");

    await client.logout();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://store.steampowered.com/logout/",
      expect.objectContaining({ method: "POST" }),
    );
    expect((client as any).fetchOptions.headers.get("Cookie")).toBe("");
  });

  it("loads farmable games and avatar frames through the public API", async () => {
    fetchMock
      .mockResolvedValueOnce(textResponse(badgesHtml))
      .mockResolvedValueOnce(textResponse(profileHtml));

    const client = new SteamWeb();
    (client as any).steamid = "76561197960410044";

    await expect(client.getFarmableGames()).resolves.toHaveLength(2);
    await expect(client.getAvatarFrame()).resolves.toMatch(
      /^https:\/\/shared\.fastly\.steamstatic\.com\/community_assets\/images\/items\//,
    );
  });

  it("maps rate limiting and unauthorized responses to steam-web errors", () => {
    const client = new SteamWeb();
    const validateRes = (client as any).validateRes.bind(client) as (res: Response) => void;

    expect(() => validateRes(new Response("", { status: 429 }))).toThrowError(
      new SteamWebError(ERRORS.RATE_LIMIT),
    );
    expect(() => validateRes(new Response("", { status: 401 }))).toThrowError(
      new SteamWebError(ERRORS.NOT_LOGGEDIN),
    );

    let thrown: unknown;
    try {
      validateRes(new Response("boom", { status: 500 }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Response);
  });

  it("parses inventory items and skips incomplete entries", () => {
    const client = new SteamWeb();
    const parseItems = (client as any).parseItems.bind(client) as (
      data: unknown,
      contextId: string,
    ) => unknown;

    expect(
      parseItems(
        {
          rgDescriptions: {
            "10_1": {
              icon_url: "icon.png",
              name: "Trading Card",
              tradable: 1,
              type: "Card",
            },
          },
          rgInventory: {
            first: { amount: "2", classid: "10", id: "asset-1", instanceid: "1" },
            missingDescription: { amount: "1", classid: "11", id: "asset-2", instanceid: "1" },
            missingItem: undefined,
          },
          success: true,
        },
        "6",
      ),
    ).toEqual([
      {
        amount: "2",
        assetid: "asset-1",
        contextId: "6",
        icon: "icon.png",
        name: "Trading Card",
        tradable: true,
        type: "Card",
      },
    ]);
  });

  it("loads cards inventory and maps private profiles to not-logged-in", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          rgDescriptions: {
            "10_1": { icon_url: "icon.png", name: "Trading Card", tradable: 1, type: "Card" },
          },
          rgInventory: {
            first: { amount: "2", classid: "10", id: "asset-1", instanceid: "1" },
          },
          success: true,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          Error: "This profile is private.",
          rgDescriptions: {},
          rgInventory: {},
          success: false,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ Error: "Nope", rgDescriptions: {}, rgInventory: {}, success: false }),
      );

    const client = new SteamWeb();
    (client as any).steamid = "76561197960410044";

    await expect(client.getCardsInventory()).resolves.toHaveLength(1);
    await expect(client.getCardsInventory()).rejects.toThrowError(
      new SteamWebError(ERRORS.NOT_LOGGEDIN),
    );
    await expect(client.getCardsInventory()).rejects.toMatchObject({ Error: "Nope" });
  });

  it("rejects invalid avatar content types and oversize images", async () => {
    fetchMock
      .mockResolvedValueOnce(
        textResponse("", { headers: { "content-length": "512", "content-type": "text/html" } }),
      )
      .mockResolvedValueOnce(
        textResponse("", {
          headers: {
            "content-length": String(1025 * 1024),
            "content-type": "image/png",
          },
        }),
      );

    const client = new SteamWeb();

    await expect(client.changeAvatar("https://example.com/avatar.png")).rejects.toThrowError(
      new SteamWebError("URL does not contain a JPEG or PNG image."),
    );
    await expect(client.changeAvatar("https://example.com/avatar.png")).rejects.toThrowError(
      new SteamWebError("Image size should not be larger than 1024 kB."),
    );
  });

  it("uploads an avatar and handles upload failures", async () => {
    fetchMock
      .mockResolvedValueOnce(
        textResponse("", { headers: { "content-length": "512", "content-type": "image/png" } }),
      )
      .mockResolvedValueOnce(textResponse("avatar-binary"))
      .mockResolvedValueOnce(
        textResponse('{"success":true,"images":{"0":"small","full":"full.png","medium":"medium"}}'),
      )
      .mockResolvedValueOnce(
        textResponse("", { headers: { "content-length": "512", "content-type": "image/png" } }),
      )
      .mockResolvedValueOnce(textResponse("avatar-binary"))
      .mockResolvedValueOnce(textResponse("denied"));

    const client = new SteamWeb();
    (client as any).sessionid = "session-1";
    (client as any).steamid = "76561197960410044";

    await expect(client.changeAvatar("https://example.com/avatar.png")).resolves.toBe("full.png");
    await expect(client.changeAvatar("https://example.com/avatar.png")).rejects.toThrowError(
      new SteamWebError(ERRORS.NOT_LOGGEDIN),
    );
  });

  it("clears aliases and changes privacy", async () => {
    const privacyProfiles: number[] = [];

    fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.includes("ajaxsetprivacy")) {
        const privacy = JSON.parse(String((init?.body as FormData).get("Privacy")));
        privacyProfiles.push(privacy.PrivacyProfile);
        return textResponse('{"success":1}');
      }

      return textResponse('{"success":1}');
    });

    const client = new SteamWeb();
    (client as any).sessionid = "session-1";
    (client as any).steamid = "76561197960410044";

    await expect(client.clearAliases()).resolves.toBeUndefined();
    await expect(client.changePrivacy("public")).resolves.toBeUndefined();
    await expect(client.changePrivacy("friendsOnly")).resolves.toBeUndefined();
    await expect(client.changePrivacy("private")).resolves.toBeUndefined();

    expect(privacyProfiles).toEqual([3, 2, 1]);
  });

  it("maps alias and privacy failures to not-logged-in", async () => {
    fetchMock.mockImplementation(async () => textResponse("denied"));

    const client = new SteamWeb();
    (client as any).sessionid = "session-1";
    (client as any).steamid = "76561197960410044";

    await expect(client.clearAliases()).rejects.toThrowError(
      new SteamWebError(ERRORS.NOT_LOGGEDIN),
    );
    await expect(client.changePrivacy("public")).rejects.toThrowError(
      new SteamWebError(ERRORS.NOT_LOGGEDIN),
    );
  });

  it("sets cookie headers from raw cookie strings", () => {
    const client = new SteamWeb();
    const setCookieHeader = (client as any).setCookieHeader.bind(client) as (
      value: string | null,
    ) => void;
    const setCookie = (client as any).setCookie.bind(client) as (
      name: string,
      value: string,
    ) => void;

    setCookieHeader(null);
    setCookieHeader("invalid-cookie, sessionid=session-9; Path=/, steamLoginSecure=secure; Path=/");
    setCookie("extra", "value");

    expect((client as any).sessionid).toBe("session-9");
    expect((client as any).fetchOptions.headers.get("Cookie")).toContain("steamLoginSecure=secure");
    expect((client as any).fetchOptions.headers.get("Cookie")).toContain("extra=value");
  });

  it("supports dispatcher configuration and access-token login", async () => {
    const dispatcher = { dispatch: vi.fn() } as unknown as NonNullable<RequestInit["dispatcher"]>;
    const client = new SteamWeb({ dispatcher });
    const loginWithAccessToken = (client as any).loginWithAccessToken.bind(client) as (
      accessToken: string,
    ) => Promise<void>;

    (client as any).steamid = "76561197960410044";
    await loginWithAccessToken("token-value");

    expect((client as any).fetchOptions.dispatcher).toBe(dispatcher);
    expect((client as any).fetchOptions.headers.get("Cookie")).toContain(
      "steamLoginSecure=76561197960410044%7C%7Ctoken-value",
    );
  });

  it("handles refresh-token login success and failure branches", async () => {
    const client = new SteamWeb();
    const loginWithRefreshToken = (client as any).loginWithRefreshToken.bind(client) as (
      refreshToken: string,
    ) => Promise<void>;

    (client as any).steamid = "76561197960410044";
    (client as any).sessionid = "session-1";

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          transfer_info: [
            { params: { auth: "auth", nonce: "nonce" }, url: "https://transfer.test" },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { result: 1 },
          {
            headers: {
              "set-cookie": "steamLoginSecure=secure; Path=/, sessionid=session-9; Path=/",
            },
          },
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, transfer_info: [] }))
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          transfer_info: [
            { params: { auth: "auth", nonce: "nonce" }, url: "https://transfer.test" },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ result: 1 }));

    await expect(loginWithRefreshToken("refresh-token")).resolves.toBeUndefined();
    await expect(loginWithRefreshToken("refresh-token")).rejects.toThrowError(
      new SteamWebError("SomethingWentWrong"),
    );
    await expect(loginWithRefreshToken("refresh-token")).rejects.toThrowError(
      new SteamWebError("SomethingWentWrong"),
    );
  });

  it("surfaces finalize-login and transfer errors from refresh-token login", async () => {
    const client = new SteamWeb();
    const loginWithRefreshToken = (client as any).loginWithRefreshToken.bind(client) as (
      refreshToken: string,
    ) => Promise<void>;

    (client as any).steamid = "76561197960410044";

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 42, success: false, transfer_info: [] }))
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          transfer_info: [
            { params: { auth: "auth", nonce: "nonce" }, url: "https://transfer.test" },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ result: 2 }));

    await expect(loginWithRefreshToken("refresh-token")).rejects.toBe(42);
    await expect(loginWithRefreshToken("refresh-token")).rejects.toBe(2);
  });

  it("rethrows unexpected token parsing failures", () => {
    const client = new SteamWeb();
    const verifyToken = (client as any).verifyToken.bind(client) as (token: string) => unknown;

    vi.spyOn(JSON, "parse").mockImplementation(() => {
      throw new RangeError("boom");
    });

    expect(() => verifyToken(createJwt())).toThrowError(new RangeError("boom"));
  });

  it("ignores empty cookie segments while parsing cookie headers", () => {
    const client = new SteamWeb();
    const setCookieHeader = (client as any).setCookieHeader.bind(client) as (
      value: string | null,
    ) => void;

    setCookieHeader(", sessionid=session-3; Path=/, steamLoginSecure=secure; Path=/");

    expect((client as any).sessionid).toBe("session-3");
  });
});
