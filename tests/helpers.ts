import { once } from "node:events";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

type HttpHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;

function getListeningPort(server: Server): number {
  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("Failed to bind test servers.");
  }

  return (address as AddressInfo).port;
}

async function listen(server: Server): Promise<void> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
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

export function createHttpForwardProxyServer(): Server {
  return createServer((request, response) => {
    const targetUrl = new URL(request.url ?? "http://invalid");
    const forwardedRequest = httpRequest(
      {
        headers: request.headers,
        host: targetUrl.hostname,
        method: request.method,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        port: targetUrl.port,
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 500, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );

    request.pipe(forwardedRequest);
    forwardedRequest.once("error", (error: Error) => {
      response.writeHead(502, { "content-type": "text/plain" });
      response.end(error.message);
    });
  });
}

export async function withHttpProxyServers<T>(
  upstreamHandler: HttpHandler,
  execute: (ports: { proxyPort: number; upstreamPort: number }) => Promise<T>,
): Promise<T> {
  const upstreamServer = createServer(upstreamHandler);
  const proxyServer = createHttpForwardProxyServer();

  await Promise.all([listen(upstreamServer), listen(proxyServer)]);

  try {
    return await execute({
      proxyPort: getListeningPort(proxyServer),
      upstreamPort: getListeningPort(upstreamServer),
    });
  } finally {
    await Promise.all([shutdown(upstreamServer), shutdown(proxyServer)]);
  }
}

export async function withServers<T>(
  servers: Server[],
  execute: (ports: number[]) => Promise<T>,
): Promise<T> {
  await Promise.all(servers.map((server) => listen(server)));

  try {
    return await execute(servers.map((server) => getListeningPort(server)));
  } finally {
    await Promise.all(servers.map((server) => shutdown(server)));
  }
}
