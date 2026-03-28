import { randomBytes } from "node:crypto";
import { URLSearchParams } from "node:url";
import Fetch from "./internal/Fetch";
import {
  parseAvatarFrameFromProfileHtml,
  parseFarmableGamesFromBadgesHtml,
} from "./internal/html-parsers";
import type { FarmableGame, Item, Options, ProfilePrivacy, Session } from "./types";

export type {
  FarmableGame,
  Item,
  Options,
  ProfilePrivacy,
  Session,
} from "./types";

export const ERRORS = {
  RATE_LIMIT: "RateLimitExceeded",
  NOT_LOGGEDIN: "NotLoggedIn",
  TOKEN_EXPIRED: "TokenExpired",
  INVALID_TOKEN: "InvalidToken",
} as const;

export class SteamWebError extends Error {
  constructor(message: string) {
    super(message);
    super.name = "steam-web";
  }
}

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64; Valve Steam Client/default/0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.183 Safari/537.36";
const FINALIZE_LOGIN_URL = "https://login.steampowered.com/jwt/finalizelogin";
const PROFILE_URL = "https://steamcommunity.com/profiles";
const AVATAR_UPLOAD_URL = "https://steamcommunity.com/actions/FileUploader/";
const PROFILE_PRIVACY_LEVEL: Record<ProfilePrivacy, number> = {
  friendsOnly: 2,
  private: 1,
  public: 3,
};
const PUBLIC_PRIVACY_SETTINGS = {
  PrivacyInventory: 3,
  PrivacyInventoryGifts: 3,
  PrivacyOwnedGames: 3,
  PrivacyPlaytime: 3,
  PrivacyFriendsList: 3,
};

type TransferInfo = { url: string; params: Record<string, string> };
type FinalizeLoginResponse = { transfer_info?: TransferInfo[] };
type TransferResponseBody = { result?: number };
type FetchOptions = { headers: Headers };
type AvatarUploadResponse = {
  success: boolean;
  images: { "0": string; full: string; medium: string };
  hash: string;
  message: string;
};
type InventoryResponse = {
  success: boolean;
  Error?: string;
  rgInventory: Record<
    string,
    {
      id: string;
      classid: string;
      instanceid: string;
      amount: string;
    }
  >;
  rgDescriptions: Record<
    string,
    {
      icon_url: string;
      name: string;
      type: string;
      tradable: number;
    }
  >;
};
type Payload = {
  iss: string;
  sub: string;
  aud: string[];
  exp: number;
  nbf: number;
  iat: number;
  jti: string;
  oat: number;
  per: number;
  ip_subject: string;
  ip_confirmer: string;
};
type SteamLoginSecureCookie = Session["steamLoginSecure"];

export type SteamWebSession = Session;

type ParsedSetCookie = { raw: string; name: string; value: string };
type SuccessResponse = { success?: boolean | number };

/**
 * Steam community helper focused on JWT-based login, session reuse, and profile/inventory actions.
 *
 * This package does not acquire Steam tokens on its own. It expects a Steam web JWT obtained
 * elsewhere and accepts either a refresh token or an access token in `login()`.
 */
export class SteamWeb {
  private readonly fetchImpl: typeof fetch;
  private cookieJar = new Map<string, string>();
  private fetchOptions: FetchOptions = { headers: new Headers({ "User-Agent": USER_AGENT }) };
  private steamWebSession = this.createEmptySession();

  constructor(options?: Options) {
    this.fetchImpl = new Fetch(options?.proxyUrl).fetch;
  }

  async login(token: string): Promise<SteamWebSession> {
    const { payload } = this.verifyToken(token);
    const steamid = payload.sub;
    const isRefreshToken = payload.aud.includes("renew");
    const session = this.createEmptySession();

    session.sessionid = randomBytes(12).toString("hex");
    session.steamid = steamid;
    if (!isRefreshToken) {
      session.steamLoginSecure = this.createSteamLoginSecureCookie(steamid, token);
    }

    this.applySession(session);

    if (isRefreshToken) {
      this.steamWebSession.steamLoginSecure = await this.finalizeLogin(token);
      this.applySession(this.steamWebSession, false);
    }

    return this.cloneSession(this.steamWebSession);
  }

