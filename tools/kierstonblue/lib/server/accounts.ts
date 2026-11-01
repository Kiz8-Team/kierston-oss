import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { roots } from "./repo";

/**
 * accounts.json, in aggregate.
 *
 * One resident's handles are read from identity.bin like every other personal
 * record — they are packed as a child table of the identity, and the whole
 * dossier reaches them the way it reaches a document. What is not in there is
 * the shape of the layer: adoption per platform against the shares it was
 * fitted to is a pass over a quarter of a million rows and a question about
 * the city rather than about a person, so it is answered here, once, and
 * cached against the file's mtime.
 */

/** One platform, as adopted against the share it was fitted to. */
export interface Adoption {
  channel: string;
  holders: number;
  share: number;
  /** The published adoption share the intercept was solved for, where there
   * is one. SMS and iMessage are not adopted, so they have none. */
  target: number | null;
  /** The solved intercept, so the calibration is inspectable from the page. */
  intercept: number | null;
}

export interface AccountsSummary {
  seed: number;
  referenceYear: number;
  asOf: string;
  /** People holding at least one account — everybody with a line. */
  people: number;
  accounts: number;
  conversations: number;
  adoption: Adoption[];
  /** How many people hold 1, 2, 3… accounts. Index 0 is one account. */
  held: number[];
  /** Accounts opened per calendar year, oldest first. */
  opened: { year: number; count: number }[];
  contagion: number;
}

interface AccountsFile {
  seed: number;
  reference_year: number;
  today: string;
  people: number;
  accounts: number;
  conversations: number;
  targets: Record<string, number>;
  intercepts: Record<string, number>;
  contagion: number;
  account_records: Record<string, {
    channel: string;
    handle: string;
    display_name: string;
    line: string;
    created: number;
  }[]>;
}

let cached: { path: string; mtimeMs: number; file: AccountsFile; summary?: AccountsSummary } | null = null;

async function load(): Promise<NonNullable<typeof cached>> {
  const path = join((await roots()).sim, "accounts.json");
  const info = await stat(path);
  if (!cached || cached.path !== path || cached.mtimeMs !== info.mtimeMs) {
    cached = {
      path,
      mtimeMs: info.mtimeMs,
      file: JSON.parse(await readFile(path, "utf8")) as AccountsFile,
    };
  }
  return cached;
}

/**
 * The city's accounts in aggregate.
 *
 * The denominator for adoption is everybody who holds any account at all,
 * which is everybody with a phone line — every platform here is bootstrapped
 * from a number, and the generator gives a person with no line no accounts.
 * That is the same denominator the intercept was solved against, so a share
 * here is directly comparable to the target beside it.
 */
export async function accountsSummary(): Promise<AccountsSummary> {
  const entry = await load();
  if (entry.summary) return entry.summary;
  const { file } = entry;

  const holders = new Map<string, number>();
  const opened = new Map<number, number>();
  const held: number[] = [];
  let people = 0;

  for (const rows of Object.values(file.account_records)) {
    people += 1;
    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.channel);
      const year = Math.floor(row.created / 10000);
      opened.set(year, (opened.get(year) ?? 0) + 1);
    }
    for (const channel of seen) holders.set(channel, (holders.get(channel) ?? 0) + 1);
    held[rows.length - 1] = (held[rows.length - 1] ?? 0) + 1;
  }

  const summary: AccountsSummary = {
    seed: file.seed,
    referenceYear: file.reference_year,
    asOf: file.today,
    people,
    accounts: file.accounts,
    conversations: file.conversations,
    adoption: [...holders]
      .map(([channel, count]) => ({
        channel,
        holders: count,
        share: people ? count / people : 0,
        target: file.targets[channel] ?? null,
        intercept: file.intercepts[channel] ?? null,
      }))
      .sort((a, b) => b.holders - a.holders),
    held: Array.from(held, (count) => count ?? 0),
    opened: [...opened]
      .map(([year, count]) => ({ year, count }))
      .sort((a, b) => a.year - b.year),
    contagion: file.contagion,
  };
  entry.summary = summary;
  return summary;
}
