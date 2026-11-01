import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readManaged, saveManaged } from "./background.ts";
import { REPO_ROOT } from "./paths.ts";

const dir = process.argv[2]!;
const record = (await readManaged(dir))!;
if (!record || record.state !== "starting") throw new Error("Run is not awaiting a worker");
const launch = JSON.parse(await readFile(join(dir, "launch.json"), "utf8"));
let child: ReturnType<typeof Bun.spawn> | undefined;
let stopping = false;
const stop = () => {
  stopping = true;
  record.state = "stopping";
  child?.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(request) {
    if (request.headers.get("authorization") !== `Bearer ${record.token}`) return new Response(null, { status: 403 });
    const path = new URL(request.url).pathname;
    if (path === "/stop" && request.method === "POST") stop();
    else if (path !== "/health" || request.method !== "GET") return new Response(null, { status: 404 });
    return Response.json(record);
  },
});
record.pid = process.pid;
record.port = server.port;
record.state = "running";
// Serialize heartbeat writes so final state cannot be overwritten by an older tick.
let writes = Promise.resolve();
const persist = () => { record.heartbeat = Date.now(); const snapshot = { ...record }; writes = writes.then(() => saveManaged(dir, snapshot)); return writes; };
await persist();
const timer = setInterval(() => { void persist(); }, 2000);
try {
  const log = await open(join(dir, "runner.log"), "a", 0o600);
  try {
    child = Bun.spawn([process.execPath, ...launch.args], { cwd: REPO_ROOT, env: { ...process.env, ...launch.env, BENCH_WORKER_URL: `http://127.0.0.1:${record.port}/health`, BENCH_WORKER_TOKEN: record.token }, stdin: "ignore", stdout: log.fd, stderr: log.fd });
    if (stopping) child.kill("SIGTERM");
    record.exitCode = await child.exited;
    const report = await Bun.file(join(dir, "run.json")).json().catch(() => null);
    record.state = !stopping && record.exitCode === 0 && report && !report.interrupted ? "finished" : "failed";
  } finally { await log.close(); }
} catch (error) { record.state = "failed"; record.error = String(error); record.exitCode = 1; }
clearInterval(timer);
await persist();
server.stop(true);
process.exit(record.exitCode ?? 1);