  /** Clear the current Steam web session. */
  async logout(): Promise<void> {
    this.applySession(this.createEmptySession());
  }

  setSession(session: SteamWebSession): void {
    this.applySession(this.cloneSession(session));
  }

  private applySession(session: SteamWebSession, resetCookies = true): void {
    this.steamWebSession = session;
    if (resetCookies) {
      this.cookieJar.clear();
    }

    if (session.sessionid) {
      this.cookieJar.set("sessionid", session.sessionid);
    }
    if (session.steamLoginSecure.steamLoginSecure) {
      this.cookieJar.set("steamLoginSecure", session.steamLoginSecure.steamLoginSecure);
    }

    this.applyCookiesToHeaders();
  }

  /** Return games that still have Steam trading cards left to drop. */
  async getFarmableGames(): Promise<FarmableGame[]> {
    return this.parseFarmingData(await this.fetchText(this.requireProfileUrl("badges")));
  }

  /** Return the current profile avatar frame image URL if one exists. */
  async getAvatarFrame(): Promise<string | null> {
    return parseAvatarFrameFromProfileHtml(await this.fetchText(this.requireProfileUrl()));
  }

  /** Return the current trading card inventory. */
  async getCardsInventory(): Promise<Item[]> {
    const contextId = "6";
    const data = await this.fetchJson<InventoryResponse>(
      this.requireProfileUrl("inventory", "json", "753", contextId),
    );
    if (data.success) {
      return this.parseItems(data, contextId);
    }
    if (data.Error === "This profile is private.") {
      throw new SteamWebError(ERRORS.NOT_LOGGEDIN);
    }
    throw data;
  }

  /** Upload a new profile avatar from a remote JPEG or PNG URL. */
  async changeAvatar(avatarURL: string): Promise<string> {
    const blob = await this.fetchAvatarBlob(avatarURL);
    const form = new FormData();

    form.append("name", "avatar");
    form.append("filename", "blob");
    form.append("avatar", blob);
    form.append("type", "player_avatar_image");
    form.append("sId", this.steamWebSession.steamid);
    form.append("sessionid", this.steamWebSession.sessionid);
    form.append("doSub", "1");
    form.append("json", "1");

    const data = await this.fetchJsonResponse<AvatarUploadResponse>(AVATAR_UPLOAD_URL, {
      body: form,
      method: "POST",
    });
    if (!data?.success) {
      throw new SteamWebError(ERRORS.NOT_LOGGEDIN);
    }
    return data.images.full;
  }

  /** Clear the account's alias history. */
  async clearAliases(): Promise<void> {
    await this.expectSuccess(
      `${this.requireProfileUrl("ajaxclearaliashistory")}/`,
      new URLSearchParams({ sessionid: this.steamWebSession.sessionid }),
    );
  }

  /** Update profile visibility while keeping related privacy flags public. */
  async changePrivacy(privacy: ProfilePrivacy): Promise<void> {
    const form = new FormData();

    form.append("sessionid", this.steamWebSession.sessionid);
    form.append(
      "Privacy",
      JSON.stringify({
        ...PUBLIC_PRIVACY_SETTINGS,
        PrivacyProfile: PROFILE_PRIVACY_LEVEL[privacy],
      }),
    );
    form.append("eCommentPermission", "1");

    await this.expectSuccess(`${this.requireProfileUrl("ajaxsetprivacy")}/`, form);
  }

  private createEmptySession(): SteamWebSession {
    return {
      sessionid: "",
      steamid: "",
      steamLoginSecure: { steamLoginSecure: "", expires: 0 },
    };
  }

  private createSteamLoginSecureCookie(steamid: string, token: string): SteamLoginSecureCookie {
    return { steamLoginSecure: encodeURIComponent(`${steamid}||${token}`), expires: 0 };
  }

  private cloneSession(session: SteamWebSession): SteamWebSession {
    return {
      sessionid: session.sessionid,
      steamid: session.steamid,
      steamLoginSecure: { ...session.steamLoginSecure },
    };
  }

