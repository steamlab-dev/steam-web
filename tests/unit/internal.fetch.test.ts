import { Buffer } from "node:buffer";
import type { ClientRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createIncomingResponse,
  createMockClientRequest,
  createMockSocket,
  createMockTlsSocket,
  emitConnectOnEnd,
  emitErrorOnEnd,
  emitResponseOnEnd,
  expectAbortError,
  expectNoDrainListeners,
  recordWrittenBody,
  waitForCreateConnection,
} from "./internal.fetch.test.helpers";

const mocks = vi.hoisted(() => ({
  httpRequest: vi.fn(),
  httpsRequest: vi.fn(),
  tlsConnect: vi.fn(),
}));

vi.mock("node:http", async () => {
  const actual = await vi.importActual<typeof import("node:http")>("node:http");

  return { ...actual, request: mocks.httpRequest };
});

vi.mock("node:https", async () => {
  const actual = await vi.importActual<typeof import("node:https")>("node:https");

  return { ...actual, request: mocks.httpsRequest };
});

vi.mock("node:tls", async () => {
  const actual = await vi.importActual<typeof import("node:tls")>("node:tls");

  return { ...actual, connect: mocks.tlsConnect };
});

import Fetch from "@/internal/Fetch";

const createProxiedFetch = (proxyUrl = "https://proxy.example:8443"): typeof fetch => {
  return new Fetch(proxyUrl).fetch;
};

