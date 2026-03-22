# steam-web

steam-web is a Node.js module to interact with steamcommunity.com. It provides an easy API to important account data that is otherwise hard to obtain programmatically without scraping it.

## Installation

```sh
npm i @machiavelli/steam-web
```

## Features

- New steam login support (JWT)
- Login using access_token.
- Login using refresh_token.
- Re-use previous session.
- Proxy support.

## Usage

### connect directly

```javascript
import SteamWeb from "@machiavelli/steam-web";

// these tokens are obtainable through the steam-client
const token = access_token || refresh_token;

const steamWeb = new SteamWeb();
const session = await steamWeb.login(token);
```

### connect through proxy

```javascript
import SteamWeb from "@machiavelli/steam-web";
import { ProxyAgent } from "undici";

const dispatcher = new ProxyAgent("http://user:password@proxy-host:8080");

const steamWeb = new SteamWeb({ dispatcher });
const session = await steamWeb.login(token);
```

### Re-use previous session to skip login

```javascript
import SteamWeb from "@machiavelli/steam-web";

// session is returned by login()
const steamWeb = new SteamWeb();
await steamWeb.setSession(session);
```

## Methods

```javascript
  /**
   * Re-use a previous session, thus we don't have to login again
   */
  setSession(session: Session): Promise<void>;

  /**
   * Login to Steamcommunity.com
   * token: access_token or refresh_token
   */
  login(token: string): Promise<Session>;

  /**
   * Logout and destroy cookies
   */
  logout(): Promise<void>;

  /**
   * Get games with cards left to farm
   */
  getFarmableGames(): Promise<FarmableGame[]>;

  /**
   * Get cards inventory
   */
  getCardsInventory(): Promise<Item[]>;

  /**
   * Change account profile avatar
   */
  changeAvatar(avatarURL: string): Promise<string>;

  /**
   * Clear account's previous aliases
   */
  clearAliases(): Promise<void>;

  /**
   * Change account's privacy settings
   */
  changePrivacy(privacy: ProfilePrivacy): Promise<void>;

  /**
   * Get avatar frame
   */
  getAvatarFrame(): Promise<string>

```
