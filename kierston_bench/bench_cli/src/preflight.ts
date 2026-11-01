/**
 * The checks worth making before a run is dispatched, each phrased as what a
 * person would have to fix.
 *
 * A run that fails because its dependencies are not ready wastes a container
 * per task and a lot of wall clock; the whole point is to catch that quickly.
 */

import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { BENCH_ROOT, DEFAULTS, PATHS } from "./paths.ts";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** A failed check that only matters for some runs. */
  advisory?: boolean;
}

async function directoryExists(path: string): Promise<boolean> {
  return stat(path).then((entry) => entry.isDirectory(), () => false);
}

async function run(command: string[]): Promise<{ code: number; out: string }> {
  try {
    const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, out: (out + err).trim() };
  } catch (caught) {
    return { code: 127, out: (caught as Error).message };
  }
}

export interface PreflightOptions {
  image?: string;
  kdiServiceProbeUrl?: string;
  /** Run kickstart uses this; `bench doctor` remains a read-only check. */
  startKdiService?: boolean;
  /** Env entries the run will forward, as `NAME` or `NAME=VALUE`. */
  env?: readonly string[];
  /** The run's --agent-dir, or "none"/absent for API keys only. */
  agentDir?: string;
  /** Accept a ClickHouse or PostgreSQL login without a password (local development only). */
  allowOpenDb?: boolean;
  /** .env.local to read database settings from; tests point it elsewhere. */
  envFile?: string;
  /** Called as each check finishes, so a screen can fill in rather than wait. */
  onCheck?: (check: Check, soFar: readonly Check[]) => void;
}

export async function preflight(options: PreflightOptions = {}): Promise<Check[]> {
  const image = options.image ?? DEFAULTS.image;
  const collected: Check[] = [];
  const checks = {
    push(...added: Check[]) {
      collected.push(...added);
      for (const check of added) options.onCheck?.(check, collected);
    },
  };

  const docker = await run([DEFAULTS.docker, "version", "--format", "{{.Server.Version}}"]);
  checks.push({
    name: "docker",
    ok: docker.code === 0,
    detail: docker.code === 0 ? `daemon ${docker.out.split("\n")[0]}` : `not usable: ${docker.out.split("\n")[0] ?? "no docker"}`,
  });

  if (docker.code === 0) {
    const images = await run([DEFAULTS.docker, "image", "inspect", image, "--format", "{{.Id}}"]);
    checks.push({
      name: `image ${image}`,
      ok: images.code === 0,
      detail: images.code === 0
        ? "present"
        : "missing; build pi with kierston_bench/agent_eval_runtime/build-pi.sh (needs a pi-cwl checkout, PI_SRC), then kierston_bench/agent_eval_runtime/evalenv build",
    });
  }

  checks.push({
    name: "sim_data",
    ok: await directoryExists(PATHS.simData),
    detail: await directoryExists(PATHS.simData)
      ? `${PATHS.simData} — identifiers can be resolved for scoring`
      : `${PATHS.simData} is missing; runs work, scoring cannot resolve identifiers`,
    advisory: true,
  });

  checks.push(await agentCredentials(options.agentDir, options.env ?? []));

  const envFile = options.envFile ?? PATHS.envLocal;
  const env = await stat(envFile).then(() => true, () => false);
  checks.push({
    name: ".env.local",
    ok: env,
    detail: env ? envFile : "missing; KDI cannot reach ClickHouse or PostgreSQL",
  });
  checks.push(await databaseLogins(envFile, options.allowOpenDb ?? process.env.BENCH_ALLOW_OPEN_DB === "1"));

  // Last, because `kdi health` opens the event stores and is much the slowest
  // check here: everything cheap is on screen before this one starts.
  const kdiServiceUrl = options.kdiServiceProbeUrl ?? DEFAULTS.kdiServiceProbeUrl;
  const service = options.startKdiService ? await ensureKdiService(kdiServiceUrl) : await probeKdiService(kdiServiceUrl);
  checks.push({ name: "KDI service", ok: service.ok, detail: service.detail });

  return collected;
}

/**
 * Providers pi authenticates against: the provider id pi uses as the key of
 * auth.json and in `--model provider/id`, and the variables that carry an API
 * key for it (pi's docs/providers.md). A provider that signs in only by OAuth
 * (openai-codex) has no variable. `--env` naming a variable outside this table
 * is still accepted as the run's credentials: pi supports custom providers
 * whose key variable is whatever models.json says.
 */
