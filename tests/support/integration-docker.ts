import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

export type IntegrationDockerService = "proxy";

export const SOCKS5_PROXY_PORT = 19380;
export const SOCKS5_PROXY_AUTH_PORT = 19381;
export const HTTPS_PROXY_PORT = 19443;
export const HTTPS_PROXY_AUTH_PORT = 19444;
export const PROXY_USERNAME = "integration_user";
export const PROXY_PASSWORD = "integration_pass";

const DOCKER_STATE_FILE_PREFIX = "/tmp/steam-web-vitest-docker-state";
const PROXY_DOCKER_COMPOSE_FILE = fileURLToPath(
  new URL("../fixtures/proxy/docker/docker-compose.yml", import.meta.url),
);
const DEFAULT_STATE_FILE = "/tmp/steam-web-vitest-docker-state.json";
const PROXY_CERTS_DIR_ENV = "STEAM_WEB_PROXY_CERTS_DIR";
const PROXY_CONTAINER_NAMES = [
  "proxy-socks5",
  "proxy-socks5-auth",
  "proxy-https",
  "proxy-https-auth",
] as const;
const PROXY_TCP_PORTS = [
  SOCKS5_PROXY_PORT,
  SOCKS5_PROXY_AUTH_PORT,
  HTTPS_PROXY_PORT,
  HTTPS_PROXY_AUTH_PORT,
] as const;
const DOCKER_COMPOSE_ARGS = ["compose", "-f", PROXY_DOCKER_COMPOSE_FILE] as const;

type ExecFileSyncError = Error & {
  status?: number | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
};

type IntegrationDockerState = {
  proxyAcquired: boolean;
  proxyImagesPulled: boolean;
};

const INITIAL_STATE: IntegrationDockerState = {
  proxyAcquired: false,
  proxyImagesPulled: false,
};

const toOutputText = (value: string | Buffer | undefined): string => {
  if (typeof value === "string") {
    return value;
  }

  if (value instanceof Buffer) {
    return value.toString("utf8");
  }

  return "";
};

const resolveStateFile = (): string => {
  return process.env.VITEST_DOCKER_STATE_FILE ?? DEFAULT_STATE_FILE;
};

const requireProxyCertsDir = (): string => {
  const certsDir = process.env[PROXY_CERTS_DIR_ENV];

  if (typeof certsDir === "string" && certsDir.length > 0) {
    return certsDir;
  }

  throw new Error(`${PROXY_CERTS_DIR_ENV} is required to run the HTTPS proxy integration tests.`);
};

const runCommand = (command: string, args: readonly string[]): void => {
  try {
    execFileSync(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
      },
    });
  } catch (error) {
    const execError = error as ExecFileSyncError;
    const stdout = toOutputText(execError.stdout).trim();
    const stderr = toOutputText(execError.stderr).trim();
    const details = [stderr, stdout].filter((part) => part.length > 0).join("\n");
    const exitCode = execError.status ?? "unknown";
    const commandLine = [command, ...args].join(" ");

    throw new Error(
      details.length > 0
        ? `Command failed (${exitCode}): ${commandLine}\n${details}`
        : `Command failed (${exitCode}): ${commandLine}`,
    );
  }
};

const sleep = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
};

const waitForTcpPort = async (host: string, port: number, timeoutMs: number): Promise<void> => {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host, port });
      let settled = false;

      const finish = (result: boolean): void => {
        if (settled) {
          return;
        }

        settled = true;
        socket.removeAllListeners();
        socket.destroy();
        resolve(result);
      };

      socket.setTimeout(1_000);
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
    });

    if (connected) {
      return;
    }

    await sleep(300);
  }

  throw new Error(`Timed out waiting for ${host}:${port} to accept TCP connections`);
};

const waitForTcpPorts = async (
  host: string,
  ports: readonly number[],
  timeoutMs: number,
): Promise<void> => {
  await Promise.all(ports.map((port) => waitForTcpPort(host, port, timeoutMs)));
};

