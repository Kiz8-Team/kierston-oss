/**
 * What one worker would have to hold.
 *
 * Parallelising the export means N processes each loading the city, so the
 * question that decides how many is not how fast a stage is but how big it is.
 * This prints the resident set after each load, in the order a worker would do
 * them, so the answer is a table rather than a guess.
 */
import { Bank, Bills } from "../src/economy/index.ts";
import { Network } from "../src/network/index.ts";
import { loadDayContext } from "../src/engine/index.ts";

function rss(): number {
  return process.memoryUsage.rss() / 1e6;
}

let last = rss();
function mark(what: string): void {
  const now = rss();
  console.log(`  ${what.padEnd(22)} ${(now - last).toFixed(0).padStart(6)} MB   ${now.toFixed(0).padStart(6)} MB total`);
  last = now;
}

mark("baseline");
const context = await loadDayContext();
mark("city context");
context.network = await Network.open();
mark("network");
context.bank = Bank.load();
mark("bank");
context.bills = Bills.load();
mark("bills");
console.log(`\n  heap ${(process.memoryUsage().heapUsed / 1e6).toFixed(0)} MB, rss ${rss().toFixed(0)} MB`);
