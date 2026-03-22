import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpProxyAgent } from "http-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ERRORS, SteamWeb, SteamWebError } from "@/index";
import {
  parseAvatarFrameFromProfileHtml,
  parseFarmableGamesFromBadgesHtml,
} from "@/internal/html-parsers";
import { createFetch, createProxyAgent, parseProxyConfiguration } from "@/internal/proxy";
import { withHttpProxyServers, withServers } from "./helpers";

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

function queueFetchResponses(fetchMock: ReturnType<typeof vi.fn>, responses: Response[]): void {
  for (const response of responses) {
    fetchMock.mockResolvedValueOnce(response);
  }
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

  it.each([
    {
      expected: {
        protocol: "https",
        token: `Basic ${Buffer.from("user:pass").toString("base64")}`,
      },
      input: "https://user:pass@proxy.example:8443",
      url: {
        host: "proxy.example:8443",
        protocol: "https:",
      },
    },
    {
      expected: {
        password: "pa:ss",
        protocol: "socks5",
        username: "user",
      },
      input: "socks5://user:pa%3Ass@proxy.example:1080",
      url: {
        host: "proxy.example:1080",
        protocol: "socks5:",
      },
    },
    {
      expected: {
        password: undefined,
        protocol: "socks5",
        uri: "socks5://proxy.example:1080",
        username: undefined,
      },
      input: new URL("socks5://proxy.example:1080"),
      url: {
        host: "proxy.example:1080",
        protocol: "socks5:",
      },
    },
  ])("parses proxy configuration from %s", ({ expected, input, url }) => {
    const config = parseProxyConfiguration(input);

    expect(config).toMatchObject(expected);

    const proxyUrl = new URL(config.uri);
    expect(proxyUrl.protocol).toBe(url.protocol);
    expect(proxyUrl.host).toBe(url.host);
    expect(proxyUrl.username).toBe("");
    expect(proxyUrl.password).toBe("");
  });

  it.each([
    {
      input: "http://user@proxy.example:8080",
      token: `Basic ${Buffer.from("user:").toString("base64")}`,
    },
    {
      input: "http://:pass@proxy.example:8080",
      token: `Basic ${Buffer.from(":pass").toString("base64")}`,
    },
  ])("handles partial proxy credentials for %s", ({ input, token }) => {
    const config = parseProxyConfiguration(input);
    expect(config.token).toBe(token);
  });

  it("creates the correct proxy agent type for HTTP-family and SOCKS5 proxies", () => {
    expect(createProxyAgent("http://proxy.example:8080")).toBeInstanceOf(HttpProxyAgent);
    expect(createProxyAgent("https://proxy.example:8443")).toBeInstanceOf(HttpProxyAgent);
    expect(createProxyAgent("socks5://proxy.example:1080")).toBeInstanceOf(SocksProxyAgent);
  });

  it("rejects unsupported proxy protocols", () => {
    expect(() => createProxyAgent("ftp://proxy.example:21")).toThrowError(
      new TypeError("Unsupported proxy protocol. Expected one of: http, https, socks5."),
    );
  });

  it("rejects socks5h because the supported SOCKS protocol is socks5", () => {
    expect(() => createProxyAgent("socks5h://proxy.example:1080")).toThrowError(
      new TypeError("Unsupported proxy protocol. Expected one of: http, https, socks5."),
    );
  });

  it("returns the global fetch when no proxy URL is configured", () => {
    expect(createFetch()).toBe(fetch);
  });

  it("bypasses proxy handling for non-http urls", async () => {
    fetchMock.mockResolvedValueOnce(textResponse("ok"));
    fetchMock.mockResolvedValueOnce(textResponse("still-ok"));

    const proxiedFetch = createFetch("http://proxy.example:8080");

    const firstResponse = await proxiedFetch("data:text/plain,ok");
    const secondResponse = await proxiedFetch("data:text/plain,still-ok", {
      headers: { accept: "application/json" },
    });

    expect(proxiedFetch).not.toBe(fetch);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(firstResponse.text()).resolves.toBe("ok");
    await expect(secondResponse.text()).resolves.toBe("still-ok");
  });

  it("performs proxied http requests through an HTTP proxy", async () => {
    await withHttpProxyServers(
      (request, response) => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end(`upstream:${request.url}`);
      },
      async ({ proxyPort, upstreamPort }) => {
        const proxiedFetch = createFetch(`http://127.0.0.1:${proxyPort}`);
        const response = await proxiedFetch(`http://127.0.0.1:${upstreamPort}/proxy-check?ok=1`);

        await expect(response.text()).resolves.toBe("upstream:/proxy-check?ok=1");
      },
    );
  });

  it("handles redirect semantics through the proxy for 301, 303, and 307", async () => {
    await withHttpProxyServers(
      async (request, response) => {
        const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");

        if (requestUrl.pathname === "/post-301") {
          response.writeHead(301, { location: "/after-301" });
          response.end();
          return;
        }

        if (requestUrl.pathname === "/post-303") {
          response.writeHead(303, { location: "/after-303" });
          response.end();
          return;
        }

        if (requestUrl.pathname === "/post-307") {
          response.writeHead(307, { location: "/after-307" });
          response.end();
          return;
        }

        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }

        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            body: chunks.length === 0 ? "" : Buffer.concat(chunks).toString("utf8"),
            contentType: request.headers["content-type"] ?? null,
            method: request.method,
          }),
        );
      },
      async ({ proxyPort, upstreamPort }) => {
        const proxiedFetch = createFetch(`http://127.0.0.1:${proxyPort}`);

        const from301 = await proxiedFetch(`http://127.0.0.1:${upstreamPort}/post-301`, {
          body: "first",
          headers: { "content-type": "text/plain" },
          method: "POST",
        });
        const from303 = await proxiedFetch(`http://127.0.0.1:${upstreamPort}/post-303`, {
          body: "second",
          headers: { "content-type": "text/plain" },
          method: "POST",
        });
        const from307 = await proxiedFetch(`http://127.0.0.1:${upstreamPort}/post-307`, {
          body: "third",
          headers: { "content-type": "text/plain" },
          method: "POST",
        });

        await expect(from301.json()).resolves.toMatchObject({
          body: "",
          contentType: null,
          method: "GET",
        });
        await expect(from303.json()).resolves.toMatchObject({
          body: "",
          contentType: null,
          method: "GET",
        });
        await expect(from307.json()).resolves.toMatchObject({
          body: "third",
          contentType: "text/plain",
          method: "POST",
        });
      },
    );
  });

  it("returns redirect responses without location headers instead of following", async () => {
    await withHttpProxyServers(
      (request, response) => {
        response.writeHead(302, { "content-type": "text/plain" });
        response.end(`no-location:${request.method}`);
      },
      async ({ proxyPort, upstreamPort }) => {
        const proxiedFetch = createFetch(`http://127.0.0.1:${proxyPort}`);
        const response = await proxiedFetch(`http://127.0.0.1:${upstreamPort}/no-location`);

        expect(response.status).toBe(302);
        await expect(response.text()).resolves.toBe("no-location:GET");
      },
    );
  });

  it("throws after exceeding the max redirect depth", async () => {
    await withHttpProxyServers(
      (_, response) => {
        response.writeHead(302, { location: "/loop" });
        response.end();
      },
      async ({ proxyPort, upstreamPort }) => {
        const proxiedFetch = createFetch(`http://127.0.0.1:${proxyPort}`);

        await expect(proxiedFetch(`http://127.0.0.1:${upstreamPort}/loop`)).rejects.toThrow(
          new TypeError("Too many redirects."),
        );
      },
    );
  });

  it("surfaces CONNECT tunnel failures for HTTPS requests", async () => {
    const statusProxyServer = createServer();
    statusProxyServer.on("connect", (_request, clientSocket) => {
      clientSocket.end(
        "HTTP/1.1 407 Proxy Authentication Required\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n",
      );
    });

    const errorProxyServer = createServer();
    errorProxyServer.on("connect", (_request, clientSocket) => {
      clientSocket.destroy();
    });

    await withServers(
      [statusProxyServer, errorProxyServer],
      async ([statusProxyPort, errorProxyPort]) => {
        const statusFailingFetch = createFetch(`http://127.0.0.1:${statusProxyPort}`);
        const errorFailingFetch = createFetch(`http://127.0.0.1:${errorProxyPort}`);

        await expect(statusFailingFetch("https://example.com/")).rejects.toMatchObject({
          message: expect.stringMatching(/Proxy CONNECT failed with status 407\.|socket hang up/),
        });
        await expect(errorFailingFetch("https://example.com/")).rejects.toThrowError();
      },
    );
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

  it.each([
    {
      expected: null,
      html: "profile_avatar_frame",
    },
    {
      expected: null,
      html: "<div class='profile_avatar_frame'><span></span></div>",
    },
    {
      expected: null,
      html: "<div class='profile_avatar_frame'><img alt='x'></div>",
    },
    {
      expected: null,
      html: "<img class='profile_avatar_frame' src='https://example.com/frame.png'>",
    },
    {
      expected: null,
      html: "<div class='profile_avatar_frame'><img src='https://example.com/frame.png'></div",
    },
    {
      expected: null,
      html: "<1 class='profile_avatar_frame'>ignored</1>",
    },
    {
      expected: null,
      html: "<div data-kind='profile_avatar_frame'><img src='https://example.com/frame.png'></div>",
    },
    {
      expected: "https://example.com/frame.png",
      html: "<? class='profile_avatar_frame'>ignored<div class='profile_avatar_frame'><img src='https://example.com/frame.png'></div>",
    },
    {
      expected: null,
      html: "<section class='profile_avatar_frame'><img src='https://example.com/fallback.png'></span>",
    },
  ])("handles malformed avatar-frame markup defensively: %s", ({ expected, html }) => {
    expect(parseAvatarFrameFromProfileHtml(html)).toBe(expected);
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
    queueFetchResponses(fetchMock, [textResponse(badgesHtml), textResponse(profileHtml)]);

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
    queueFetchResponses(fetchMock, [
      textResponse("", { headers: { "content-length": "512", "content-type": "text/html" } }),
      textResponse("", {
        headers: {
          "content-length": String(1025 * 1024),
          "content-type": "image/png",
        },
      }),
    ]);

    const client = new SteamWeb();

    await expect(client.changeAvatar("https://example.com/avatar.png")).rejects.toThrowError(
      new SteamWebError("URL does not contain a JPEG or PNG image."),
    );
    await expect(client.changeAvatar("https://example.com/avatar.png")).rejects.toThrowError(
      new SteamWebError("Image size should not be larger than 1024 kB."),
    );
  });

  it("uploads an avatar and handles upload failures", async () => {
    queueFetchResponses(fetchMock, [
      textResponse("", { headers: { "content-length": "512", "content-type": "image/png" } }),
      textResponse("avatar-binary"),
      textResponse('{"success":true,"images":{"0":"small","full":"full.png","medium":"medium"}}'),
      textResponse("", { headers: { "content-length": "512", "content-type": "image/png" } }),
      textResponse("avatar-binary"),
      textResponse("denied"),
    ]);

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
