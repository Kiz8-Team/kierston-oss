import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteSeries } from "../src/delete-series.ts";
import { listSeries } from "../src/inventory.ts";
import { seriesToml } from "../src/series-config.ts";

async function fixture(): Promise<{ root: string; runsDir: string; seriesDir: string; configsDir: string; staged: string }> {
  const root = await mkdtemp(join(tmpdir(), "kbench-delete-series-"));
  const dirs = { root, runsDir: join(root, "runs"), seriesDir: join(root, "run_series"), configsDir: join(root, "configs"), staged: join(root, "scenarios") };
  for (const dir of [dirs.runsDir, dirs.seriesDir, dirs.configsDir, dirs.staged]) await mkdir(dir, { recursive: true });
  return dirs;
}

function writeSeries(seriesDir: string, id: string, deltas: string[]): Promise<void> {
  return writeFile(join(seriesDir, `run_series_${id}_tasks_data.json`), JSON.stringify({
    series: { id, createdAt: "2026-09-13T00:00:00.000Z", seed: 1, days: [], families: [], taskCount: 3,
      scenarios: deltas.map((delta) => ({ id: "s", name: "s", seed: 1, date: "2026-09-04", base: "b.bin", delta })) },
    outcomes: [], tasks: [],
  }));
}

test("deleting a series removes its runs, generated config and the kdiffs no other series names", async () => {
  const { root, runsDir, seriesDir, configsDir, staged } = await fixture();
  try {
    await mkdir(join(runsDir, "gone", "run-1", "task"), { recursive: true });
    await mkdir(join(runsDir, "gone", "run-2"), { recursive: true });
    await mkdir(join(runsDir, "stays", "run-1"), { recursive: true });
    await mkdir(join(staged, "gone"), { recursive: true });
    await mkdir(join(staged, "sweep"), { recursive: true });
    const own = join(staged, "gone", "a.kdiff"), shared = join(staged, "sweep", "b.kdiff");
    await writeFile(own, "x");
    await writeFile(shared, "x");
    await writeSeries(seriesDir, "gone", [own, shared]);
    await writeSeries(seriesDir, "stays", [shared]);
    await writeFile(join(configsDir, "gone.toml"), seriesToml({ id: "gone", seed: 1, days: [], families: new Set(), copies: 1, attempts: 1 }));

    const all = await listSeries(runsDir, seriesDir);
    const gone = all.find((series) => series.id === "gone")!;
    expect(await deleteSeries(gone, all, runsDir, configsDir)).toEqual({ runs: 2, deltas: 1, shared: 1, config: true });

    expect((await listSeries(runsDir, seriesDir)).map((series) => series.id)).toEqual(["stays"]);
    expect(await readdir(runsDir)).toEqual(["stays"]);
    expect(await readdir(staged)).toEqual(["sweep"]);
    expect(await Bun.file(shared).exists()).toBe(true);
    expect(await readdir(configsDir)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a hand-written config under the series id is the source and stays", async () => {
  const { root, runsDir, seriesDir, configsDir } = await fixture();
  try {
    await writeSeries(seriesDir, "authored", []);
    await writeFile(join(configsDir, "authored.toml"), '[series]\nid = "authored"\n');
    const all = await listSeries(runsDir, seriesDir);
    expect((await deleteSeries(all[0]!, all, runsDir, configsDir)).config).toBe(false);
    expect(await readdir(configsDir)).toEqual(["authored.toml"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a series id that climbs out of the runs directory is refused", async () => {
  const { root, runsDir, configsDir } = await fixture();
  try {
    const series = { id: "..", file: join(root, "none.json"), createdAt: "", seed: 0, taskCount: 0, families: [], days: [], runs: 0 };
    await expect(deleteSeries(series, [series], runsDir, configsDir)).rejects.toThrow("escapes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