  private requireProfileUrl(...segments: string[]): string {
    if (!this.steamWebSession.steamid) {
      throw new SteamWebError(ERRORS.NOT_LOGGEDIN);
    }
    return `${PROFILE_URL}/${encodeURIComponent(this.steamWebSession.steamid)}${segments.length ? `/${segments.join("/")}` : ""}`;
  }

  private mergeResponseCookies(response: Response): void {
    for (const { name, value } of this.readSetCookies(response)) {
      if (value === "") {
        this.cookieJar.delete(name);
      } else {
        this.cookieJar.set(name, value);
      }
    }
  }

  private applyCookiesToHeaders(): void {
    const cookies = Array.from(this.cookieJar, ([name, value]) => `${name}=${value}`).join("; ");
    if (cookies) {
      this.fetchOptions.headers.set("cookie", cookies);
    } else {
      this.fetchOptions.headers.delete("cookie");
    }
  }

  private readSetCookies(response: Response): ParsedSetCookie[] {
    return (response.headers.getSetCookie?.() ?? []).flatMap((raw) => {
      const pair = raw.split(";", 1)[0]?.trim() ?? "";
      const eq = pair?.indexOf("=") ?? -1;
      const name = eq > 0 ? pair.slice(0, eq).trim() : "";
      return name ? [{ raw, name, value: pair.slice(eq + 1) }] : [];
    });
  }

  private async finalizeLogin(refreshToken: string): Promise<SteamLoginSecureCookie> {
    const response = await this.request(FINALIZE_LOGIN_URL, {
      body: new URLSearchParams({
        nonce: refreshToken,
        redir: "https://steamcommunity.com/login/?redir=&redir_ssl=1",
        sessionid: this.steamWebSession.sessionid,
      }),
      method: "POST",
    });
    const data = (await response.json()) as FinalizeLoginResponse;
    const transfer = data.transfer_info?.find((item) => this.isSteamCommunityTransfer(item.url));

    if (!transfer) {
      throw new SteamWebError(
        data.transfer_info?.length
          ? "Login failed: no transfer info received for steamcommunity.com."
          : "Login failed: no transfer info received.",
      );
    }

    return this.fetchSteamLoginSecureCookie(transfer);
  }

  private async fetchSteamLoginSecureCookie(
    transfer: TransferInfo,
  ): Promise<SteamLoginSecureCookie> {
    const response = await this.request(transfer.url, {
      body: new URLSearchParams({ ...transfer.params, steamID: this.steamWebSession.steamid }),
      method: "POST",
    });
    const steamLoginSecureCookie = this.parseCookie(response);

    if (!steamLoginSecureCookie) {
      const body = await this.readJson<TransferResponseBody>(response);
      const cookies =
        this.readSetCookies(response)
          .map(({ name }) => name)
          .join(", ") || "none";
      throw new SteamWebError(
        `Login failed: steamcommunity token transfer did not issue steamLoginSecure (result=${body?.result ?? "unknown"}, set-cookie=${cookies}).`,
      );
    }

    return steamLoginSecureCookie;
  }

  private isSteamCommunityTransfer(url: string): boolean {
    try {
      return new URL(url).hostname === "steamcommunity.com";
    } catch {
      return false;
    }
  }

  private parseCookie(response: Response): SteamLoginSecureCookie | null {
    const cookie = this.readSetCookies(response).find(
      ({ name, value }) => name === "steamLoginSecure" && value,
    );
    if (!cookie) {
      return null;
    }

    const expires = /(?:^|;\s*)expires=([^;]+)/i.exec(cookie.raw)?.[1];
    return {
      steamLoginSecure: cookie.value,
      expires: expires && !Number.isNaN(Date.parse(expires)) ? Date.parse(expires) : 0,
    };
  }

