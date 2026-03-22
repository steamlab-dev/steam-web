export interface ISteamWeb {
  setSession(session: Session): Promise<void>;
  login(token: string): Promise<Session>;
  logout(): Promise<void>;
  getFarmableGames(): Promise<FarmableGame[]>;
  getCardsInventory(): Promise<Item[]>;
  changeAvatar(avatarURL: string): Promise<string>;
  clearAliases(): Promise<void>;
  changePrivacy(privacy: ProfilePrivacy): Promise<void>;
  getAvatarFrame(): Promise<string | null>;
}

export interface Options {
  proxyUrl?: string | URL;
}

export interface FetchOptions {
  headers: Headers;
}

export interface Session {
  cookies: string;
  sessionid: string;
  steamid: string;
}

export interface FarmableGame {
  name: string;
  appId: number;
  playTime: number;
  remainingCards: number;
  droppedCards: number;
}

export interface Item {
  assetid: string;
  amount: string;
  icon: string;
  name: string;
  type: string;
  tradable: boolean;
  contextId: string;
}

export type ProfilePrivacy = "public" | "friendsOnly" | "private";

export interface AvatarUploadResponse {
  success: boolean;
  images: { "0": string; full: string; medium: string };
  hash: string;
  message: string;
}

export interface InventoryResponse {
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
}

export interface FinalizeloginRes {
  steamID: string;
  redir: string;
  transfer_info: Array<{
    url: string;
    params: { nonce: string; auth: string };
  }>;
  primary_domain: string;
  success?: boolean;
  error?: number;
}

export interface Payload {
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
}

export interface Notifications {
  notifications: {
    "1": number;
    "2": number;
    "3": number;
    "4": number;
    "5": number;
    "6": number;
    "8": number;
    "9": number;
    "10": number;
    "11": number;
  };
}
