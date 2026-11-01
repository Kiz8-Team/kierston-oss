import { expect, test } from "bun:test";
import { join } from "node:path";
import { descendants } from "../src/shutdown.ts";

test("descendants walks the whole tree and spares background subtrees", () => {
  const table = [
    { pid: 10, ppid: 1, command: "bun bench ui" },
    { pid: 11, ppid: 10, command: "bun run eval_runner/src/cli.ts" },
    { pid: 12, ppid: 11, command: "docker run --rm bench-x-t1" },
    { pid: 13, ppid: 10, command: "bun run background-worker.ts /runs/x" },
    { pid: 14, ppid: 13, command: "bun run eval_runner/src/cli.ts" },
    { pid: 15, ppid: 10, command: "bun run agent_eval_runtime/kdi_service.ts" },
    { pid: 20, ppid: 1, command: "unrelated" },
  ];
  const spare = (proc: { command: string }) => proc.command.includes("background-worker.ts");
  expect(descendants(table, 10, spare).sort()).toEqual([11, 12, 15]);
});

test("shutdown kills grandchildren that ignore SIGTERM", async () => {
  // Run in a process of its own: shutdown kills everything below its caller,
  // and the test runner's other children are not ours to kill.
  const grandchild = `process.on('SIGTERM',()=>{});console.log(process.pid);setInterval(()=>{},1000)`;
  const child = `process.on("SIGTERM",()=>{});Bun.spawn([process.execPath,"-e",${JSON.stringify(grandchild)}],{stdout:"inherit"});setInterval(()=>{},1000)`;
  const owner = `
    import { shutdown } from ${JSON.stringify(join(import.meta.dir, "../src/shutdown.ts"))};
    const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(child)}], { stdout: "pipe" });
    const pid = new TextDecoder().decode((await child.stdout.getReader().read()).value).trim();
    await shutdown({ runners: [], keepKdiService: false, docker: "/nonexistent" });
    console.log(pid);
  `;
  const run = Bun.spawn([process.execPath, "-e", owner], { stdout: "pipe" });
  const pid = Number((await new Response(run.stdout).text()).trim());
  await run.exited;
  expect(pid).toBeGreaterThan(0);
  expect(() => process.kill(pid, 0)).toThrow();
}, 10_000);