describe("Fetch", () => {
  afterEach(() => {
    mocks.httpRequest.mockReset();
    mocks.httpsRequest.mockReset();
    mocks.tlsConnect.mockReset();
    vi.restoreAllMocks();
  });

  describe("proxy request handling", () => {
    it("forwards proxied HTTPS GET requests without adding extra encoding headers", async () => {
      const clientRequest = createMockClientRequest();

      emitResponseOnEnd(
        clientRequest,
        createIncomingResponse("proxied-body", { rawHeaders: ["content-type", "text/plain"] }),
      );
      mocks.httpsRequest.mockReturnValue(clientRequest);

      const response = await createProxiedFetch()("https://example.com/games?sort=desc");

      expect(mocks.httpsRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.not.objectContaining({ "accept-encoding": expect.anything() }),
          host: "example.com",
          method: "GET",
          path: "/games?sort=desc",
          port: 443,
          protocol: "https:",
        }),
      );
      await expect(response.text()).resolves.toBe("proxied-body");
    });

    it("streams HTTPS POST bodies through the proxy and preserves explicit headers", async () => {
      const clientRequest = createMockClientRequest();
      const getWrittenBody = recordWrittenBody(clientRequest);

      emitResponseOnEnd(clientRequest, createIncomingResponse("ok"));
      mocks.httpsRequest.mockReturnValue(clientRequest);

      const response = await createProxiedFetch()("https://example.com/submit", {
        body: "hello through proxy",
        headers: { "content-type": "text/plain", "x-test-header": "present" },
        method: "POST",
      });

      expect(mocks.httpsRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            "content-type": "text/plain",
            "x-test-header": "present",
          }),
          host: "example.com",
          method: "POST",
          path: "/submit",
        }),
      );
      expect(getWrittenBody()).toBe("hello through proxy");
      await expect(response.text()).resolves.toBe("ok");
    });

    it("returns empty bodies for HEAD requests and no-body response statuses", async () => {
      const headRequest = createMockClientRequest();
      const notModifiedRequest = createMockClientRequest();

      emitResponseOnEnd(headRequest, createIncomingResponse("ignored-head-body"));
      emitResponseOnEnd(
        notModifiedRequest,
        createIncomingResponse("ignored-cache-body", {
          statusCode: 304,
          statusMessage: "Not Modified",
        }),
      );
      mocks.httpsRequest.mockReturnValueOnce(headRequest).mockReturnValueOnce(notModifiedRequest);

      const proxiedFetch = createProxiedFetch();
      const headResponse = await proxiedFetch("https://example.com/resource", { method: "HEAD" });
      const notModifiedResponse = await proxiedFetch("https://example.com/resource");

      expect(headRequest.write).not.toHaveBeenCalled();
      expect(notModifiedRequest.write).not.toHaveBeenCalled();
      await expect(headResponse.text()).resolves.toBe("");
      await expect(notModifiedResponse.text()).resolves.toBe("");
    });

    it("falls back to native fetch without a proxy, for plain HTTP URLs, and for non-http URLs", async () => {
      const nativeFetch = vi.spyOn(globalThis, "fetch");
      const firstResponse = new Response("native-body");
      const secondResponse = new Response("http-body");
      const thirdResponse = new Response("data:text/plain,hello");

      nativeFetch
        .mockResolvedValueOnce(firstResponse)
        .mockResolvedValueOnce(secondResponse)
        .mockResolvedValueOnce(thirdResponse);

      await expect(new Fetch().fetch("https://example.com/native")).resolves.toBe(firstResponse);
      await expect(createProxiedFetch()("http://example.com/plain")).resolves.toBe(secondResponse);
      await expect(createProxiedFetch()("data:text/plain,hello")).resolves.toBe(thirdResponse);
      expect(nativeFetch).toHaveBeenCalledTimes(3);
      expect(mocks.httpRequest).not.toHaveBeenCalled();
      expect(mocks.httpsRequest).not.toHaveBeenCalled();
    });
  });

  describe("proxy configuration", () => {
    it("creates the expected agents and rejects unsupported proxy protocols", () => {
      const socksFetch = new Fetch("socks5://proxy.example:1080") as any;

      expect(socksFetch.httpsAgent).toBeDefined();
      expect(() => new Fetch("ftp://proxy.example")).toThrow(
        "Unsupported proxy protocol. Expected one of: https, socks5.",
      );
      expect(() => new Fetch("http://proxy.example")).toThrow(
        "Unsupported proxy protocol. Expected one of: https, socks5.",
      );
    });

    it("normalizes HTTPS proxy credentials into authorization metadata", () => {
      const proxiedFetch = new Fetch("https://user:pass@proxy.example:8443") as any;

      expect(proxiedFetch.proxy.token).toBe(`Basic ${Buffer.from("user:pass").toString("base64")}`);
      expect(proxiedFetch.proxy.url.username).toBe("");
      expect(proxiedFetch.proxy.url.password).toBe("");
    });
  });

  describe("aborts and body streaming cleanup", () => {
    it("rejects proxied requests that are already aborted or abort in flight", async () => {
      const alreadyAborted = new AbortController();
      const inFlight = new AbortController();
      const firstRequest = createMockClientRequest();
      const secondRequest = createMockClientRequest();

      alreadyAborted.abort();
      mocks.httpsRequest.mockReturnValueOnce(firstRequest).mockReturnValueOnce(secondRequest);

      await expectAbortError(
        createProxiedFetch()("https://example.com/abort", { signal: alreadyAborted.signal }),
      );

      const request = createProxiedFetch()("https://example.com/abort", {
        signal: inFlight.signal,
      });
      setTimeout(() => inFlight.abort(), 0);
      await expectAbortError(request);

      expect(firstRequest.destroy).toHaveBeenCalledTimes(1);
      expect(secondRequest.destroy).toHaveBeenCalledTimes(1);
    });

    it("does not retain request listeners after repeated aborts or completion", async () => {
      for (let index = 0; index < 5; index += 1) {
        const controller = new AbortController();
        const clientRequest = createMockClientRequest();

        mocks.httpsRequest.mockReturnValueOnce(clientRequest);
        const request = createProxiedFetch()("https://example.com/abort", {
          signal: controller.signal,
        });
        controller.abort();

        await expectAbortError(request);
        expect(clientRequest.destroy).toHaveBeenCalledTimes(1);
        expect(clientRequest.listenerCount("response")).toBe(0);
        expect(clientRequest.listenerCount("error")).toBe(0);
      }

      const controller = new AbortController();
      const clientRequest = createMockClientRequest();

      emitResponseOnEnd(clientRequest, createIncomingResponse("ok"));
      mocks.httpsRequest.mockReturnValue(clientRequest);

      const response = await createProxiedFetch()("https://example.com/done", {
        signal: controller.signal,
      });

      await expect(response.text()).resolves.toBe("ok");
      controller.abort();
      expect(clientRequest.destroy).not.toHaveBeenCalled();
    });

    it("cleans up temporary drain listeners for success and failure paths", async () => {
      const drainedRequest = createMockClientRequest();
      const closedRequest = createMockClientRequest();
      const erroredRequest = createMockClientRequest();

      drainedRequest.write = vi.fn(() => {
        process.nextTick(() => drainedRequest.emit("drain"));
        return false;
      }) as ClientRequest["write"];
      closedRequest.write = vi.fn(() => {
        process.nextTick(() => closedRequest.emit("close"));
        return false;
      }) as ClientRequest["write"];
      erroredRequest.write = vi.fn(() => {
        process.nextTick(() => erroredRequest.emit("error", new Error("drain exploded")));
        return false;
      }) as ClientRequest["write"];

      emitResponseOnEnd(drainedRequest, createIncomingResponse("drained"));
      mocks.httpsRequest
        .mockReturnValueOnce(drainedRequest)
        .mockReturnValueOnce(closedRequest)
        .mockReturnValueOnce(erroredRequest);

      const drainedResponse = await createProxiedFetch()("https://example.com/upload", {
        body: "payload",
        method: "POST",
      });
      await expect(drainedResponse.text()).resolves.toBe("drained");
      expect(drainedRequest.end).toHaveBeenCalledTimes(1);
      expectNoDrainListeners(drainedRequest);

      await expect(
        createProxiedFetch()("https://example.com/upload", { body: "payload", method: "POST" }),
      ).rejects.toThrow("Socket closed before drain.");
      expectNoDrainListeners(closedRequest);

      await expect(
        createProxiedFetch()("https://example.com/upload", { body: "payload", method: "POST" }),
      ).rejects.toThrow("drain exploded");
      expectNoDrainListeners(erroredRequest);
    });

    it("propagates low-level client request errors", async () => {
      const clientRequest = createMockClientRequest();

      emitErrorOnEnd(clientRequest, new Error("request exploded"));
      mocks.httpsRequest.mockReturnValue(clientRequest);

      await expect(createProxiedFetch()("https://example.com/fail")).rejects.toThrow(
        "request exploded",
      );
    });
  });

  describe("HTTPS proxy tunneling", () => {
    it("creates TLS tunnels through HTTPS proxies and preserves explicit servername values", async () => {
      const firstConnectRequest = createMockClientRequest();
      const secondConnectRequest = createMockClientRequest();
      const firstTunnelSocket = createMockSocket();
      const secondTunnelSocket = createMockSocket();
      const secureSocket = createMockTlsSocket();
      const token = `Basic ${Buffer.from("user:pass").toString("base64")}`;

      emitConnectOnEnd(
        firstConnectRequest,
        { statusCode: 200 },
        firstTunnelSocket,
        Buffer.from("peeked"),
      );
      emitConnectOnEnd(secondConnectRequest, { statusCode: 200 }, secondTunnelSocket);
      mocks.httpsRequest
        .mockReturnValueOnce(firstConnectRequest)
        .mockReturnValueOnce(secondConnectRequest);
      mocks.tlsConnect.mockReturnValue(secureSocket);

      const agent = (new Fetch("https://user:pass@proxy.example:8443") as any).httpsAgent;
      const firstConnection = await waitForCreateConnection(agent, {
        host: "target.example",
        port: "444",
        servername: "",
      });
      const secondConnection = await waitForCreateConnection(agent, {
        host: "target.example",
        port: 444,
        servername: "alt.example",
      });

      expect(firstConnection.error).toBeNull();
      expect(firstConnection.stream).toBe(secureSocket);
      expect(secondConnection.error).toBeNull();
      expect(secondConnection.stream).toBe(secureSocket);
      expect(mocks.httpsRequest).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          agent: false,
          headers: {
            Host: "target.example:444",
            "Proxy-Authorization": token,
          },
          host: "proxy.example",
          method: "CONNECT",
          path: "target.example:444",
          port: 8443,
          protocol: "https:",
          servername: "proxy.example",
        }),
      );
      expect(firstTunnelSocket.unshift).toHaveBeenCalledWith(Buffer.from("peeked"));
      expect(mocks.tlsConnect).toHaveBeenNthCalledWith(1, {
        servername: "target.example",
        socket: firstTunnelSocket,
      });
      expect(mocks.tlsConnect).toHaveBeenNthCalledWith(2, {
        servername: "alt.example",
        socket: secondTunnelSocket,
      });
    });

    it("surfaces CONNECT failures, request errors, aborts, and missing hosts", async () => {
      const failingConnectRequest = createMockClientRequest();
      const erroringConnectRequest = createMockClientRequest();
      const abortingConnectRequest = createMockClientRequest();
      const tunnelSocket = createMockSocket();
      const controller = new AbortController();

      emitConnectOnEnd(failingConnectRequest, { statusCode: 407 }, tunnelSocket);
      emitErrorOnEnd(erroringConnectRequest, new Error("connect exploded"));
      mocks.httpsRequest
        .mockReturnValueOnce(failingConnectRequest)
        .mockReturnValueOnce(erroringConnectRequest)
        .mockReturnValueOnce(abortingConnectRequest);

      const httpsAgent = (new Fetch("https://proxy.example") as any).httpsAgent;

      const failed = await waitForCreateConnection(httpsAgent, { hostname: "secure.example" });
      const errored = await waitForCreateConnection(httpsAgent, { host: "target.example" });
      const abortedPromise = waitForCreateConnection(httpsAgent, {
        host: "target.example",
        signal: controller.signal,
      });
      controller.abort();
      const aborted = await abortedPromise;
      const missingHost = await waitForCreateConnection(httpsAgent, { port: 443 });

      expect(failed.stream).toBeUndefined();
      expect(failed.error?.message).toBe("Proxy CONNECT failed with status 407.");
      expect(tunnelSocket.destroy).toHaveBeenCalledTimes(1);
      expect(errored.stream).toBeUndefined();
      expect(errored.error?.message).toBe("connect exploded");
      expect(aborted.stream).toBeUndefined();
      expect(aborted.error).toMatchObject({
        message: "The operation was aborted.",
        name: "AbortError",
      });
      expect(abortingConnectRequest.destroy).toHaveBeenCalledTimes(1);
      expect(missingHost.stream).toBeUndefined();
      expect(missingHost.error).toEqual(
        new TypeError("HTTPS proxy tunneling requires a request host."),
      );
    });
  });
});
