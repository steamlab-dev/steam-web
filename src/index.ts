import { randomBytes } from "node:crypto";
import { URLSearchParams } from "node:url";
import {
  parseAvatarFrameFromProfileHtml,
  parseFarmableGamesFromBadgesHtml,
} from "./internal/html-parsers";
import { createFetch } from "./internal/proxy";
import SteamWebError from "./SteamWebError.js";
import type {
  AvatarUploadResponse,
  FarmableGame,
  FetchOptions,
  InventoryResponse,
  ISteamWeb,
  Item,
  Options,
  Payload,
  ProfilePrivacy,
  Session,
} from "./types";

export type {
  AvatarUploadResponse,
  FarmableGame,
  FetchOptions,
  InventoryResponse,
  ISteamWeb,
  Item,
  Notifications,
  Options,
  Payload,
  ProfilePrivacy,
  Session,
} from "./types";
export { SteamWebError };

export const ERRORS = {
  RATE_LIMIT: "RateLimitExceeded",
  NOT_LOGGEDIN: "NotLoggedIn",
  TOKEN_EXPIRED: "TokenExpired",
  INVALID_TOKEN: "InvalidToken",
} as const;

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64; Valve Steam Client/default/0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.183 Safari/537.36";
const GENERATE_ACCESS_TOKEN_URL =
  "https://api.steampowered.com/IAuthenticationService/GenerateAccessTokenForApp/v1";

export class SteamWeb implements ISteamWeb {
  private steamid = "";
  private sessionid = randomBytes(12).toString("hex");
  private readonly fetchImpl: typeof fetch;
  private fetchOptions: FetchOptions = {
    headers: new Headers(),
  };
  private refreshToken = "";

  constructor(private readonly options?: Options) {
    this.fetchImpl = createFetch(this.options?.proxyUrl);
    this.fetchOptions.headers.set("User-Agent", USER_AGENT);
    this.fetchOptions.headers.set("Cookie", "");
  }

  /** Reuse a previously established Steam session. */
  async setSession(session: Session): Promise<void> {
    this.sessionid = session.sessionid;
    this.steamid = session.steamid;
    this.fetchOptions.headers.set("Cookie", session.cookies);
  }

  /** Log into Steamcommunity.com with a JWT access or refresh token. */
  async login(token: string): Promise<Session> {
    const { payload } = this.verifyToken(token);
    this.steamid = payload.sub;
    this.refreshToken = token;

    // Steam sets the cookies we need as part of this app-token bootstrap call.
    await this.generateAccessTokenForApp();

    return {
      cookies: this.fetchOptions.headers.get("Cookie") ?? "",
      sessionid: this.sessionid,
      steamid: this.steamid,
    };
  }

  private async generateAccessTokenForApp(): Promise<void> {
    const params = new URLSearchParams({
      access_token: this.refreshToken,
      key: "5C97A7C241055E3A36E95B7EED8A66FC",
      steamid: this.steamid,
    });
    const response = await this.fetchImpl(`${GENERATE_ACCESS_TOKEN_URL}?${params.toString()}`, {
      ...this.fetchOptions,
      method: "POST",
    });

    this.setCookieHeader(response.headers.get("set-cookie"));
  }

  /** Clear the current Steam web session. */
  async logout(): Promise<void> {
    const form = new FormData();
    form.append("sessionid", this.sessionid);
    await this.fetchImpl("https://store.steampowered.com/logout/", {
      ...this.fetchOptions,
      method: "POST",
      body: form,
    });
    this.fetchOptions.headers.set("Cookie", "");
  }

  private verifyToken(token: string): { payload: Payload } {
    try {
      const encodedPayload = token.split(".")[1];
      if (!encodedPayload) {
        throw new SteamWebError(ERRORS.INVALID_TOKEN);
      }

      const buff = Buffer.from(encodedPayload, "base64");
      const payload = JSON.parse(buff.toString("utf8")) as Payload;

      if (!payload.aud.includes("web")) {
        throw new SteamWebError("Token audience is not valid for web.");
      }

      const currTime = ~~(Date.now() / 1000);
      const timeLeft = payload.exp - currTime;

      // don't accept tokens that are about to expire
      if (timeLeft / 60 < 1) {
        throw new SteamWebError(ERRORS.TOKEN_EXPIRED);
      }

      return { payload };
    } catch (error) {
      if (
        error instanceof SteamWebError ||
        error instanceof SyntaxError ||
        error instanceof TypeError
      ) {
        throw new SteamWebError(ERRORS.INVALID_TOKEN);
      }
      throw error;
    }
  }

  /** Merge cookies from a Set-Cookie header into the shared Cookie header. */
  private setCookieHeader(strCookies: string | null): void {
    if (!strCookies) {
      return;
    }

    const cookies = new Map<string, string>();

    strCookies.split(",").forEach((c) => {
      const rawCookie = c.split("; Path")[0];
      if (!rawCookie) {
        return;
      }

      const [name, value] = rawCookie.trim().split("=");
      if (!name || value === undefined) {
        return;
      }

      cookies.set(name, value);
    });

    for (const [name, value] of cookies) {
      this.setCookie(name, value);

      if (name === "sessionid") {
        this.sessionid = value;
      }
    }
  }

  /** Prepend a cookie value so later writes override older ones by name. */
  private setCookie(name: string, value: string): void {
    const cookie = `${name}=${value}`;
    let cookies = this.fetchOptions.headers.get("Cookie") ?? "";
    cookies = `${cookie}; ${cookies}`;
    this.fetchOptions.headers.set("Cookie", cookies);
  }

