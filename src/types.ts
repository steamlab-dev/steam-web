export interface Options {
  proxyUrl?: string | URL;
}

export interface Session {
  sessionid: string;
  steamid: string;
  steamLoginSecure: {
    steamLoginSecure: string;
    expires: number;
  };
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
