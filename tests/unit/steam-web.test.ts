import { Buffer } from "node:buffer";
import { SocksProxyAgent } from "socks-proxy-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ERRORS, SteamWeb, SteamWebError, type SteamWebSession } from "@/index";
import Fetch from "@/internal/Fetch";
import {
  parseAvatarFrameFromProfileHtml,
  parseFarmableGamesFromBadgesHtml,
} from "@/internal/html-parsers";
import {
  badgesHtml,
  blobResponse,
  createJwt,
  createSession,
  jsonResponse,
  profileHtml,
  queueFetchResponses,
  responseWithSetCookies,
  seedSession,
  textResponse,
} from "../support/test-helpers";

let fetchMock: ReturnType<typeof vi.fn>;

const getInternals = (client: SteamWeb): any => client as any;

const createSeededClient = (overrides: Partial<SteamWebSession> = {}): SteamWeb => {
  const client = new SteamWeb();
  seedSession(client, overrides);
  return client;
};

const createClientHarness = (overrides: Partial<SteamWebSession> = {}) => {
  const client = createSeededClient(overrides);
  return { client, internals: getInternals(client) };
};

const getVerifyToken = (client = new SteamWeb()) => {
  return getInternals(client).verifyToken.bind(client) as (token: string) => unknown;
};

const getParseFarmingData = (client = new SteamWeb()) => {
  return getInternals(client).parseFarmingData.bind(client) as (html: unknown) => unknown;
};

const getValidateRes = (client = new SteamWeb()) => {
  return getInternals(client).validateRes.bind(client) as (res: Response) => void;
};

const getParseItems = (client = new SteamWeb()) => {
  return getInternals(client).parseItems.bind(client) as (
    data: unknown,
    contextId: string,
  ) => unknown;
};

const createTransferInfo = (
  url = "https://steamcommunity.com/login/settoken",
  params: { auth: string; nonce: string } = { auth: "x", nonce: "y" },
) => ({ params, url });

const createRefreshTokenLoginResponse = (
  transferInfo = [createTransferInfo()],
  primaryDomain = "steamcommunity.com",
) =>
  jsonResponse({
    primary_domain: primaryDomain,
    steamID: "76561197960410044",
    transfer_info: transferInfo,
  });

const RESTORED_SESSION_NOW = 1_762_000_000_000;

