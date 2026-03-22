import { Buffer } from "node:buffer";
import type { Agent as HttpAgent, IncomingMessage, OutgoingHttpHeaders } from "node:http";
import * as http from "node:http";
import * as https from "node:https";
import type { Socket } from "node:net";
import * as tls from "node:tls";
import { HttpProxyAgent } from "http-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

const DEFAULT_HTTP_PORT = 80;
const DEFAULT_HTTPS_PORT = 443;
const MAX_REDIRECTS = 20;

export interface ParsedProxyConfiguration {
  protocol: "http" | "https" | "socks5";
  uri: string;
  password?: string;
  token?: string;
  username?: string;
}

export function createFetch(proxyUrl?: string | URL): typeof fetch {
  if (!proxyUrl) {
    return fetch;
  }

  const configuration = parseProxyConfiguration(proxyUrl);
  const proxyAgent = createProxyAgent(proxyUrl);

  return async (input, init) => {
    let request = new Request(input, init);

    if (!request.url.startsWith("http://") && !request.url.startsWith("https://")) {
      return fetch(request);
    }

    for (let redirectCount = 0; redirectCount < MAX_REDIRECTS; redirectCount++) {
      const requestForRedirects = request.clone();
      const response = await proxyFetch(request, configuration, proxyAgent);
      const nextRequest = await buildRedirectRequest(requestForRedirects, response);

      if (!nextRequest) {
        return response;
      }

      request = nextRequest;
    }

    throw new TypeError("Too many redirects.");
  };
}

export function createProxyAgent(proxyUrl: string | URL): HttpAgent {
  const parsedProxyUrl = proxyUrl instanceof URL ? new URL(proxyUrl.toString()) : new URL(proxyUrl);
  parseProtocol(parsedProxyUrl);
  return parsedProxyUrl.protocol === "socks5:"
    ? new SocksProxyAgent(parsedProxyUrl)
    : new HttpProxyAgent(parsedProxyUrl);
}

export function parseProxyConfiguration(proxyUrl: string | URL): ParsedProxyConfiguration {
  const parsedUrl = proxyUrl instanceof URL ? new URL(proxyUrl.toString()) : new URL(proxyUrl);
  const protocol = parseProtocol(parsedUrl);
  const username = parsedUrl.username === "" ? undefined : decodeURIComponent(parsedUrl.username);
  const password = parsedUrl.password === "" ? undefined : decodeURIComponent(parsedUrl.password);

  parsedUrl.username = "";
  parsedUrl.password = "";
  const uri = parsedUrl.toString();

  if (protocol === "http" || protocol === "https") {
    return {
      protocol,
      uri,
      token: buildProxyAuthorizationToken(username, password),
    };
  }

  return {
    password,
    protocol,
    uri,
    username,
  };
}

function buildProxyAuthorizationToken(username?: string, password?: string): string | undefined {
  return username === undefined && password === undefined
    ? undefined
    : `Basic ${Buffer.from(`${username ?? ""}:${password ?? ""}`).toString("base64")}`;
}

function parseProtocol(proxyUrl: URL): ParsedProxyConfiguration["protocol"] {
  switch (proxyUrl.protocol) {
    case "http:":
      return "http";
    case "https:":
      return "https";
    case "socks5:":
      return "socks5";
    default:
      throw new TypeError("Unsupported proxy protocol. Expected one of: http, https, socks5.");
  }
}

async function buildRedirectRequest(request: Request, response: Response): Promise<Request | null> {
  if (request.redirect !== "follow" || !isRedirectResponse(response.status)) {
    return null;
  }

  const location = response.headers.get("location");
  if (!location) {
    return null;
  }

  const url = new URL(location, request.url);
  const headers = new Headers(request.headers);
  let body: Buffer | undefined;
  let method = request.method;

  if (response.status === 303 || ([301, 302].includes(response.status) && method === "POST")) {
    method = "GET";
    headers.delete("content-length");
    headers.delete("content-type");
  } else if (request.body !== null) {
    body = Buffer.from(await request.arrayBuffer());
  }

  return new Request(url, {
    body,
    headers,
    method,
    redirect: request.redirect,
    signal: request.signal,
  });
}

function createAbortError(): Error {
  return typeof DOMException === "function"
    ? new DOMException("The operation was aborted.", "AbortError")
    : new Error("The operation was aborted.");
}

function createResponseHeaders(response: IncomingMessage): Headers {
  const headers = new Headers();

  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    const name = response.rawHeaders[index];
    const value = response.rawHeaders[index + 1];

    if (!name || value === undefined) {
      continue;
    }

    headers.append(name, value);
  }

  return headers;
}

async function getRequestBody(request: Request): Promise<Buffer | null> {
  if (request.method === "GET" || request.method === "HEAD" || request.body === null) {
    return null;
  }

  return Buffer.from(await request.arrayBuffer());
}

