import { realpath, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

async function canonical(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const absolute = resolve(path), parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return resolve(await canonical(parent), basename(absolute));
  }
}

/** Protect sources even when paths differ through symlinks or hard links. */
export async function distinctOutput(output: string, inputs: readonly string[]): Promise<void> {
  const target = await canonical(output);
  const targetStat = await stat(output).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; });
  for (const input of inputs) {
    if (target === await canonical(input)) throw new Error("output and input paths must differ");
    const source = await stat(input);
    if (targetStat && targetStat.dev === source.dev && targetStat.ino === source.ino) throw new Error("output and input paths must differ");
  }
}
