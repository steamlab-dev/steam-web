# steam-web

`steam-web` is a small Node.js client for Steam Community account workflows that do not have a convenient public API surface.

It focuses on JWT-based login, session reuse, inventory/profile helpers, and badge-page parsing for trading-card farming data.

## Requirements

- Node.js 22+

## Installation

```sh
npm i @steamlab/steam-web
```

## Features

- Login with Steam web JWTs
- Reuse an authenticated Steam web session across processes
- HTTPS and SOCKS5 proxy support
- Trading card farming detection from the badges page
- Trading card inventory fetching
- Avatar upload, alias-history clearing, privacy updates, and avatar-frame parsing

## Usage

### Login

```ts
import { SteamWeb } from "@steamlab/steam-web";

const token = "REFRESH_TOKEN or ACCESS_TOKEN";

const steamWeb = new SteamWeb();
const session = await steamWeb.login(token);
```

`login()` accepts either:

- a refresh token, which finalizes a fresh Steam web session and stores the returned cookies
- an access token, which skips the extra finalization step but may expire sooner

This package does not acquire Steam tokens for you. It is intended to be used with a separate Steam authentication client.

### Reuse an existing session to skip login flow

```ts
import { SteamWeb, type SteamWebSession } from "@steamlab/steam-web";

const session: SteamWebSession = { ... };

const steamWeb = new SteamWeb();
steamWeb.setSession(session);

const inventory = await steamWeb.getCardsInventory();
```

`setSession()` rejects restored sessions whose `steamLoginSecure.expires` timestamp is already in the past. A value of `0` is still allowed for sessions whose cookie expiry is unknown, such as access-token-based sessions.

`logout()` only clears the in-memory session state held by the client instance.

### Use a proxy

`steam-web` currently supports these proxy URL schemes:

- `https://`
- `socks5://`

```ts
import { SteamWeb } from "@steamlab/steam-web";

const steamWeb = new SteamWeb({
  proxyUrl: "socks5://user:password@proxy-host:1080",
});
```

### Read farming data and profile helpers

```ts
const farmableGames = await steamWeb.getFarmableGames();
const avatarFrame = await steamWeb.getAvatarFrame();
const inventory = await steamWeb.getCardsInventory();
```

### Update profile state

```ts
await steamWeb.changeAvatar("https://example.com/avatar.png");
await steamWeb.clearAliases();
await steamWeb.changePrivacy("friendsOnly");
```

### Handle library errors

```ts
import { ERRORS, SteamWeb, SteamWebError } from "@steamlab/steam-web";

try {
  await new SteamWeb().login(token);
} catch (error) {
  if (error instanceof SteamWebError && error.message === ERRORS.TOKEN_EXPIRED) {
    // refresh or reacquire the token
  }
}
```

## API

```ts
new SteamWeb(options?: {
  proxyUrl?: string | URL;
});

login(token: string): Promise<SteamWebSession>;
logout(): Promise<void>;
setSession(session: SteamWebSession): void;
getFarmableGames(): Promise<FarmableGame[]>;
getAvatarFrame(): Promise<string | null>;
getCardsInventory(): Promise<Item[]>;
changeAvatar(avatarURL: string): Promise<string>;
clearAliases(): Promise<void>;
changePrivacy(privacy: "public" | "friendsOnly" | "private"): Promise<void>;
```

`setSession()` throws `SteamWebError(ERRORS.TOKEN_EXPIRED)` when the restored `steamLoginSecure.expires` value is non-zero and already expired.

Also exported:

- `SteamWebError` for library-specific failures
- `ERRORS` for the library's standard error message constants
- `SteamWebSession`, `Session`, `Options`, `FarmableGame`, `Item`, and `ProfilePrivacy` for public TypeScript types

## Development

- `npm run build` builds the distributable package with `tsdown`.
- `npm run check` runs Biome.
- `npm run test` runs the unit test suite.
- `npm run test:coverage` runs the unit suite with coverage.
- `npm run test:fetch` runs the live proxy fetch integration tests and requires Docker.
- `npm run test:live` runs the authenticated Steam integration tests and reads `STEAM_WEB_REFRESH_TOKEN` from `tests/.env` (see `tests/.env.example`).
