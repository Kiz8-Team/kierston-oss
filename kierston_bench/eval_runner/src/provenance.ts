/**
 * What a run was made with, recorded in run.json so a score can be traced to
 * a model, an image, a pi build and a commit.
 *
 * Every probe is best effort: a missing docker, git or label leaves its field
 * null rather than failing the run.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface RunProvenance {
  /** The model the run asked for (--model), or null when pi chose its own default. */
  model: string | null;
  /** `provider/model` pi reported in each task's transcript, deduplicated; filled in when the run ends. */
  modelsSeen?: string[];
  image: string;
  /** `docker image inspect` Id, and the registry digests when the image was pulled or pushed. */
  imageId: string | null;
  imageDigests: string[];
  /** The image's `pi.version` label, else the host build's package.json with `piVersionSource` saying so. */
  piVersion: string | null;
  piVersionSource?: "image label" | "host build";
  gitHead: string | null;
  /** Uncommitted changes in the repository when the run started. */
  gitDirty: boolean | null;
}

const BENCH_ROOT = resolve(import.meta.dir, "../..");

/** A command's stdout, or null when it fails or takes longer than `timeoutMs`. */
async function output(command: string[], cwd?: string, timeoutMs = 15_000): Promise<string | null> {
  try {
    const child = Bun.spawn(command, { cwd, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]).finally(() => clearTimeout(timer));
    return code === 0 ? text : null;
  } catch {
    return null;
  }
}

/** HEAD and whether the working tree has changes, for the repository holding `dir`. */
export async function gitState(dir: string): Promise<{ head: string | null; dirty: boolean | null }> {
  const head = (await output(["git", "rev-parse", "HEAD"], dir))?.trim() || null;
  const status = await output(["git", "status", "--porcelain", "--untracked-files=no"], dir);
  return { head, dirty: status === null ? null : status.trim() !== "" };
}

export async function runProvenance(options: { docker: string; image: string; model?: string }): Promise<RunProvenance> {
  const inspected = await output([options.docker, "image", "inspect", options.image, "--format", "{{json .}}"]);
  let imageId: string | null = null;
  let imageDigests: string[] = [];
  let label: string | null = null;
  try {
    const image = inspected ? JSON.parse(inspected) as { Id?: string; RepoDigests?: string[]; Config?: { Labels?: Record<string, string> | null } } : null;
    imageId = image?.Id ?? null;
    imageDigests = image?.RepoDigests ?? [];
    const value = image?.Config?.Labels?.["pi.version"];
    label = value && value !== "unknown" ? value : null;
  } catch { /* not an image description */ }
  const hostPi = label ? null : await readFile(resolve(BENCH_ROOT, "agent_eval_runtime/pi/package.json"), "utf8")
    .then((text) => (JSON.parse(text) as { version?: string }).version ?? null, () => null);
  const git = await gitState(BENCH_ROOT);
  return {
    model: options.model ?? null,
    image: options.image,
    imageId,
    imageDigests,
    piVersion: label ?? hostPi,
    ...(label ? { piVersionSource: "image label" as const } : hostPi ? { piVersionSource: "host build" as const } : {}),
    gitHead: git.head,
    gitDirty: git.dirty,
  };
}
