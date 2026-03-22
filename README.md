# steam-web

`steam-web` is a small Node.js client for Steam Community account workflows that do not have a convenient public API surface.

It supports JWT-based login, session reuse, profile and inventory operations, and badge-page parsing for trading-card farming data.

## Requirements

- Node.js 22+

## Installation

```sh
npm i @fcastrocs/steamweb
```

## Features

- JWT login with Steam web tokens
- Session reuse without logging in again
- Optional Undici dispatcher support for proxies or custom transports
- Trading card farming detection from the badges page
- Trading card inventory fetching
- Avatar, alias-history, and privacy management helpers

## Usage

### Login

```ts
import SteamWeb from "@fcastrocs/steamweb";

const token = process.env.STEAM_WEB_REFRESH_TOKEN!;

const steamWeb = new SteamWeb();
const session = await steamWeb.login(token);
```

### Use a proxy or custom Undici dispatcher

```ts
import SteamWeb from "@fcastrocs/steamweb";
import { ProxyAgent } from "undici";

const dispatcher = new ProxyAgent("http://user:password@proxy-host:8080");
const steamWeb = new SteamWeb({ dispatcher });

await steamWeb.login(process.env.STEAM_WEB_REFRESH_TOKEN!);
```

### Reuse an existing session

```ts
import SteamWeb from "@fcastrocs/steamweb";

const steamWeb = new SteamWeb();

await steamWeb.setSession({
  cookies: "steamLoginSecure=...; sessionid=...;",
  sessionid: "...",
  steamid: "7656119...",
});
```

### Read farmable games and avatar frame

```ts
const farmableGames = await steamWeb.getFarmableGames();
const avatarFrame = await steamWeb.getAvatarFrame();
```

## API

```ts
setSession(session: Session): Promise<void>;
login(token: string): Promise<Session>;
logout(): Promise<void>;
getFarmableGames(): Promise<FarmableGame[]>;
getCardsInventory(): Promise<Item[]>;
changeAvatar(avatarURL: string): Promise<string>;
clearAliases(): Promise<void>;
changePrivacy(privacy: ProfilePrivacy): Promise<void>;
getAvatarFrame(): Promise<string | null>;
```

## Notes

- `getFarmableGames()` depends on the current Steam badges page HTML, so parser adjustments may be needed when Steam changes markup.
- Integration tests require `STEAM_WEB_REFRESH_TOKEN` to be set in the environment.
