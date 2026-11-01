import { readdir, realpath, stat } from 'node:fs/promises';
import { resolve, relative, sep, join } from 'node:path';
import { listRuns, loadRun } from '../../kierston_bench/bench_cli/src/inventory.ts';
import { PATHS } from '../../kierston_bench/bench_cli/src/paths.ts';
import { taskDirName } from '../../kierston_bench/eval_runner/src/runner.ts';

// Resolve symlinks too: artifacts must stay inside the selected run.
export async function contained(root: string, path: string) {
  const base = await realpath(root);
  const target = await realpath(resolve(base, path));
  const rel = relative(base, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new Error('Outside run directory');
  return target;
}
async function files(root: string, sub = ''): Promise<string[]> {
  const entries = await readdir(join(root, sub), { withFileTypes: true }).catch(() => []);
  const groups = await Promise.all(entries.map(async entry => {
    const path = join(sub, entry.name);
    if (entry.isSymbolicLink()) return [];
    return entry.isDirectory() ? files(root, path) : [path];
  }));
  return groups.flat().sort();
}
export async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  const json = (data: unknown, status = 200) => Response.json(data, { status, headers });
  if (request.method !== 'GET') return json({ error: 'Read-only server' }, 405);
  try {
    if (url.pathname === '/') return new Response(Bun.file(join(import.meta.dir, 'index.html')), { headers });
    if (url.pathname === '/api/runs') return json(await listRuns());
    if (!['/api/run', '/api/task', '/api/file'].includes(url.pathname)) return json({ error: 'Not found' }, 404);
    const series = url.searchParams.get('series') ?? '';
    const runId = url.searchParams.get('run') ?? '';
    if (![series, runId].every(s => s && s !== '.' && s !== '..' && !/[\\/]/.test(s))) return json({ error: 'Invalid run' }, 400);
    const dir = await contained(PATHS.runs, join(series, runId));
    if (url.pathname === '/api/run') return json(await loadRun(dir, series, runId));
    const task = url.searchParams.get('task') ?? '';
    if (!task) return json({ error: 'Missing task' }, 400);
    const taskDir = await contained(dir, taskDirName(task));
    if (url.pathname === '/api/task') return json({ files: await files(taskDir) });
    const file = await contained(taskDir, url.searchParams.get('file') ?? '');
    if (!(await stat(file)).isFile()) return json({ error: 'Not a file' }, 400);
    // Limit previews so large logs cannot freeze the browser. Downloads stream in full.
    const blob = Bun.file(file);
    if (url.searchParams.has('download')) return new Response(blob, { headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment' } });
    const limit = 2 * 1024 * 1024;
    return json({ text: await blob.slice(0, limit).text(), truncated: blob.size > limit, size: blob.size });
  } catch (error) {
    return json({ error: error instanceof Error && error.message === 'Outside run directory' ? error.message : 'Run or artifact not found' }, 404);
  }
}
if (import.meta.main) {
  const server = Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.PORT ?? 8788), fetch: handle });
  console.log(`Run browser: ${server.url}`);
}
