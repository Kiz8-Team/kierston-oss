import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fastgateScenarios } from "../src/scenarios.ts";

test("forwards scenario progress before the child exits and preserves JSON stdout", async () => {
  const root = await mkdtemp(join(tmpdir(), "scenario-progress-"));
  try {
    await mkdir(join(root, "fastgate/src"), { recursive: true });
    await writeFile(join(root, "fastgate/src/cli.ts"), `
      import { existsSync } from "node:fs";
      import { setTimeout as sleep } from "node:timers/promises";
      if (process.argv[2] === "list-scenarios") console.log("[]");
      else {
        process.stderr.write("[scenario] Deleting network_events\\n");
        const deadline = Date.now() + 3000;
        while (!existsSync("ack") && Date.now() < deadline) await sleep(10);
        if (!existsSync("ack")) throw new Error("progress was buffered until exit");
        process.stderr.write("[scenario] Applied scenario");
      }
    `);
    const lines: string[] = [];
    const store = fastgateScenarios(root, (line) => {
      lines.push(line);
      if (line.includes("Deleting")) void writeFile(join(root, "fastgate/ack"), "ok");
    });
    expect(await store.active()).toEqual([]);
    await store.apply("fixture.kdiff");
    expect(lines).toEqual(["[scenario] Deleting network_events", "[scenario] Applied scenario"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a timed-out ClickHouse request rejects instead of hanging the scenario runner", async () => {
  const root = await mkdtemp(join(tmpdir(), "scenario-timeout-"));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
    await Bun.sleep(200);
    return new Response("");
  } });
  try {
    await mkdir(join(root, "fastgate/src"), { recursive: true });
    const client = Bun.resolveSync("@clickhouse/client", fileURLToPath(new URL("../../../fastgate/", import.meta.url)));
    await writeFile(join(root, "fastgate/src/cli.ts"), `
      import { createClient } from ${JSON.stringify(client)};
      const guard = setTimeout(() => process.exit(9), 2000);
      const c = createClient({url: "http://127.0.0.1:${server.port}", request_timeout: 50, log: {level: "OFF"}});
      try { await c.command({query: "SELECT 1"}); }
      catch (e) { console.error(e.message); process.exitCode = 1; }
      finally { await c.close(); clearTimeout(guard); }
    `);
    await expect(fastgateScenarios(root).apply("fixture.kdiff")).rejects.toThrow("Timeout error");
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
