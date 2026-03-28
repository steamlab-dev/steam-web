import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const vitestEntrypoint = resolve(projectRoot, "node_modules/vitest/vitest.mjs");
const proxyCertsDirEnv = "STEAM_WEB_PROXY_CERTS_DIR";

type ExecFileSyncFailure = Error & {
  status?: number | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
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

const runOpenSsl = (args: string[]): void => {
  try {
    execFileSync("openssl", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const execError = error as ExecFileSyncFailure;
    const stdout = toOutputText(execError.stdout).trim();
    const stderr = toOutputText(execError.stderr).trim();
    const details = [stderr, stdout].filter((part) => part.length > 0).join("\n");
    const exitCode = execError.status ?? "unknown";
    const commandLine = ["openssl", ...args].join(" ");

    throw new Error(
      details.length > 0
        ? `OpenSSL command failed (${exitCode}): ${commandLine}\n${details}`
        : `OpenSSL command failed (${exitCode}): ${commandLine}`,
    );
  }
};

const generateProxyCertificates = (): { certsDir: string; caCertPath: string } => {
  const tempRoot = mkdtempSync(join(tmpdir(), "steam-web-proxy-certs-"));
  const certsDir = join(tempRoot, "certs");
  const caKeyPath = join(tempRoot, "ca-key.pem");
  const caCertPath = join(certsDir, "ca-cert.pem");
  const serverKeyPath = join(certsDir, "server-key.pem");
  const serverCertPath = join(certsDir, "server-cert.pem");
  const serverCsrPath = join(tempRoot, "server.csr");
  const serverConfigPath = join(tempRoot, "server-cert.cnf");

  mkdirSync(certsDir, { recursive: true });
  writeFileSync(
    serverConfigPath,
    [
      "[req]",
      "prompt = no",
      "default_bits = 2048",
      "default_md = sha256",
      "distinguished_name = dn",
      "req_extensions = req_ext",
      "",
      "[dn]",
      "CN = 127.0.0.1",
      "",
      "[req_ext]",
      "subjectAltName = @alt_names",
      "extendedKeyUsage = serverAuth",
      "keyUsage = digitalSignature,keyEncipherment",
      "",
      "[alt_names]",
      "IP.1 = 127.0.0.1",
      "DNS.1 = localhost",
      "",
    ].join("\n"),
    "utf8",
  );

  runOpenSsl(["genrsa", "-out", caKeyPath, "2048"]);
  runOpenSsl([
    "req",
    "-x509",
    "-new",
    "-key",
    caKeyPath,
    "-sha256",
    "-days",
    "7",
    "-out",
    caCertPath,
    "-subj",
    "/CN=steam-web-test-proxy-ca",
  ]);
  runOpenSsl(["genrsa", "-out", serverKeyPath, "2048"]);
  runOpenSsl([
    "req",
    "-new",
    "-key",
    serverKeyPath,
    "-out",
    serverCsrPath,
    "-config",
    serverConfigPath,
  ]);
  runOpenSsl([
    "x509",
    "-req",
    "-in",
    serverCsrPath,
    "-CA",
    caCertPath,
    "-CAkey",
    caKeyPath,
    "-CAcreateserial",
    "-out",
    serverCertPath,
    "-days",
    "7",
    "-sha256",
    "-extensions",
    "req_ext",
    "-extfile",
    serverConfigPath,
  ]);

  return { certsDir, caCertPath };
};

const run = (): number => {
  const { certsDir, caCertPath } = generateProxyCertificates();

  try {
    // NODE_EXTRA_CA_CERTS is read when the Node process starts, so Vitest must run in a child.
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        vitestEntrypoint,
        "--run",
        "--config",
        "vitest.integration.config.ts",
        "tests/integration/fetch.integration.test.ts",
      ],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          NODE_EXTRA_CA_CERTS: caCertPath,
          [proxyCertsDirEnv]: certsDir,
        },
        stdio: "inherit",
      },
    );

    if (result.error) {
      throw result.error;
    }
    if (result.signal) {
      throw new Error(`Vitest terminated with signal ${result.signal}.`);
    }

    return result.status ?? 1;
  } finally {
    rmSync(dirname(certsDir), { force: true, recursive: true });
  }
};

process.exitCode = run();
