import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import type { ClientRequest, ClientRequestArgs, IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { Readable } from "node:stream";
import type { TLSSocket } from "node:tls";
import { expect, vi } from "vitest";

export function createMockClientRequest(): ClientRequest {
  const request = new EventEmitter() as EventEmitter & Partial<ClientRequest>;

  request.destroy = vi.fn();
  request.end = vi.fn(function (this: ClientRequest) {
    return this;
  }) as ClientRequest["end"];
  request.write = vi.fn(() => true) as ClientRequest["write"];

  return request as ClientRequest;
}

export function createMockSocket(): Socket {
  const socket = new EventEmitter() as EventEmitter & Partial<Socket>;

  socket.destroy = vi.fn();
  socket.unshift = vi.fn();

  return socket as Socket;
}

export function createMockTlsSocket(): TLSSocket {
  return new EventEmitter() as TLSSocket;
}

export function createIncomingResponse(
  body: string | Buffer,
  init: Partial<Pick<IncomingMessage, "rawHeaders" | "statusCode" | "statusMessage">> = {},
): IncomingMessage {
  const chunk = typeof body === "string" ? Buffer.from(body) : body;
  const response = Readable.from([chunk]) as Readable & Partial<IncomingMessage>;

  response.rawHeaders = init.rawHeaders ?? ["content-type", "text/plain"];
  response.statusCode = init.statusCode ?? 200;
  response.statusMessage = init.statusMessage ?? "OK";

  return response as IncomingMessage;
}

function normalizeChunk(chunk: unknown): string {
  if (typeof chunk === "string") {
    return chunk;
  }
  if (Buffer.isBuffer(chunk)) {
    return chunk.toString();
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk).toString();
  }

  return String(chunk);
}

export function recordWrittenBody(clientRequest: ClientRequest): () => string {
  let seenBody = "";

  clientRequest.write = vi.fn((chunk) => {
    seenBody += normalizeChunk(chunk);
    return true;
  }) as ClientRequest["write"];

  return () => seenBody;
}

export function emitResponseOnEnd(clientRequest: ClientRequest, response: IncomingMessage): void {
  clientRequest.end = vi.fn(function (this: ClientRequest) {
    process.nextTick(() => clientRequest.emit("response", response));
    return this;
  }) as ClientRequest["end"];
}

export function emitErrorOnEnd(clientRequest: ClientRequest, error: Error): void {
  clientRequest.end = vi.fn(function (this: ClientRequest) {
    process.nextTick(() => clientRequest.emit("error", error));
    return this;
  }) as ClientRequest["end"];
}

export function emitConnectOnEnd(
  clientRequest: ClientRequest,
  response: Pick<IncomingMessage, "statusCode">,
  socket: Socket,
  head = Buffer.alloc(0),
): void {
  clientRequest.end = vi.fn(function (this: ClientRequest) {
    process.nextTick(() => {
      clientRequest.emit("connect", response as IncomingMessage, socket, head);
    });
    return this;
  }) as ClientRequest["end"];
}

export async function expectAbortError(request: Promise<Response>): Promise<void> {
  await expect(request).rejects.toMatchObject({
    message: "The operation was aborted.",
    name: "AbortError",
  });
}

export function expectNoDrainListeners(clientRequest: ClientRequest): void {
  expect(clientRequest.listenerCount("close")).toBe(0);
  expect(clientRequest.listenerCount("drain")).toBe(0);
  expect(clientRequest.listenerCount("error")).toBe(0);
}

export function waitForCreateConnection(
  agent: {
    createConnection: (
      options: ClientRequestArgs & { servername?: string },
      callback: (error: Error | null, stream?: Duplex) => void,
    ) => undefined;
  },
  options: ClientRequestArgs & { servername?: string },
): Promise<{ error: Error | null; stream: Duplex | undefined }> {
  return new Promise((resolve) => {
    expect(
      agent.createConnection(options, (error, stream) => resolve({ error, stream })),
    ).toBeUndefined();
  });
}