  /** Return games that still have Steam trading cards left to drop. */
  async getFarmableGames(): Promise<FarmableGame[]> {
    const url = `https://steamcommunity.com/profiles/${this.steamid}/badges`;
    const html = await this.fetchText(url);
    return this.parseFarmingData(html);
  }

  /** Return the current profile avatar frame image URL if one exists. */
  async getAvatarFrame(): Promise<string | null> {
    const url = `https://steamcommunity.com/profiles/${this.steamid}`;
    return parseAvatarFrameFromProfileHtml(await this.fetchText(url));
  }

  /** Return the current trading card inventory. */
  async getCardsInventory(): Promise<Item[]> {
    const contextId = "6"; // trading cards
    const url = `https://steamcommunity.com/profiles/${this.steamid}/inventory/json/753/${contextId}`;
    const data = await this.fetchJson<InventoryResponse>(url);

    if (!data.success) {
      if (data.Error === "This profile is private.") {
        throw new SteamWebError(ERRORS.NOT_LOGGEDIN);
      }

      throw data;
    }

    const items = this.parseItems(data, contextId);
    return items;
  }

  /** Upload a new profile avatar from a remote JPEG or PNG URL. */
  async changeAvatar(avatarURL: string): Promise<string> {
    let res = await this.fetchImpl(avatarURL, { method: "HEAD" });
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("image/jpeg") && !contentType.includes("image/png")) {
      throw new SteamWebError("URL does not contain a JPEG or PNG image.");
    }

    if (Number.parseInt(res.headers.get("content-length") ?? "0", 10) / 1024 > 1024) {
      throw new SteamWebError("Image size should not be larger than 1024 kB.");
    }

    const blob = await this.fetchImpl(avatarURL).then((res) => res.blob());
    const url = "https://steamcommunity.com/actions/FileUploader/";

    const form = new FormData();
    form.append("name", "avatar");
    form.append("filename", "blob");
    form.append("avatar", blob);
    form.append("type", "player_avatar_image");
    form.append("sId", this.steamid);
    form.append("sessionid", this.sessionid);
    form.append("doSub", "1");
    form.append("json", "1");

    res = await this.fetchImpl(url, { ...this.fetchOptions, method: "POST", body: form });
    this.validateRes(res);
    const text = await res.text();

    if (!text.includes(`{"success":true,`)) {
      throw new SteamWebError(ERRORS.NOT_LOGGEDIN);
    }

    const json: AvatarUploadResponse = JSON.parse(text);
    return json.images.full;
  }

  /** Clear the account's alias history. */
  async clearAliases(): Promise<void> {
    const url = `https://steamcommunity.com/profiles/${this.steamid}/ajaxclearaliashistory/`;

    const params = new URLSearchParams();
    params.append("sessionid", this.sessionid);

    const text = await this.fetchText(url, { body: params, method: "POST" });
    if (!text.includes('{"success":1')) {
      throw new SteamWebError(ERRORS.NOT_LOGGEDIN);
    }
  }

  /** Update profile visibility while keeping related privacy flags public. */
  async changePrivacy(privacy: ProfilePrivacy): Promise<void> {
    const url = `https://steamcommunity.com/profiles/${this.steamid}/ajaxsetprivacy/`;

    const settings = {
      PrivacyProfile: 3,
      PrivacyInventory: 3,
      PrivacyInventoryGifts: 3,
      PrivacyOwnedGames: 3,
      PrivacyPlaytime: 3,
      PrivacyFriendsList: 3,
    };

    if (privacy === "public") {
      settings.PrivacyProfile = 3;
    } else if (privacy === "friendsOnly") {
      settings.PrivacyProfile = 2;
    } else if (privacy === "private") {
      settings.PrivacyProfile = 1;
    }

    const form = new FormData();
    form.append("sessionid", this.sessionid);
    form.append("Privacy", JSON.stringify(settings));
    form.append("eCommentPermission", "1");

    const text = await this.fetchText(url, { body: form, method: "POST" });
    if (!text.includes('{"success":1')) {
      throw new SteamWebError(ERRORS.NOT_LOGGEDIN);
    }
  }

  private async fetchText(url: string, init?: Omit<RequestInit, "headers">): Promise<string> {
    const response = await this.fetchImpl(url, { ...this.fetchOptions, ...init });
    this.validateRes(response);
    return response.text();
  }

  private async fetchJson<T>(url: string, init?: Omit<RequestInit, "headers">): Promise<T> {
    const response = await this.fetchImpl(url, { ...this.fetchOptions, ...init });
    this.validateRes(response);
    return (await response.json()) as T;
  }

  private parseItems(data: InventoryResponse, contextId: string): Item[] {
    const inventory = data.rgInventory;
    const description = data.rgDescriptions;

    const items: Item[] = [];

    for (const key in inventory) {
      const inventoryItem = inventory[key];
      if (!inventoryItem) {
        continue;
      }

      const c_i = `${inventoryItem.classid}_${inventoryItem.instanceid}`;
      const itemDescription = description[c_i];
      if (!itemDescription) {
        continue;
      }

      items.push({
        assetid: inventoryItem.id,
        amount: inventoryItem.amount,
        icon: itemDescription.icon_url,
        name: itemDescription.name,
        type: itemDescription.type,
        tradable: itemDescription.tradable === 1,
        contextId,
      });
    }
    return items;
  }

  /** Preserve the public error type while delegating the badge-page parsing work. */
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

  /** Normalize common Steam HTTP failures into the library's public error contract. */
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
