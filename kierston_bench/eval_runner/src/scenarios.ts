/**
 * The event store's scenario state, as the runner sees it: which dates have a
 * scenario applied, applying a task's `.kdiff` over its base day, and
 * reverting a date to that base.
 *
 * Driven through the Fastgate CLI rather than imported: Fastgate carries its
 * own ClickHouse client and reads the project `.env.local`, the same
 * credentials KDI uses, so the runner stays free of both.
 */

import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface ActiveScenario {
  date: string;
  baseDigest: string;
  scenarioDigest: string;
  status: "importing" | "complete";
}

export interface ScenarioStore {
  active(): Promise<ActiveScenario[]>;
  /** Path absolute. Fails when the delta's exact base day is not the one imported. */
  apply(delta: string): Promise<void>;
  revert(date: string): Promise<void>;
}

export function fastgateScenarios(repoRoot: string, log: (line: string) => void = () => {}): ScenarioStore {
  const dir = join(repoRoot, "fastgate");
  const run = async (args: string[]): Promise<string> => {
    // Bun's node:http timeout path can hang instead of rejecting a slow
    // ClickHouse request. Run this Node client under Node (22.18+ or 24+).
    const child = spawn("node", [join(dir, "src/cli.ts"), ...args], {
      cwd: dir, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let lastError = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    // Forward milestones immediately; waiting for exit hid every setup stage.
    const lines = createInterface({ input: child.stderr });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      lastError = line;
      log(line);
    });
    return await new Promise<string>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) => {
        if (code !== 0) reject(new Error(`fastgate ${args[0]} failed: ${lastError || signal || `exit ${code}`}`));
        else resolve(stdout);
      });
    });
  };
  return {
    async active() {
      // A replica still catching up with an ALTER refuses reads with "Please
      // retry this query"; it is transient, and listing is safe to repeat.
      let listed: string | undefined;
      for (let attempt = 1; listed === undefined; attempt += 1) {
        try {
          listed = await run(["list-scenarios"]);
        } catch (error) {
          if (attempt >= 5 || !/please retry/i.test((error as Error).message)) throw error;
          log(`fastgate list-scenarios: replica behind, retrying (${attempt}/4)`);
          await new Promise((wake) => setTimeout(wake, 1000 * attempt));
        }
      }
      const rows = JSON.parse(listed) as { observation_date: string; base_digest: string; scenario_digest: string; status: ActiveScenario["status"] }[];
      return rows.map((row) => ({ date: row.observation_date, baseDigest: row.base_digest, scenarioDigest: row.scenario_digest, status: row.status }));
    },
    async apply(delta) {
      await run(["ingest-scenario", delta]);
    },
    async revert(date) {
      await run(["revert-scenario", date]);
    },
  };
}
