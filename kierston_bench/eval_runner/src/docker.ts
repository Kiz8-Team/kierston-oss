/**
 * One container, one task. Starts `docker run --rm` with the given mounts
 * and environment, streams stdout and stderr into a console file while it
 * runs. With `killAfterMs` the container is killed once that long has passed;
 * without it a task runs until it ends or an operator stops it.
 *
 * The docker binary comes from options so tests can stand in a script.
 */

export interface Mount {
  host: string;
  container: string;
  readOnly?: boolean;
}

export interface ContainerOptions {
  docker: string;
  image: string;
  name: string;
  mounts: Mount[];
  env: Record<string, string>;
  /** Extra `docker run` flags, passed through verbatim before the image. */
  extraArgs: string[];
  /** Command after the image; empty means the image's own entrypoint. */
  command: string[];
  /** Legacy setting, ignored. Kept for callers and saved launch compatibility. */
  timeoutMs: number;
  /** Kill the container after this long. Absent or 0 means never. */
  killAfterMs?: number;
  consolePath: string;
}

export interface ContainerOutcome {
  exitCode: number | null;
  timedOut: boolean;
}

/** Container names allow [a-zA-Z0-9][a-zA-Z0-9_.-]*. */
export function containerName(...parts: string[]): string {
  const name = parts.join("-").replace(/[^a-zA-Z0-9_.-]/g, "_").replace(/^[^a-zA-Z0-9]+/, "");
  return name.slice(0, 120) || "bench";
}

export function runArgs(options: ContainerOptions): string[] {
  const args = ["run", "--rm", "--name", options.name, "--add-host=host.docker.internal:host-gateway"];
  for (const mount of options.mounts) {
    args.push("-v", `${mount.host}:${mount.container}${mount.readOnly ? ":ro" : ""}`);
  }
  for (const [key, value] of Object.entries(options.env)) args.push("-e", `${key}=${value}`);
  args.push(...options.extraArgs, options.image, ...options.command);
  return args;
}

export async function runContainer(options: ContainerOptions): Promise<ContainerOutcome> {
  const sink = Bun.file(options.consolePath).writer();
  const child = Bun.spawn([options.docker, ...runArgs(options)], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // Bun.spawn otherwise snapshots the environment at startup.
    env: process.env,
  });

  let timedOut = false;
  const killer = options.killAfterMs && options.killAfterMs > 0
    ? setTimeout(() => {
      timedOut = true;
      void kill(options.docker, options.name);
    }, options.killAfterMs)
    : undefined;
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) sink.write(chunk);
  };
  const [, , exitCode] = await Promise.all([pump(child.stdout), pump(child.stderr), child.exited]).finally(() => clearTimeout(killer));
  await sink.end();
  return { exitCode: exitCode ?? null, timedOut };
}

/** Best-effort stop on operator interrupt. */
export async function kill(docker: string, name: string): Promise<void> {
  try {
    const proc = Bun.spawn([docker, "kill", name], { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
  } catch {
    // The container may already be gone; nothing to do.
  }
}