function getRequestHeaders(headers: Headers, body: Buffer | null): OutgoingHttpHeaders {
  const outgoingHeaders: OutgoingHttpHeaders = Object.fromEntries(headers);

  if (body && outgoingHeaders["content-length"] === undefined) {
    outgoingHeaders["content-length"] = String(body.byteLength);
  }

  return outgoingHeaders;
}

function isRedirectResponse(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

async function proxyFetch(
  request: Request,
  configuration: ParsedProxyConfiguration,
  proxyAgent: HttpAgent,
): Promise<Response> {
  const requestUrl = new URL(request.url);

  if (configuration.protocol === "socks5" || requestUrl.protocol === "http:") {
    return sendRequest(request, { agent: proxyAgent });
  }

  return sendHttpsRequestViaProxy(request, configuration);
}

async function sendHttpsRequestViaProxy(
  request: Request,
  configuration: ParsedProxyConfiguration,
): Promise<Response> {
  const requestUrl = new URL(request.url);
  const tunneledSocket = await connectHttpsTunnel(requestUrl, configuration, request.signal);

  return sendRequest(request, {
    agent: false,
    createConnection: () =>
      tls.connect({
        servername: requestUrl.hostname,
        socket: tunneledSocket,
      }),
  });
}

function connectHttpsTunnel(
  requestUrl: URL,
  configuration: ParsedProxyConfiguration,
  signal: AbortSignal,
): Promise<tls.TLSSocket | Socket> {
  const proxyUrl = new URL(configuration.uri);
  const connectModule = proxyUrl.protocol === "https:" ? https : http;
  const port = getRequestPort(requestUrl);

  return new Promise((resolve, reject) => {
    const connectRequest = connectModule.request({
      agent: false,
      headers: {
        Host: `${requestUrl.hostname}:${port}`,
        ...(configuration.token ? { "Proxy-Authorization": configuration.token } : {}),
      },
      host: proxyUrl.hostname,
      method: "CONNECT",
      path: `${requestUrl.hostname}:${port}`,
      port: getRequestPort(proxyUrl),
      protocol: proxyUrl.protocol,
    });

    const abortHandler: () => void = () => {
      connectRequest.destroy(createAbortError());
    };

    signal.addEventListener("abort", abortHandler, { once: true });

    connectRequest.once("connect", (response, socket, head) => {
      signal.removeEventListener("abort", abortHandler);

      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT failed with status ${response.statusCode ?? 0}.`));
        return;
      }

      if (head.byteLength > 0) {
        socket.unshift(head);
      }

      resolve(socket);
    });

    connectRequest.once("error", (error) => {
      signal.removeEventListener("abort", abortHandler);
      reject(error);
    });

    connectRequest.end();
  });
}

async function sendRequest(
  request: Request,
  options: {
    agent?: HttpAgent | false;
    createConnection?: () => Socket | tls.TLSSocket;
  },
): Promise<Response> {
  const requestUrl = new URL(request.url);
  const client = requestUrl.protocol === "https:" ? https : http;
  const body = await getRequestBody(request);
  const headers = getRequestHeaders(request.headers, body);

  return new Promise((resolve, reject) => {
    const clientRequest = client.request({
      agent: options.agent,
      createConnection: options.createConnection,
      headers,
      host: requestUrl.hostname,
      method: request.method,
      path: `${requestUrl.pathname}${requestUrl.search}`,
      port: getRequestPort(requestUrl),
      protocol: requestUrl.protocol,
    });

    const abortHandler = () => {
      clientRequest.destroy(createAbortError());
    };

    request.signal.addEventListener("abort", abortHandler, { once: true });

    clientRequest.once("response", async (response) => {
      request.signal.removeEventListener("abort", abortHandler);

      try {
        resolve(await createFetchResponse(response));
      } catch (error) {
        reject(error);
      }
    });

    clientRequest.once("error", (error) => {
      request.signal.removeEventListener("abort", abortHandler);
      reject(error);
    });

    clientRequest.end(body ?? undefined);
  });
}

async function createFetchResponse(response: IncomingMessage): Promise<Response> {
  const chunks: Buffer[] = [];

  for await (const chunk of response) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return new Response(chunks.length === 0 ? null : Buffer.concat(chunks), {
    headers: createResponseHeaders(response),
    status: response.statusCode ?? 500,
    statusText: response.statusMessage ?? "",
  });
}

function getRequestPort(requestUrl: URL): number {
  return requestUrl.port !== ""
    ? Number.parseInt(requestUrl.port, 10)
    : requestUrl.protocol === "https:"
      ? DEFAULT_HTTPS_PORT
      : DEFAULT_HTTP_PORT;
}
