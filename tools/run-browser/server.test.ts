import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contained, handle } from './server';

test('artifact containment blocks traversal and escaping symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'run-browser-'));
  try {
    await mkdir(join(root, 'run'));
    await writeFile(join(root, 'outside'), 'private');
    await writeFile(join(root, 'run', 'answer.json'), '{}');
    await symlink(join(root, 'outside'), join(root, 'run', 'link'));
    expect(await contained(join(root, 'run'), 'answer.json')).toEndWith('/run/answer.json');
    await expect(contained(join(root, 'run'), '../outside')).rejects.toThrow('Outside run');
    await expect(contained(join(root, 'run'), 'link')).rejects.toThrow('Outside run');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('server serves page, rejects writes and invalid run paths', async () => {
  expect((await handle(new Request('http://localhost/'))).status).toBe(200);
  expect((await handle(new Request('http://localhost/api/runs', { method: 'POST' }))).status).toBe(405);
  expect((await handle(new Request('http://localhost/api/run?series=..&run=x'))).status).toBe(400);
  expect((await handle(new Request('http://localhost/missing'))).status).toBe(404);
});
test('existing runs expose task details and artifacts', async () => {
  const runs = await (await handle(new Request('http://localhost/api/runs'))).json();
  expect(Array.isArray(runs)).toBe(true);
  for (const run of runs.slice(0, 1)) {
    const q = new URLSearchParams({ series: run.series, run: run.runId });
    const detail = await (await handle(new Request('http://localhost/api/run?' + q))).json();
    expect(Array.isArray(detail.tasks)).toBe(true);
    const task = detail.tasks.find((t: any) => t.hasAnswer);
    if (!task) continue;
    q.set('task', task.id);
    const artifacts = await (await handle(new Request('http://localhost/api/task?' + q))).json();
    expect(artifacts.files).toContain('answer.json');
    q.set('file', 'answer.json');
    const file = await (await handle(new Request('http://localhost/api/file?' + q))).json();
    expect(JSON.parse(file.text)).toHaveProperty('answer');
  }
});