const waitForHttpsProxyReady = async (
  host: string,
  port: number,
  timeoutMs: number,
  expectedStatusCodes: readonly number[],
  requestText?: string,
): Promise<void> => {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const responded = await new Promise<boolean>((resolve) => {
      const socket = tls.connect({
        host,
        port,
        rejectUnauthorized: false,
        servername: "localhost",
      });
      let settled = false;
      let rawResponse = "";

      const finish = (result: boolean): void => {
        if (settled) {
          return;
        }

        settled = true;
        socket.destroy();
        resolve(result);
      };

      socket.setTimeout(2_000);
      socket.once("secureConnect", () => {
        socket.write(
          requestText ??
            ["CONNECT 0.0.0.1:1 HTTP/1.1", "Host: 0.0.0.1:1", "Connection: close", "", ""].join(
              "\r\n",
            ),
        );
      });
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
      socket.once("end", () => finish(false));
      socket.on("data", (chunk: Buffer) => {
        rawResponse += chunk.toString("utf8");
        const statusLine = rawResponse.split("\r\n", 1)[0] ?? "";
        const match = statusLine.match(/^HTTP\/1\.[01] (\d{3})\b/u);
        if (!match) {
          return;
        }

        const statusCode = Number.parseInt(match[1] ?? "", 10);
        if (Number.isNaN(statusCode)) {
          return;
        }

        if (expectedStatusCodes.includes(statusCode)) {
          finish(true);
        }
      });
    });

    if (responded) {
      return;
    }

    await sleep(300);
  }

  throw new Error(`Timed out waiting for HTTPS proxy readiness on ${host}:${port}`);
};

const logContainers = (
  action: "started" | "removed",
  containers: readonly string[] = PROXY_CONTAINER_NAMES,
): void => {
  for (const container of containers) {
    console.log(`Container ${container} ${action}`);
  }
};

const readState = (): IntegrationDockerState => {
  try {
    const raw = readFileSync(resolveStateFile(), "utf8");
    const parsed = JSON.parse(raw) as Partial<IntegrationDockerState>;

    return {
      proxyAcquired: parsed.proxyAcquired === true,
      proxyImagesPulled: parsed.proxyImagesPulled === true,
    };
  } catch {
    return { ...INITIAL_STATE };
  }
};

const writeState = (state: IntegrationDockerState): void => {
  writeFileSync(resolveStateFile(), JSON.stringify(state), "utf8");
};

const clearState = (): void => {
  try {
    unlinkSync(resolveStateFile());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
};

const acquireProxyService = async (state: IntegrationDockerState): Promise<void> => {
  if (state.proxyAcquired) {
    return;
  }

  requireProxyCertsDir();

  if (!state.proxyImagesPulled) {
    runCommand("docker", [...DOCKER_COMPOSE_ARGS, "pull"]);
    state.proxyImagesPulled = true;
  }

  runCommand("docker", [
    ...DOCKER_COMPOSE_ARGS,
    "up",
    "-d",
    "--force-recreate",
    "--remove-orphans",
  ]);

  await waitForTcpPorts("127.0.0.1", PROXY_TCP_PORTS, 30_000);
  await waitForHttpsProxyReady("127.0.0.1", HTTPS_PROXY_PORT, 30_000, [400], "HELLO\r\n\r\n");
  await waitForHttpsProxyReady(
    "127.0.0.1",
    HTTPS_PROXY_AUTH_PORT,
    30_000,
    [407],
    ["CONNECT 0.0.0.1:443 HTTP/1.1", "Host: 0.0.0.1:443", "Connection: close", "", ""].join("\r\n"),
  );

  state.proxyAcquired = true;
  logContainers("started");
};

const runTeardownCommand = (command: string, args: string[], errors: Error[]): boolean => {
  try {
    runCommand(command, args);
    return true;
  } catch (error) {
    errors.push(error instanceof Error ? error : new Error(String(error)));
    return false;
  }
};

export async function acquireIntegrationDockerServices(
  requestedServices: readonly IntegrationDockerService[],
): Promise<void> {
  if (!requestedServices.includes("proxy")) {
    return;
  }

  const state = readState();
  await acquireProxyService(state);
  writeState(state);
}

export async function teardownIntegrationDockerServices(
  options: { force?: boolean } = {},
): Promise<void> {
  const state = readState();
  const shouldTeardownProxy = options.force === true || state.proxyAcquired;

  if (!shouldTeardownProxy) {
    return;
  }

  const teardownErrors: Error[] = [];

  const proxyTeardownSucceeded = runTeardownCommand(
    "docker",
    [...DOCKER_COMPOSE_ARGS, "down", "-v", "--remove-orphans"],
    teardownErrors,
  );

  if (proxyTeardownSucceeded) {
    logContainers("removed");
  }

  clearState();

  if (teardownErrors.length > 0) {
    throw new Error(
      `Integration Docker teardown failed (${teardownErrors.length} error(s)): ${teardownErrors.map((error) => error.message).join("; ")}`,
    );
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  process.env.VITEST_DOCKER_STATE_FILE ??= `${DOCKER_STATE_FILE_PREFIX}-${process.pid}-${Date.now()}-${crypto.randomUUID()}.json`;

  return async () => {
    await teardownIntegrationDockerServices();
  };
}
