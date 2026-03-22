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
- HTTP, HTTPS, and SOCKS5 proxy support
- Trading card farming detection from the badges page
- Trading card inventory fetching
- Avatar, alias-history, and privacy management helpers

## Usage

### Login

```ts
import { SteamWeb } from "@fcastrocs/steamweb";

const token = process.env.STEAM_WEB_REFRESH_TOKEN!;

const steamWeb = new SteamWeb();
const session = await steamWeb.login(token);
```

### Use a proxy

```ts
import { SteamWeb } from "@fcastrocs/steamweb";

const steamWeb = new SteamWeb({
  proxyUrl: "http://user:password@proxy-host:8080",
});

await steamWeb.login(process.env.STEAM_WEB_REFRESH_TOKEN!);
```

Supported proxy URL schemes are `http://`, `https://`, and `socks5://`.

Authentication can be provided directly in the proxy URL, for example `socks5://user:password@proxy-host:1080`.

Proxy transport is implemented with the native Node.js `fetch` API plus proxy agent packages. The public API remains `proxyUrl`.

### Reuse an existing session

```ts
import { SteamWeb } from "@fcastrocs/steamweb";

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
