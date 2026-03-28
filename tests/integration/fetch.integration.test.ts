import { beforeAll, describe, expect, it } from "vitest";
import Fetch from "@/internal/Fetch";
import {
  acquireIntegrationDockerServices,
  HTTPS_PROXY_AUTH_PORT,
  HTTPS_PROXY_PORT,
  PROXY_PASSWORD,
  PROXY_USERNAME,
  SOCKS5_PROXY_AUTH_PORT,
  SOCKS5_PROXY_PORT,
} from "../support/integration-docker";

const STEAMCOMMUNITY_URL = "https://steamcommunity.com/";
const proxyCases: ReadonlyArray<{ name: string; proxyUrl?: string }> = [
  {
    name: "without a proxy",
  },
  {
    name: "through an HTTPS proxy without authentication",
    proxyUrl: `https://127.0.0.1:${HTTPS_PROXY_PORT}`,
  },
  {
    name: "through an HTTPS proxy with authentication",
    proxyUrl: `https://${PROXY_USERNAME}:${PROXY_PASSWORD}@127.0.0.1:${HTTPS_PROXY_AUTH_PORT}`,
  },
  {
    name: "through a SOCKS5 proxy without authentication",
    proxyUrl: `socks5://127.0.0.1:${SOCKS5_PROXY_PORT}`,
  },
  {
    name: "through a SOCKS5 proxy with authentication",
    proxyUrl: `socks5://${PROXY_USERNAME}:${PROXY_PASSWORD}@127.0.0.1:${SOCKS5_PROXY_AUTH_PORT}`,
  },
];

const assertSteamCommunityFetch = async (proxyUrl?: string): Promise<void> => {
  const fetchClient = new Fetch(proxyUrl);
  const proxyAgent = (fetchClient as any).httpsAgent as { destroy?: () => void } | undefined;

  try {
    const response = await fetchClient.fetch(STEAMCOMMUNITY_URL, {
      headers: { connection: "close" },
    });
    const contentType = response.headers.get("content-type") ?? "";
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(contentType.toLowerCase()).toContain("text/html");
    expect(body.length).toBeGreaterThan(1_000);
    expect(body.toLowerCase()).toContain("steamcommunity");
  } finally {
    proxyAgent?.destroy?.();
  }
};

describe("Fetch live integration", () => {
  beforeAll(async () => {
    await acquireIntegrationDockerServices(["proxy"]);
  }, 120_000);

  it.each(proxyCases)("fetches steamcommunity.com $name", async ({ proxyUrl }) => {
    await assertSteamCommunityFetch(proxyUrl);
  }, 60_000);
});
