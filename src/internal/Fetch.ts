import { Buffer } from "node:buffer";
import type {
  ClientRequest,
  ClientRequestArgs,
  Agent as HttpAgent,
  IncomingMessage,
  OutgoingHttpHeaders,
} from "node:http";
import * as http from "node:http";
import * as https from "node:https";
import { isIP, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { Readable } from "node:stream";
import * as tls from "node:tls";
import { SocksProxyAgent } from "socks-proxy-agent";

type ProxyProtocol = "https" | "socks5";
type ProxyConfiguration = {
  protocol: ProxyProtocol;
  url: URL;
  token?: string;
};
type ResponseBody = ConstructorParameters<typeof Response>[0];
type TunnelConnectionOptions = ClientRequestArgs & { signal?: AbortSignal };

const AGENT_OPTIONS = {
  keepAlive: true,
  keepAliveMsecs: 1_000,
  scheduling: "lifo",
} as const;
const NO_BODY_RESPONSE_STATUS = new Set([204, 205, 304]);

export default class Fetch {
  readonly fetch: typeof fetch;
  private readonly proxy?: ProxyConfiguration;
  private readonly httpsAgent?: HttpAgent;

  constructor(proxyUrl?: string | URL) {
    if (proxyUrl) {
      this.proxy = parseProxy(proxyUrl);

      if (this.proxy.protocol === "socks5") {
        const socksAgent = new SocksProxyAgent(this.proxy.url, AGENT_OPTIONS);
        this.httpsAgent = socksAgent;
      } else {
        this.httpsAgent = new HttpsTunnelAgent(this.proxy, AGENT_OPTIONS);
      }
    }

    this.fetch = (input, init) => this.request(input, init);
  }

  private async request(
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> {
    const request = new Request(input, { ...init, redirect: "manual" });

    if (!this.proxy || !isHttpsRequest(request.url)) {
      return fetch(request);
    }

    return sendProxiedHttpsRequest(request, this.httpsAgent);
  }
}

class HttpsTunnelAgent extends https.Agent {
  constructor(
    private readonly proxy: ProxyConfiguration,
    options?: https.AgentOptions,
  ) {
    super(options);
  }

  override createConnection(
    options: ClientRequestArgs,
    callback?: (error: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    void createSecureTunnel(this.proxy, options)
      .then((socket) => callback?.(null, socket))
      .catch((error) => callback?.(error as Error, undefined as unknown as Duplex));

    return undefined;
  }
}

function parseProxy(proxyUrl: string | URL): ProxyConfiguration {
  const url = proxyUrl instanceof URL ? new URL(proxyUrl.toString()) : new URL(proxyUrl);
  const protocol = parseProtocol(url);

  if (protocol === "socks5") {
    return { protocol, url };
  }

  const username = url.username === "" ? undefined : decodeURIComponent(url.username);
  const password = url.password === "" ? undefined : decodeURIComponent(url.password);

  url.username = "";
  url.password = "";

  return {
    protocol,
    url,
    token:
      username === undefined && password === undefined
        ? undefined
        : `Basic ${Buffer.from(`${username ?? ""}:${password ?? ""}`).toString("base64")}`,
  };
}

function parseProtocol(url: URL): ProxyProtocol {
  switch (url.protocol) {
    case "https:":
      return "https";
    case "socks5:":
      return "socks5";
    default:
      throw new TypeError("Unsupported proxy protocol. Expected one of: https, socks5.");
  }
}

async function sendProxiedHttpsRequest(request: Request, agent?: HttpAgent): Promise<Response> {
  const url = new URL(request.url);
  return new Promise((resolve, reject) => {
    let settled = false;
    let cleanupAbort = () => {};
    let cleanupRequestListeners = () => {};
    const clientRequest = https.request({
      agent,
      headers: toOutgoingHeaders(request.headers),
      host: url.hostname,
      method: request.method,
      path: `${url.pathname}${url.search}`,
      port: getPort(url),
      protocol: url.protocol,
      signal: request.signal,
    });
    const rejectOnce = (error: unknown) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanupAbort();
      cleanupRequestListeners();
      reject(error);
    };
    const resolveOnce = (response: Response) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanupAbort();
      cleanupRequestListeners();
      resolve(response);
    };
    cleanupAbort = bindAbort(request.signal, () => {
      clientRequest.destroy();
      rejectOnce(createAbortError());
    });
    const onResponse = (response: IncomingMessage) => {
      void toFetchResponse(response, request.method).then(resolveOnce, rejectOnce);
    };
    const onError = (error: Error) => {
      rejectOnce(error);
    };
    cleanupRequestListeners = () => {
      clientRequest.off("response", onResponse);
      clientRequest.off("error", onError);
    };

    clientRequest.once("response", onResponse);
    clientRequest.once("error", onError);

    void writeRequestBody(request, clientRequest).catch((error) => {
      if (!settled) {
        clientRequest.destroy(error as Error);
        rejectOnce(error);
      }
    });
  });
}

function isHttpsRequest(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

function bindAbort(signal: AbortSignal | undefined, abort: () => void): () => void {
  if (!signal) {
    return () => {};
  }

  if (signal.aborted) {
    abort();
    return () => {};
  }

  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function createAbortError(): Error {
  return typeof DOMException === "function"
    ? new DOMException("The operation was aborted.", "AbortError")
    : new Error("The operation was aborted.");
}

function toOutgoingHeaders(headers: Headers): OutgoingHttpHeaders {
  return Object.fromEntries(headers);
}

async function writeRequestBody(request: Request, clientRequest: ClientRequest): Promise<void> {
  if (request.method === "GET" || request.method === "HEAD" || request.body === null) {
    clientRequest.end();
    return;
  }

  for await (const chunk of Readable.fromWeb(request.body as globalThis.ReadableStream)) {
    if (!clientRequest.write(chunk)) {
      await waitForDrain(clientRequest);
    }
  }

  clientRequest.end();
}

async function toFetchResponse(
  response: IncomingMessage,
  requestMethod: string,
): Promise<Response> {
  const headers = new Headers();
  const status = response.statusCode ?? 500;

  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    const name = response.rawHeaders[index];
    const value = response.rawHeaders[index + 1];

    if (name && value !== undefined) {
      headers.append(name, value);
    }
  }

  return new Response(getResponseBody(response, status, requestMethod), {
    headers,
    status,
    statusText: response.statusMessage ?? "",
  });
}

function getResponseBody(
  response: IncomingMessage,
  status: number,
  requestMethod: string,
): ResponseBody | null {
  if (requestMethod === "HEAD" || NO_BODY_RESPONSE_STATUS.has(status)) {
    return null;
  }

  return Readable.toWeb(response) as ResponseBody;
}

async function createSecureTunnel(
  proxy: ProxyConfiguration,
  options: TunnelConnectionOptions,
): Promise<tls.TLSSocket> {
  const host = options.hostname ?? options.host;
  const tlsOptions = options as TunnelConnectionOptions & tls.ConnectionOptions;

  if (!host) {
    throw new TypeError("HTTPS proxy tunneling requires a request host.");
  }

  const socket = await openTunnel(
    proxy,
    host,
    getPortFromValue(options.port ?? undefined, 443),
    options.signal,
  );

  return tls.connect({
    socket,
    servername:
      typeof tlsOptions.servername === "string" && tlsOptions.servername !== ""
        ? tlsOptions.servername
        : host,
  });
}

function openTunnel(
  proxy: ProxyConfiguration,
  host: string,
  port: number,
  signal?: AbortSignal,
): Promise<Socket | tls.TLSSocket> {
  const connect = proxy.url.protocol === "https:" ? https : http;
  const target = `${host}:${port}`;
  const proxyServername = isIP(proxy.url.hostname) ? "" : proxy.url.hostname;

  return new Promise((resolve, reject) => {
    let settled = false;
    let cleanupAbort = () => {};
    const request = connect.request({
      agent: false,
      headers: {
        Host: target,
        ...(proxy.token ? { "Proxy-Authorization": proxy.token } : {}),
      },
      host: proxy.url.hostname,
      method: "CONNECT",
      path: target,
      port: getPort(proxy.url),
      protocol: proxy.url.protocol,
      servername: proxyServername,
    });
    const settle = (error?: unknown, socket?: Socket | tls.TLSSocket) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanupAbort();

      if (error) {
        reject(error);
        return;
      }

      resolve(socket as Socket | tls.TLSSocket);
    };
    cleanupAbort = bindAbort(signal, () => {
      request.destroy();
      settle(createAbortError());
    });

    request.once("connect", (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        settle(new Error(`Proxy CONNECT failed with status ${response.statusCode ?? 0}.`));
        return;
      }

      if (head.byteLength > 0) {
        socket.unshift(head);
      }

      settle(undefined, socket);
    });

    request.once("error", (error) => {
      settle(error);
    });
    request.end();
  });
}

function getPort(url: URL): number {
  if (url.port !== "") {
    return Number.parseInt(url.port, 10);
  }

  return url.protocol === "https:" ? 443 : 80;
}

function getPortFromValue(value: number | string | undefined, fallback: number): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value !== "") {
    return Number.parseInt(value, 10);
  }

  return fallback;
}

function waitForDrain(clientRequest: ClientRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clientRequest.off("close", onClose);
      clientRequest.off("drain", onDrain);
      clientRequest.off("error", onError);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Socket closed before drain."));
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    clientRequest.once("close", onClose);
    clientRequest.once("drain", onDrain);
    clientRequest.once("error", onError);
  });
}
