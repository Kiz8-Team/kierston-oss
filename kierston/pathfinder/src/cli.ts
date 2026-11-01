/**
 * Route through two or more places from the terminal.
 *
 *   bun run route "1200 Hamilton St" "Kierston Public Library"
 *   bun run route "1200 Hamilton St" "City Hall" "Kierston Public Library"
 *   bun run route "40.6030,-75.4722" "40.5900,-75.4500" --json
 */

import { Pathfinder, PathfinderError } from "./index.ts";
import { formatDistance, formatDuration } from "./units.ts";

const argv = Bun.argv.slice(2);
const json = argv.includes("--json");
const positional = argv.filter((value) => !value.startsWith("--"));

if (positional.length < 2) {
  console.error("usage: bun run route <from> [via ...] <to> [--json]");
  process.exit(2);
}

const pathfinder = await Pathfinder.open();

try {
  const plan = await pathfinder.route(positional);
  if (json) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    console.log(`from  ${plan.from.label}  (${plan.from.source}, snapped ${plan.from.snapped.metersAway} m)`);
    for (const [index, waypoint] of plan.waypoints.slice(1, -1).entries()) {
      console.log(`via ${index + 1} ${waypoint.label}  (${waypoint.source}, snapped ${waypoint.snapped.metersAway} m)`);
    }
    console.log(`to    ${plan.to.label}  (${plan.to.source}, snapped ${plan.to.snapped.metersAway} m)`);
    console.log(`route ${formatDistance(plan.distanceMeters)} · ${formatDuration(plan.durationSeconds)} · `
      + `${plan.steps.length - 1} steps`);
    console.log(`found in ${plan.stats.searchMs} ms after settling `
      + `${plan.stats.settledNodes.toLocaleString()} nodes\n`);
    for (const step of plan.steps) {
      const distance = step.distanceMeters ? formatDistance(step.distanceMeters) : "";
      console.log(`  ${step.instruction.padEnd(52)} ${distance}`);
    }
  }
} catch (error) {
  if (error instanceof PathfinderError) {
    console.error(`${error.code}: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