  private verifyToken(token: string): { payload: Payload } {
    try {
      const encodedPayload = token.split(".")[1];
      if (!encodedPayload) {
        throw new SteamWebError(ERRORS.INVALID_TOKEN);
      }

      const payload = JSON.parse(
        Buffer.from(encodedPayload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
          "utf8",
        ),
      ) as Payload;

      if (!payload.aud.includes("web")) {
        throw new SteamWebError("Token audience is not valid for web.");
      }
      if (payload.exp <= Math.floor(Date.now() / 1000)) {
        throw new SteamWebError(ERRORS.TOKEN_EXPIRED);
      }

      return { payload };
    } catch (error) {
      if (error instanceof SteamWebError) {
        throw error;
      }
      if (error instanceof SyntaxError || error instanceof TypeError) {
        throw new SteamWebError(ERRORS.INVALID_TOKEN);
      }
      throw error;
    }
  }

  private async fetchAvatarBlob(avatarURL: string): Promise<Blob> {
    const source = await this.fetchImpl(avatarURL);
    if (!source.ok) {
      throw new SteamWebError(`Avatar source request failed with status ${source.status}.`);
    }

    const blob = await source.blob();
    const contentType = blob.type || source.headers.get("content-type") || "";

    if (!contentType.includes("image/jpeg") && !contentType.includes("image/png")) {
      throw new SteamWebError("URL does not contain a JPEG or PNG image.");
    }
    if (blob.size > 1024 * 1024) {
      throw new SteamWebError("Image size should not be larger than 1024 kB.");
    }

    return blob;
  }

  private async expectSuccess(url: string, body: FormData | URLSearchParams): Promise<void> {
    const data = await this.fetchJsonResponse<SuccessResponse>(url, { body, method: "POST" });
    if (data?.success !== 1 && data?.success !== true) {
      throw new SteamWebError(ERRORS.NOT_LOGGEDIN);
    }
  }

  private async request(url: string, init?: Omit<RequestInit, "headers">): Promise<Response> {
    const response = await this.fetchImpl(url, { ...this.fetchOptions, ...init });
    this.mergeResponseCookies(response);
    this.applyCookiesToHeaders();
    this.validateRes(response);
    return response;
  }

  private async fetchText(url: string, init?: Omit<RequestInit, "headers">): Promise<string> {
    return (await this.request(url, init)).text();
  }

  private async fetchJson<T>(url: string, init?: Omit<RequestInit, "headers">): Promise<T> {
    return (await this.request(url, init)).json() as Promise<T>;
  }

  private async fetchJsonResponse<T>(
    url: string,
    init?: Omit<RequestInit, "headers">,
  ): Promise<T | null> {
    return this.readJson<T>(await this.request(url, init));
  }

  private async readJson<T>(response: Response): Promise<T | null> {
    try {
      const text = await response.clone().text();
      return text ? (JSON.parse(text) as T) : null;
    } catch {
      return null;
    }
  }

  private parseItems(data: InventoryResponse, contextId: string): Item[] {
    const items: Item[] = [];

    for (const inventoryItem of Object.values(data.rgInventory)) {
      if (!inventoryItem) {
        continue;
      }

      const description =
        data.rgDescriptions[`${inventoryItem.classid}_${inventoryItem.instanceid}`];
      if (!description) {
        continue;
      }

      items.push({
        assetid: inventoryItem.id,
        amount: inventoryItem.amount,
        icon: description.icon_url,
        name: description.name,
        type: description.type,
        tradable: description.tradable === 1,
        contextId,
      });
    }

    return items;
  }

  private parseFarmingData(html: string): FarmableGame[] {
    try {
      return parseFarmableGamesFromBadgesHtml(html);
    } catch (error) {
      if (error instanceof Error && error.message === ERRORS.NOT_LOGGEDIN) {
        throw new SteamWebError(ERRORS.NOT_LOGGEDIN);
      }
      throw error;
    }
  }

  private validateRes(response: Response) {
    if (response.status === 429) {
      throw new SteamWebError(ERRORS.RATE_LIMIT);
    }
    if (response.status === 401) {
      throw new SteamWebError(ERRORS.NOT_LOGGEDIN);
    }
    if (!response.ok) {
      throw response;
    }
  }
}

export default SteamWeb;