export const PROVIDERS: { name: string; keys: string[]; envVars: string[] }[] = [
  { name: "anthropic", keys: ["anthropic"], envVars: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"] },
  { name: "openai", keys: ["openai"], envVars: ["OPENAI_API_KEY"] },
  { name: "openai-codex", keys: ["openai-codex"], envVars: [] },
  { name: "azure-openai", keys: ["azure-openai-responses"], envVars: ["AZURE_OPENAI_API_KEY"] },
  { name: "google", keys: ["google", "gemini", "google-gemini-cli", "google-antigravity"], envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] },
  { name: "google-vertex", keys: ["google-vertex"], envVars: ["GOOGLE_CLOUD_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"] },
  { name: "amazon-bedrock", keys: ["amazon-bedrock"], envVars: ["AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_PROFILE"] },
  { name: "openrouter", keys: ["openrouter"], envVars: ["OPENROUTER_API_KEY"] },
  { name: "mistral", keys: ["mistral"], envVars: ["MISTRAL_API_KEY"] },
  { name: "groq", keys: ["groq"], envVars: ["GROQ_API_KEY"] },
  { name: "xai", keys: ["xai"], envVars: ["XAI_API_KEY"] },
  { name: "deepseek", keys: ["deepseek"], envVars: ["DEEPSEEK_API_KEY"] },
  { name: "cerebras", keys: ["cerebras"], envVars: ["CEREBRAS_API_KEY"] },
  { name: "zai", keys: ["zai"], envVars: ["ZAI_API_KEY"] },
  { name: "huggingface", keys: ["huggingface"], envVars: ["HF_TOKEN"] },
  { name: "vercel-ai-gateway", keys: ["vercel-ai-gateway"], envVars: ["AI_GATEWAY_API_KEY"] },
  { name: "opencode", keys: ["opencode", "opencode-go"], envVars: ["OPENCODE_API_KEY"] },
  { name: "kimi", keys: ["kimi-coding"], envVars: ["KIMI_API_KEY"] },
  { name: "minimax", keys: ["minimax", "minimax-cn"], envVars: ["MINIMAX_API_KEY", "MINIMAX_CN_API_KEY"] },
  { name: "github-copilot", keys: ["github-copilot"], envVars: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] },
];

const KNOWN_KEY_VARS = new Set(PROVIDERS.flatMap((provider) => provider.envVars));

/** The variables `env` really forwards: `NAME` needs a host value, `NAME=VALUE` a non-empty one. */
function forwarded(env: readonly string[]): string[] {
  return env.flatMap((entry) => {
    const key = entry.split("=")[0]!.trim();
    const live = entry.includes("=") ? entry.slice(entry.indexOf("=") + 1).trim() !== "" : (process.env[key] ?? "") !== "";
    return live && key ? [key] : [];
  });
}

/** Variables that configure a run rather than authenticate it, so they never count as credentials. */
const NOT_CREDENTIALS = /^(BENCH_|KIERSTON_|PATH$|HOME$|TZ$|LANG$|LC_|NO_COLOR$|FORCE_COLOR$|PI_OFFLINE$)/;

/**
 * Whether the container will be able to authenticate at all.
 *
 * A run whose agent cannot log in fails every task in about a second, which is
 * an expensive way to find out. The credentials are an API key the run
 * forwards explicitly, or the auth.json of an --agent-dir the run names (each
 * task gets a copy), whose OAuth tokens expire — so this reads the expiry
 * rather than trusting the file to exist. A forwarded variable pi does not
 * know by name is taken as a custom provider's key rather than refused.
 */