describe("steam-web", () => {
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("proxy support", () => {
    it.each([
      {
        expected: {
          protocol: "https",
          token: `Basic ${Buffer.from("user:pass").toString("base64")}`,
        },
        input: "https://user:pass@proxy.example:8443",
        url: {
          host: "proxy.example:8443",
          password: "",
          protocol: "https:",
          username: "",
        },
      },
      {
        expected: {
          protocol: "socks5",
          token: undefined,
        },
        input: "socks5://user:pa%3Ass@proxy.example:1080",
        url: {
          host: "proxy.example:1080",
          password: "pa%3Ass",
          protocol: "socks5:",
          username: "user",
        },
      },
      {
        expected: {
          protocol: "socks5",
          token: undefined,
        },
        input: new URL("socks5://proxy.example:1080"),
        url: {
          host: "proxy.example:1080",
          password: "",
          protocol: "socks5:",
          username: "",
        },
      },
    ])("stores normalized proxy configuration from %s", ({ expected, input, url }) => {
      const config = (new Fetch(input) as any).proxy;

      expect(config.protocol).toBe(expected.protocol);
      expect(config.token).toBe(expected.token);
      expect(config.url.protocol).toBe(url.protocol);
      expect(config.url.host).toBe(url.host);
      expect(config.url.username).toBe(url.username);
      expect(config.url.password).toBe(url.password);
      expect(config).not.toHaveProperty("username");
      expect(config).not.toHaveProperty("password");
    });

    it.each([
      {
        input: "https://user@proxy.example:8443",
        token: `Basic ${Buffer.from("user:").toString("base64")}`,
      },
      {
        input: "https://:pass@proxy.example:8443",
        token: `Basic ${Buffer.from(":pass").toString("base64")}`,
      },
    ])("handles partial proxy credentials for %s", ({ input, token }) => {
      const config = (new Fetch(input) as any).proxy;
      expect(config.token).toBe(token);
    });

    it("creates the correct proxy agent type for HTTPS and SOCKS5 proxies", () => {
      const httpsProxy = new Fetch("https://proxy.example:8443") as any;
      const socksProxy = new Fetch("socks5://proxy.example:1080") as any;

      expect(httpsProxy.httpsAgent?.constructor.name).toBe("HttpsTunnelAgent");
      expect(socksProxy.httpsAgent).toBeInstanceOf(SocksProxyAgent);
    });

    it("rejects unsupported proxy protocols", () => {
      expect(() => new Fetch("ftp://proxy.example:21")).toThrow(
        new TypeError("Unsupported proxy protocol. Expected one of: https, socks5."),
      );
      expect(() => new Fetch("http://proxy.example:8080")).toThrow(
        new TypeError("Unsupported proxy protocol. Expected one of: https, socks5."),
      );
    });

    it("rejects socks5h because the supported SOCKS protocol is socks5", () => {
      expect(() => new Fetch("socks5h://proxy.example:1080")).toThrow(
        new TypeError("Unsupported proxy protocol. Expected one of: https, socks5."),
      );
    });

    it("keeps redirects manual even when no proxy URL is configured", async () => {
      fetchMock.mockResolvedValueOnce(textResponse("ok"));

      const response = await new Fetch().fetch("https://example.com/login");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBeInstanceOf(Request);
      expect((fetchMock.mock.calls[0]?.[0] as Request).redirect).toBe("manual");
      await expect(response.text()).resolves.toBe("ok");
    });

    it("bypasses proxy handling for plain http and non-http urls", async () => {
      fetchMock.mockResolvedValueOnce(textResponse("ok"));
      fetchMock.mockResolvedValueOnce(textResponse("still-ok"));

      const proxiedFetch = new Fetch("https://proxy.example:8443").fetch;

      const firstResponse = await proxiedFetch("http://example.com/ok");
      const secondResponse = await proxiedFetch("data:text/plain,still-ok", {
        headers: { accept: "application/json" },
      });

      expect(proxiedFetch).not.toBe(fetch);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect((fetchMock.mock.calls[0]?.[0] as Request).redirect).toBe("manual");
      expect((fetchMock.mock.calls[1]?.[0] as Request).redirect).toBe("manual");
      await expect(firstResponse.text()).resolves.toBe("ok");
      await expect(secondResponse.text()).resolves.toBe("still-ok");
    });
  });

  describe("fixture parsing", () => {
    it("parses farmable games from the badges-page fixture", () => {
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

    it("parses the avatar frame from the profile-page fixture", () => {
      expect(parseAvatarFrameFromProfileHtml(profileHtml)).toBe(
        "https://shared.fastly.steamstatic.com/community_assets/images/items/1299120/48bc0153b3bd4ce9eca5cdbef97d5d7d062985f4.png",
      );
    });

    it("rethrows unexpected farming parser errors", () => {
      expect(() => getParseFarmingData()(null)).toThrow(TypeError);
    });
  });

  describe("login and session handling", () => {
    it("throws a steam-web error for malformed tokens", async () => {
      await expect(new SteamWeb().login("invalid-token")).rejects.toMatchObject({
        name: "steam-web",
        message: ERRORS.INVALID_TOKEN,
      });
    });

    it("preserves the custom error name", () => {
      const error = new SteamWebError("boom");

      expect(error.name).toBe("steam-web");
      expect(error.message).toBe("boom");
    });

    it("logs in with a valid token and stores returned cookies", async () => {
      const client = new SteamWeb();
      await client.login(createJwt({ aud: ["web"] }));

      const internals = getInternals(client);
      const cookieHeader = internals.fetchOptions.headers.get("cookie") as string;
      expect(cookieHeader).toContain("steamLoginSecure=");
      expect(cookieHeader).toContain("%7C%7C");
      expect(cookieHeader).toContain(`sessionid=${internals.steamWebSession.sessionid}`);
      expect(internals.steamWebSession.steamid).toBe("76561197960410044");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects tokens with an invalid audience or expiration", () => {
      const verifyToken = getVerifyToken();

      expect(() => verifyToken(createJwt({ aud: ["renew"] }))).toThrow(
        new SteamWebError("Token audience is not valid for web."),
      );
      expect(() => verifyToken(createJwt({ exp: Math.floor(Date.now() / 1000) - 30 }))).toThrow(
        new SteamWebError(ERRORS.TOKEN_EXPIRED),
      );
    });

    it("logs out and clears cookies", async () => {
      const client = new SteamWeb();
      await client.login(createJwt({ aud: ["web"] }));

      await client.logout();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(getInternals(client).fetchOptions.headers.get("cookie")).toBeNull();
    });

    it("reuses a previous session without leaking stale cookies or object references", () => {
      const session = createSession({
        sessionid: "restored-session",
        steamLoginSecure: {
          expires: 4_102_444_800_000,
          steamLoginSecure: "restored-secure",
        },
      });
      const { client, internals } = createClientHarness();

      internals.cookieJar.set("steamCountry", "US");
      internals.applyCookiesToHeaders();

      client.setSession(session);

      expect(internals.steamWebSession).toEqual(session);
      expect(internals.steamWebSession).not.toBe(session);
      expect(internals.steamWebSession.steamLoginSecure).not.toBe(session.steamLoginSecure);
      expect(internals.fetchOptions.headers.get("cookie")).toBe(
        "sessionid=restored-session; steamLoginSecure=restored-secure",
      );

      session.sessionid = "mutated-session";
      session.steamLoginSecure.steamLoginSecure = "mutated-secure";

      expect(internals.steamWebSession.sessionid).toBe("restored-session");
      expect(internals.steamWebSession.steamLoginSecure.steamLoginSecure).toBe("restored-secure");
    });

    it.each([
      {
        expires: RESTORED_SESSION_NOW - 1,
        expectedError: new SteamWebError(ERRORS.TOKEN_EXPIRED),
        name: "rejects restored sessions with an expired steamLoginSecure cookie",
      },
      {
        expires: 0,
        expectedError: undefined,
        name: "allows restored sessions with an unknown steamLoginSecure expiry",
      },
      {
        expires: RESTORED_SESSION_NOW + 1,
        expectedError: undefined,
        name: "allows restored sessions with a future steamLoginSecure expiry",
      },
    ])("$name", ({ expires, expectedError }) => {
      const client = new SteamWeb();

      vi.spyOn(Date, "now").mockReturnValue(RESTORED_SESSION_NOW);

      const restoreSession = () =>
        client.setSession(
          createSession({
            steamLoginSecure: {
              expires,
              steamLoginSecure: "restored-secure",
            },
          }),
        );

      if (expectedError) {
        expect(restoreSession).toThrow(expectedError);
        return;
      }

      expect(restoreSession).not.toThrow();
    });

    it("uses restored session cookies on subsequent requests", async () => {
      fetchMock.mockResolvedValueOnce(textResponse(badgesHtml));

      const client = createSeededClient({
        sessionid: "restored-session",
        steamLoginSecure: {
          expires: 4_102_444_800_000,
          steamLoginSecure: "restored-secure",
        },
      });

      await expect(client.getFarmableGames()).resolves.toHaveLength(2);

      const request = fetchMock.mock.calls[0]?.[0] as Request;
      expect(request.headers.get("cookie")).toBe(
        "sessionid=restored-session; steamLoginSecure=restored-secure",
      );
    });

    it("rejects current-profile reads after logout clears the profile context", async () => {
      const client = new SteamWeb();
      await client.login(createJwt({ aud: ["web"] }));
      await client.logout();

      await expect(client.getFarmableGames()).rejects.toThrow(
        new SteamWebError(ERRORS.NOT_LOGGEDIN),
      );
      await expect(client.getAvatarFrame()).rejects.toThrow(new SteamWebError(ERRORS.NOT_LOGGEDIN));
    });

    it("rethrows unexpected token parsing failures", () => {
      const verifyToken = getVerifyToken();

      vi.spyOn(JSON, "parse").mockImplementation(() => {
        throw new RangeError("boom");
      });

      expect(() => verifyToken(createJwt())).toThrow(new RangeError("boom"));
    });

    it("validates token expiration without 32-bit timestamp truncation", () => {
      const verifyToken = getVerifyToken();

      vi.spyOn(Date, "now").mockReturnValue(2_200_000_000_000);

      expect(() => verifyToken(createJwt({ exp: 2_200_000_100 }))).not.toThrow();
      expect(() => verifyToken(createJwt({ exp: 2_200_000_000 }))).toThrow(
        new SteamWebError(ERRORS.TOKEN_EXPIRED),
      );
    });

    it("logs in through refresh-token flow and persists transferred cookies", async () => {
      queueFetchResponses(
        fetchMock,
        createRefreshTokenLoginResponse([
          createTransferInfo("https://steamcommunity.com/login/settoken", {
            auth: "community-auth",
            nonce: "community-nonce",
          }),
        ]),
        responseWithSetCookies(
          '{"result":1}',
          "steamCountry=US; Path=/; Domain=steamcommunity.com",
          "steamLoginSecure=secure-token; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/; Domain=steamcommunity.com",
        ),
      );

      const client = new SteamWeb();
      await client.login(createJwt({ aud: ["web", "renew"] }));

      const cookieHeader = getInternals(client).fetchOptions.headers.get("cookie") as string;
      expect(cookieHeader).toContain("steamCountry=US");
      expect(cookieHeader).toContain("steamLoginSecure=secure-token");
    });

    it("rejects refresh-token login when transfer info is missing", async () => {
      queueFetchResponses(fetchMock, createRefreshTokenLoginResponse([]));

      await expect(new SteamWeb().login(createJwt({ aud: ["web", "renew"] }))).rejects.toThrow(
        new SteamWebError("Login failed: no transfer info received."),
      );
    });

    it("rejects refresh-token login when steamcommunity transfer target is absent", async () => {
      queueFetchResponses(
        fetchMock,
        createRefreshTokenLoginResponse(
          [
            createTransferInfo("https://steamcommunity.com.evil.example/login/settoken", {
              auth: "x",
              nonce: "y",
            }),
          ],
          "store.steampowered.com",
        ),
      );

      await expect(new SteamWeb().login(createJwt({ aud: ["web", "renew"] }))).rejects.toThrow(
        new SteamWebError("Login failed: no transfer info received for steamcommunity.com."),
      );
    });

    it("rejects refresh-token login when steamLoginSecure is not included in set-cookie", async () => {
      queueFetchResponses(
        fetchMock,
        createRefreshTokenLoginResponse(),
        responseWithSetCookies(
          '{"result":1}',
          "steamCountry=US; Path=/; Domain=steamcommunity.com",
        ),
      );

      await expect(new SteamWeb().login(createJwt({ aud: ["web", "renew"] }))).rejects.toThrow(
        new SteamWebError(
          "Login failed: steamcommunity token transfer did not issue steamLoginSecure (result=1, set-cookie=steamCountry).",
        ),
      );
    });
  });

  describe("authenticated API helpers", () => {
    it("loads farmable games and avatar frames through the public API", async () => {
      queueFetchResponses(fetchMock, textResponse(badgesHtml), textResponse(profileHtml));

      const client = createSeededClient();

      await expect(client.getFarmableGames()).resolves.toHaveLength(2);
      await expect(client.getAvatarFrame()).resolves.toMatch(
        /^https:\/\/shared\.fastly\.steamstatic\.com\/community_assets\/images\/items\//,
      );
    });

    it("maps rate limiting and unauthorized responses to steam-web errors", () => {
      const validateRes = getValidateRes();

      expect(() => validateRes(new Response("", { status: 429 }))).toThrow(
        new SteamWebError(ERRORS.RATE_LIMIT),
      );
      expect(() => validateRes(new Response("", { status: 401 }))).toThrow(
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
      const parseItems = getParseItems();

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

      const client = createSeededClient();

      await expect(client.getCardsInventory()).resolves.toHaveLength(1);
      await expect(client.getCardsInventory()).rejects.toThrow(
        new SteamWebError(ERRORS.NOT_LOGGEDIN),
      );
      await expect(client.getCardsInventory()).rejects.toMatchObject({ Error: "Nope" });
    });

    it("maps unauthorized and rate-limited API calls through request helpers", async () => {
      queueFetchResponses(
        fetchMock,
        new Response("", { status: 401 }),
        new Response("", { status: 429 }),
      );

      const client = createSeededClient();

      await expect(client.getFarmableGames()).rejects.toThrow(
        new SteamWebError(ERRORS.NOT_LOGGEDIN),
      );
      await expect(client.getAvatarFrame()).rejects.toThrow(new SteamWebError(ERRORS.RATE_LIMIT));
    });

    it("surfaces non-mapped http failures as raw responses", async () => {
      fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }));

      await expect(createSeededClient().getFarmableGames()).rejects.toBeInstanceOf(Response);
    });

    it("merges set-cookie headers from ordinary requests into the session jar", async () => {
      fetchMock.mockResolvedValueOnce(
        responseWithSetCookies(badgesHtml, "steamCountry=US; Path=/; Domain=steamcommunity.com"),
      );

      const { client, internals } = createClientHarness();

      await expect(client.getFarmableGames()).resolves.toHaveLength(2);

      const cookieHeader = internals.fetchOptions.headers.get("cookie");
      expect(cookieHeader).toContain("sessionid=session-1");
      expect(cookieHeader).toContain("steamLoginSecure=secure-1");
      expect(cookieHeader).toContain("steamCountry=US");
    });

    it("deletes cookies when response sets an empty value", () => {
      const internals = getInternals(new SteamWeb());

      internals.cookieJar.set("sessionid", "abc");
      internals.mergeResponseCookies(
        responseWithSetCookies("", "sessionid=; Path=/; Domain=steamcommunity.com"),
      );
      internals.applyCookiesToHeaders();

      expect(internals.cookieJar.has("sessionid")).toBe(false);
      expect(internals.fetchOptions.headers.get("cookie")).toBeNull();
    });
  });

  describe("profile mutations", () => {
    it("rejects invalid avatar content types and oversize downloads", async () => {
      queueFetchResponses(
        fetchMock,
        blobResponse(new Blob(["not-an-image"], { type: "text/html" })),
        blobResponse(new Blob(["x".repeat(1024 * 1024 + 1)], { type: "image/png" })),
      );

      const client = createSeededClient();

      await expect(client.changeAvatar("https://example.com/avatar.png")).rejects.toThrow(
        new SteamWebError("URL does not contain a JPEG or PNG image."),
      );
      await expect(client.changeAvatar("https://example.com/avatar.png")).rejects.toThrow(
        new SteamWebError("Image size should not be larger than 1024 kB."),
      );
    });

    it("fails avatar upload when source download requests are not successful", async () => {
      queueFetchResponses(
        fetchMock,
        textResponse("nope", { status: 404 }),
        textResponse("nope", { status: 503 }),
      );

      const client = createSeededClient();

      await expect(client.changeAvatar("https://example.com/avatar.png")).rejects.toThrow(
        new SteamWebError("Avatar source request failed with status 404."),
      );
      await expect(client.changeAvatar("https://example.com/avatar.png")).rejects.toThrow(
        new SteamWebError("Avatar source request failed with status 503."),
      );
    });

    it("uploads an avatar and handles upload failures", async () => {
      queueFetchResponses(
        fetchMock,
        blobResponse(new Blob(["avatar-binary"], { type: "image/png" })),
        textResponse(
          '{ "images": { "full": "full.png", "medium": "medium", "0": "small" }, "success": true }',
        ),
        blobResponse(new Blob(["avatar-binary"], { type: "image/png" })),
        textResponse("denied"),
      );

      const client = createSeededClient();

      await expect(client.changeAvatar("https://example.com/avatar.png")).resolves.toBe("full.png");
      await expect(client.changeAvatar("https://example.com/avatar.png")).rejects.toThrow(
        new SteamWebError(ERRORS.NOT_LOGGEDIN),
      );
    });

    it("downloads the avatar source only once per upload attempt", async () => {
      queueFetchResponses(
        fetchMock,
        blobResponse(new Blob(["avatar-binary"], { type: "image/png" })),
        textResponse('{"success":true,"images":{"0":"small","full":"full.png","medium":"medium"}}'),
      );

      const client = createSeededClient();

      await expect(client.changeAvatar("https://example.com/avatar.png")).resolves.toBe("full.png");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect((fetchMock.mock.calls[0]?.[0] as Request).url).toBe("https://example.com/avatar.png");
      expect((fetchMock.mock.calls[1]?.[0] as Request).url).toBe(
        "https://steamcommunity.com/actions/FileUploader/",
      );
    });

    it("clears aliases and changes privacy", async () => {
      const privacyProfiles: number[] = [];

      fetchMock.mockImplementation(async (input: Request | string | URL) => {
        const request = input instanceof Request ? input : new Request(input);

        if (request.url.includes("ajaxsetprivacy")) {
          const privacy = JSON.parse(String((await request.formData()).get("Privacy")));
          privacyProfiles.push(privacy.PrivacyProfile);
          return textResponse('{ "success": 1 }');
        }

        return textResponse('{ "success": 1 }');
      });

      const client = createSeededClient();

      await expect(client.clearAliases()).resolves.toBeUndefined();
      await expect(client.changePrivacy("public")).resolves.toBeUndefined();
      await expect(client.changePrivacy("friendsOnly")).resolves.toBeUndefined();
      await expect(client.changePrivacy("private")).resolves.toBeUndefined();

      expect(privacyProfiles).toEqual([3, 2, 1]);
    });

    it("maps alias and privacy failures to not-logged-in", async () => {
      fetchMock.mockImplementation(async () => textResponse("denied"));

      const client = createSeededClient();

      await expect(client.clearAliases()).rejects.toThrow(new SteamWebError(ERRORS.NOT_LOGGEDIN));
      await expect(client.changePrivacy("public")).rejects.toThrow(
        new SteamWebError(ERRORS.NOT_LOGGEDIN),
      );
    });
  });
});
