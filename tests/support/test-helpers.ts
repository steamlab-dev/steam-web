import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { vi } from "vitest";
import type { SteamWeb, SteamWebSession } from "@/index";

const supportDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(supportDir, "../fixtures/html");

const readHtmlFixture = (name: string): string => {
  return readFileSync(resolve(fixturesDir, name), "utf8");
};

export const badgesHtml = readHtmlFixture("badges-page.html");
export const profileHtml = readHtmlFixture("profile-page.html");

export function createJwt(
  overrides: Partial<{ aud: string[]; exp: number; sub: string }> = {},
): string {
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

export function textResponse(text: string, init?: ResponseInit): Response {
  return new Response(text, { status: 200, ...init });
}

export function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200,
    ...init,
  });
}

export function responseWithSetCookies(body: string, ...cookies: string[]): Response {
  const headers = new Headers();

  for (const cookie of cookies) {
    headers.append("set-cookie", cookie);
  }

  return new Response(body, { headers, status: 200 });
}

export function blobResponse(blob: Blob, init?: ResponseInit): Response {
  return new Response(blob, {
    headers: { "content-type": blob.type },
    status: 200,
    ...init,
  });
}

export function queueFetchResponses(
  fetchMock: ReturnType<typeof vi.fn>,
  ...responses: Response[]
): void {
  for (const response of responses) {
    fetchMock.mockResolvedValueOnce(response);
  }
}

export function createSession(overrides: Partial<SteamWebSession> = {}): SteamWebSession {
  const { steamLoginSecure, ...sessionOverrides } = overrides;

  return {
    sessionid: "session-1",
    steamid: "76561197960410044",
    steamLoginSecure: {
      expires: 0,
      steamLoginSecure: "secure-1",
      ...steamLoginSecure,
    },
    ...sessionOverrides,
  };
}

export function seedSession(client: SteamWeb, overrides: Partial<SteamWebSession> = {}): void {
  client.setSession(createSession(overrides));
}

function getListeningPort(server: Server): number {
  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("Failed to bind test servers.");
  }

  return (address as AddressInfo).port;
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return getListeningPort(server);
}

async function shutdown(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

export async function withServers<T>(
  servers: readonly Server[],
  execute: (ports: number[]) => Promise<T>,
): Promise<T> {
  const ports = await Promise.all(servers.map((server) => listen(server)));

  try {
    return await execute(ports);
  } finally {
    await Promise.all(servers.map((server) => shutdown(server)));
  }
}