export async function agentCredentials(agentDir: string | undefined, env: readonly string[]): Promise<Check> {
  const name = "agent credentials";
  const sent = forwarded(env);
  const known = sent.filter((variable) => KNOWN_KEY_VARS.has(variable));
  if (known.length > 0) {
    return { name, ok: true, detail: `${known.join(", ")} forwarded to the container` };
  }
  const dir = agentDir && agentDir !== "none" ? resolve(agentDir.replace(/^~(?=\/|$)/, homedir())) : undefined;
  const custom = sent.filter((variable) => !NOT_CREDENTIALS.test(variable));
  if (!dir) {
    if (custom.length > 0) return { name, ok: true, detail: `${custom.join(", ")} forwarded; not a known provider key, taken as the agent's credentials` };
    return { name, ok: false, detail: "no API key forwarded; add one to Env (e.g. --env ANTHROPIC_API_KEY), or name a pi agent directory with --agent-dir" };
  }
  if (!(await directoryExists(dir))) {
    return { name, ok: false, detail: `${dir} is missing; add an API key to Env, or --env ANTHROPIC_API_KEY` };
  }
  const auth = await Bun.file(join(dir, "auth.json")).json().catch(() => null) as Record<string, { expires?: number; type?: string; key?: string }> | null;
  if (!auth) {
    if (custom.length > 0) return { name, ok: true, detail: `${custom.join(", ")} forwarded; ${dir} holds no auth.json` };
    return { name, ok: false, detail: `${dir} holds no auth.json; log in with pi on the host, or add an API key to Env` };
  }
  const live = Object.entries(auth).filter(([, entry]) =>
    typeof entry?.expires === "number" ? entry.expires > Date.now() : typeof entry?.key === "string" && entry.key !== "");
  if (live.length > 0) {
    return { name, ok: true, detail: `${dir} — ${live.map(([provider]) => provider).join(", ")} signed in (a copy per task; token refreshes are not kept)` };
  }
  if (custom.length > 0) return { name, ok: true, detail: `${custom.join(", ")} forwarded; ${dir} holds no live sign-in` };
  const newest = Object.values(auth).map((entry) => entry?.expires).filter((expires): expires is number => typeof expires === "number").sort((a, b) => b - a)[0];
  const when = newest ? ` ${new Date(newest).toISOString().slice(0, 10)}` : "";
  return {
    name,
    ok: false,
    detail: `${dir} credentials expired${when}; refresh them with pi on the host, or add an API key such as ANTHROPIC_API_KEY to Env`,
  };
}

/** `.env`-style lines: NAME=value, # comments, optional quotes. */
function parseEnvFile(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf("=");
    if (!line || line.startsWith("#") || eq === -1) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length > 1 && /^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    values.set(line.slice(0, eq).replace(/^export\s+/, "").trim(), value);
  }
  return values;
}

/**
 * Whether the stores the KDI service reads are locked. A container can reach the
 * host through host.docker.internal, so a ClickHouse or PostgreSQL that takes
 * a login without a password is open to the agent directly, around the KDI service.
 * The shell's own variables win over .env.local, as they do for KDI.
 */
export async function databaseLogins(envFile: string, allowOpen: boolean): Promise<Check> {
  const name = "database passwords";
  const file = parseEnvFile(await readFile(envFile, "utf8").catch(() => ""));
  const value = (key: string) => process.env[key] ?? file.get(key);
  const problems: string[] = [];
  if (!value("CLICKHOUSE_PASSWORD")) problems.push("CLICKHOUSE_PASSWORD is empty");
  const url = value("POSTGRES_URL");
  let postgresPassword = "";
  try { postgresPassword = url ? decodeURIComponent(new URL(url).password) : ""; } catch { /* not a URL */ }
  if (!postgresPassword) problems.push(url ? "POSTGRES_URL carries no password" : "POSTGRES_URL is not set");
  if (problems.length === 0) return { name, ok: true, detail: "ClickHouse and PostgreSQL require a password" };
  if (allowOpen) return { name, ok: true, advisory: true, detail: `${problems.join("; ")}; allowed by --allow-open-db (local development only)` };
  return {
    name,
    ok: false,
    detail: `${problems.join("; ")}: containers can reach host databases through host.docker.internal; set passwords in .env.local, or pass --allow-open-db for local development`,
  };
}

export interface KdiServiceProbe {
  ok: boolean;
  /** Distinguishes a running KDI service with unhealthy stores from no KDI service at all. */
  reachable: boolean;
  detail: string;
}

interface KdiServiceResult {
  code?: number;
  out?: string;
  err?: string;
}

/** Read both the legacy response object and the KDI service's streaming JSONL protocol. */
async function readKdiServiceResult(response: Response): Promise<KdiServiceResult> {
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/x-adi-stream+jsonl")) {
    return (await response.json()) as KdiServiceResult;
  }

  const result: KdiServiceResult = { out: "", err: "" };
  for (const line of (await response.text()).split("\n")) {
    if (!line.trim()) continue;
    const frame = JSON.parse(line) as { stream?: "out" | "err" | "end"; data?: string; code?: number };
    if (frame.stream === "end") {
      result.code = frame.code;
    } else if ((frame.stream === "out" || frame.stream === "err") && typeof frame.data === "string") {
      result[frame.stream] += Buffer.from(frame.data, "base64").toString();
    }
  }
  return result;
}

/**
 * The address the KDI service binds, from KDI_SERVICE_HOST: loopback by default, which
 * Docker Desktop reaches through host.docker.internal. Native Linux Docker's
 * host-gateway is the docker0 bridge address (often 172.17.0.1), which a
 * loopback listener never sees; set KDI_SERVICE_HOST to that address there.
 */
export function kdiServiceBindHost(): string {
  return process.env.KDI_SERVICE_HOST?.trim() || "127.0.0.1";
}

/** Translate the URL visible in a container to the same endpoint on the host. */
export function kdiServiceProbeUrl(containerUrl: string): string {
  let url: URL;
  try {
    url = new URL(containerUrl);
  } catch {
    return containerUrl;
  }
  const bind = kdiServiceBindHost();
  if (url.hostname === "host.docker.internal") url.hostname = bind === "0.0.0.0" || bind === "::" ? "127.0.0.1" : bind;
  return url.toString().replace(/\/$/, "");
}

/**
 * The KDI service answers a POST; `kdi health` through it proves the stores too.
 *
 * The budget is generous on purpose: `kdi health` opens the event stores, which
 * routinely takes the better part of ten seconds on a cold connection pool.
 * A budget shorter than that reports a working KDI service as dead, which is worse
 * than waiting — this runs once, before a run that takes minutes.
 */
export async function probeKdiService(url: string, timeoutMs = 20_000): Promise<KdiServiceProbe> {
  if (!(await kdiServiceIsReachable(url))) {
    return { ok: false, reachable: false, detail: `not reachable at ${url}; a run will start it automatically` };
  }
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args: ["health"] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false, reachable: true, detail: `answered ${response.status} at ${url}` };
    const body = await readKdiServiceResult(response);
    if (body.code !== 0) return { ok: false, reachable: true, detail: `up, but kdi health failed: ${(body.err ?? "").split("\n")[0]}` };
    const seconds = (Date.now() - started) / 1000;
    // A slow but healthy KDI service is worth saying out loud; it is the thing that
    // used to look like a failure.
    const slow = seconds >= 2 ? ` in ${seconds.toFixed(1)} s` : "";
    return { ok: true, reachable: true, detail: `up at ${url}, KDI healthy${slow}` };
  } catch (caught) {
    const message =
      (caught as Error).name === "TimeoutError"
        ? `no answer within ${Math.round(timeoutMs / 1000)} s`
        : (caught as Error).message;
    return { ok: false, reachable: true, detail: `up at ${url}, but kdi health failed: ${message}` };
  }
}

/** A GET is deliberately cheap: any HTTP response proves the KDI service is listening. */
async function kdiServiceIsReachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { method: "GET", signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

/** Start the repository's local KDI service when absent, then wait for it to listen. */
export async function ensureKdiService(url: string): Promise<KdiServiceProbe> {
  const before = await probeKdiService(url);
  if (before.reachable) return before;

  let endpoint: URL;
  try {
    endpoint = new URL(url);
  } catch {
    return { ...before, detail: `${before.detail}; KDI service URL is invalid` };
  }
  const bind = kdiServiceBindHost();
  if (endpoint.protocol !== "http:" || (endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "localhost" && endpoint.hostname !== bind)) {
    return { ...before, detail: `${before.detail}; refusing to replace a remote KDI service` };
  }
  const port = endpoint.port || "80";
  const child = spawn(process.execPath, ["run", PATHS.kdiService], {
    cwd: BENCH_ROOT,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, KDI_SERVICE_HOST: bind, KDI_SERVICE_PORT: port },
  });
  child.on("error", () => {});
  child.unref();

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await Bun.sleep(100);
    if (await kdiServiceIsReachable(url)) {
      // The first KDI process also establishes the stores' initial connections.
      // Give that cold start room without making every `bench doctor` probe slow.
      const result = await probeKdiService(url, 30_000);
      return { ...result, detail: result.ok ? `${result.detail} (started automatically)` : `${result.detail} (KDI service started automatically)` };
    }
  }
  return { ...before, detail: `${before.detail}; automatic startup timed out` };
}

/**
 * Start the KDI service if it is down, or refuse. Resumes and reruns skip the full
 * preflight, and an agent sent in without the KDI service abstains on every task.
 */
export async function requireKdiService(containerUrl: string): Promise<void> {
  const service = await ensureKdiService(kdiServiceProbeUrl(containerUrl));
  if (!service.ok) throw new Error(`KDI service: ${service.detail}`);
}

/** Containers this run has open right now, by name prefix. */
export async function runningContainers(runId?: string): Promise<string[]> {
  const filter = runId ? `name=bench-${runId.replace(/[^A-Za-z0-9_.-]/g, "_")}` : "name=bench-";
  const result = await run([DEFAULTS.docker, "ps", "--filter", filter, "--format", "{{.Names}}"]);
  if (result.code !== 0) return [];
  return result.out.split("\n").filter((line) => line.trim() !== "");
}
