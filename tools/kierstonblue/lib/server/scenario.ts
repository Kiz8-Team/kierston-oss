/**
 * A scenario, assembled from the three files that describe it.
 *
 * The delta says what bytes moved, the base says what they moved from, and the
 * materialized day — when one has been merged — says what they moved to. Only
 * the first is required. A `.kdiff` alone still answers the questions worth
 * asking about a scenario: what it bound, what it did, who it touched, and
 * what that cost to store. The before-and-after needs the merged day, and the
 * console says so rather than quietly showing half a comparison.
 *
 * Nothing here writes. Materializing a delta is `bun run scenarios merge`, a
 * twenty-second job that lands most of a gigabyte on disk, and a viewer that
 * did it on a page load would be making that decision on the reader's behalf.
 */

import { stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";

import { REPO_ROOT, roots } from "./repo";
import { readMeta, type DayMeta, type ScenarioTruth } from "./kday";
import {
  fileDigest,
  listDeltaFiles,
  readKdif,
  scenarioTruthFromDelta,
  type KdifManifest,
} from "./kdif";
import { readPersonDayAt, type PersonDay } from "./day";

export interface ScenarioStorage {
  /** Bytes of the `.kdiff` on disk, gzip included. */
  deltaBytes: number;
  /** Bytes of the base it patches, or null when the base is missing. */
  baseBytes: number | null;
  /** How many times smaller the delta is than the base day. */
  ratio: number | null;
  /** Columns the KDAY has, against the count this delta touches. */
  columnsChanged: number;
  columnsTotal: number | null;
}

export interface ScenarioSummary {
  /** The delta's filename without its extension: the id used in every route. */
  slug: string;
  /** The date the base day covers, which a scenario cannot change. */
  date: string;
  baseHash: string;
  deltaBytes: number;
  modifiedAt: string;
  /** From the scenario's own truth block, where the base could be read. */
  name: string | null;
  seed: number | null;
  actions: number | null;
  affected: number | null;
  columnsChanged: number;
  /** The base day this binds to, if it is on disk and its digest matches. */
  base: { path: string; date: string; matches: boolean } | null;
  /** A merged day beside the delta, if one has been written. */
  materialized: { path: string; bytes: number; modifiedAt: string } | null;
  /** Why this row could not be fully read, where it could not. */
  error: string | null;
}

/**
 * One person's day counted twice: as the base has it and as the scenario does.
 *
 * Counts rather than contents, because this is the roster the reader picks
 * from. The rows themselves come one person at a time — a full comparison
 * pulls two ledgers, two span tables and two event tables, and doing that for
 * everyone up front to draw a list of names would read the largest tables in
 * both files to answer a question nobody asked yet.
 */
export interface AffectedSummary {
  person: number;
  reasons: string[];
  counts: {
    schedule: [number, number];
    legs: [number, number];
    transactions: [number, number];
    spans: [number, number];
    events: [number, number];
  } | null;
}

export interface ScenarioDetail extends ScenarioSummary {
  truth: ScenarioTruth | null;
  storage: ScenarioStorage;
  affectedPeople: AffectedSummary[];
}

/** Both sides of one person's day, for the comparison view. */
export interface ScenarioPersonDiff {
  person: number;
  reasons: string[];
  base: PersonDay | null;
  scenario: PersonDay | null;
}

const slugOf = (path: string) => basename(path).replace(/\.kdiff$/, "");

/**
 * Paths cross to the client as repo-relative, which is both less to leak and
 * more useful: every command the console prints is run from the repo root, so
 * a relative path can be pasted into one.
 */
const shown = (path: string) => relative(REPO_ROOT, path);

/** The merged day as the client sees it: relative path, size, when. */
const shownDay = (day: { path: string; bytes: number; modifiedAt: string } | null) =>
  (day ? { ...day, path: shown(day.path) } : null);

/**
 * The merged day for a delta, by the convention the CLI's own examples use:
 * the same name with `.bin` in place of `.kdiff`. Guessing at a filename is
 * not ideal, but the delta records no output path — it cannot, since the same
 * delta can be merged anywhere — and this is the name the README materializes.
 */
async function materializedFor(deltaPath: string) {
  const path = deltaPath.replace(/\.kdiff$/, ".bin");
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return null;
  return { path, bytes: info.size, modifiedAt: info.mtime.toISOString() };
}

/**
 * The base day a delta binds to.
 *
 * Found by date first and confirmed by digest, never the other way round:
 * hashing every day in the directory to find one match would read gigabytes to
 * answer a question the manifest's own `date` field already narrows to a
 * single file. A base whose date matches but whose digest does not is reported
 * as a mismatch rather than silently used — that is a re-exported day, and
 * every row id in the delta now points somewhere else.
 */
async function baseFor(manifest: KdifManifest, deep: boolean) {
  const path = join((await roots()).outputs, `day_${manifest.date}.bin`);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return null;
  const matches = deep ? (await fileDigest(path)) === manifest.baseHash : true;
  return { path, date: manifest.date, matches, bytes: info.size };
}

export async function listScenarios(): Promise<ScenarioSummary[]> {
  const paths = await listDeltaFiles();
  const rows = await Promise.all(paths.map(async (path): Promise<ScenarioSummary> => {
    const info = await stat(path);
    const shell = {
      slug: slugOf(path),
      deltaBytes: info.size,
      modifiedAt: info.mtime.toISOString(),
    };
    try {
      const manifest = await readKdif(path);
      const base = await baseFor(manifest, false);
      const materialized = await materializedFor(path);
      // The truth block needs the base header, so a missing base costs the
      // name and the seed but not the row: the delta is still a real file
      // with a real size and a base it is waiting for.
      const truth = base
        ? await scenarioTruthFromDelta(base.path, manifest).catch(() => null)
        : null;
      return {
        ...shell,
        date: manifest.date,
        baseHash: manifest.baseHash,
        name: truth?.name ?? null,
        seed: truth?.seed ?? null,
        actions: truth?.actions.length ?? null,
        affected: truth?.affected.length ?? null,
        columnsChanged: manifest.columns.length,
        base: base ? { path: shown(base.path), date: base.date, matches: base.matches } : null,
        materialized: shownDay(materialized),
        error: null,
      };
    } catch (error) {
      return {
        ...shell,
        date: "",
        baseHash: "",
        name: null,
        seed: null,
        actions: null,
        affected: null,
        columnsChanged: 0,
        base: null,
        materialized: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));
  return rows.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

async function deltaPathFor(slug: string): Promise<string | null> {
  if (!/^[A-Za-z0-9._-]+$/.test(slug) || slug.includes("..")) return null;
  const path = join((await roots()).outputs, `${slug}.kdiff`);
  const info = await stat(path).catch(() => null);
  return info?.isFile() ? path : null;
}

export async function readScenario(slug: string): Promise<ScenarioDetail | null> {
  const path = await deltaPathFor(slug);
  if (!path) return null;

  const info = await stat(path);
  const manifest = await readKdif(path);
  // The detail view is where the digest is worth paying for: this is the page
  // that claims the delta and the base belong together.
  const base = await baseFor(manifest, true);
  const materialized = await materializedFor(path);
  const truth = base && base.matches
    ? await scenarioTruthFromDelta(base.path, manifest).catch(() => null)
    : null;

  let baseMeta: DayMeta | null = null;
  if (base) baseMeta = await readMeta(base.path).then(({ meta }) => meta).catch(() => null);

  const affectedPeople = await Promise.all(
    (truth?.affected ?? []).map(async (entry): Promise<AffectedSummary> => {
      if (!materialized || !base?.matches) {
        return { person: entry.person, reasons: entry.reasons, counts: null };
      }
      const [before, after] = await Promise.all([
        readPersonDayAt(base.path, entry.person).catch(() => null),
        readPersonDayAt(materialized.path, entry.person).catch(() => null),
      ]);
      const pair = (a: number | undefined, b: number | undefined): [number, number] =>
        [a ?? 0, b ?? 0];
      return {
        person: entry.person,
        reasons: entry.reasons,
        counts: {
          schedule: pair(before?.schedule.length, after?.schedule.length),
          legs: pair(before?.legs.length, after?.legs.length),
          transactions: pair(before?.transactions.length, after?.transactions.length),
          spans: pair(before?.radio.spans.length, after?.radio.spans.length),
          events: pair(before?.radio.events.length, after?.radio.events.length),
        },
      };
    }),
  );

  return {
    slug,
    date: manifest.date,
    baseHash: manifest.baseHash,
    deltaBytes: info.size,
    modifiedAt: info.mtime.toISOString(),
    name: truth?.name ?? null,
    seed: truth?.seed ?? null,
    actions: truth?.actions.length ?? null,
    affected: truth?.affected.length ?? null,
    columnsChanged: manifest.columns.length,
    base: base ? { path: shown(base.path), date: base.date, matches: base.matches } : null,
    materialized: shownDay(materialized),
    error: null,
    truth,
    storage: {
      deltaBytes: info.size,
      baseBytes: base?.bytes ?? null,
      ratio: base?.bytes ? base.bytes / info.size : null,
      columnsChanged: manifest.columns.length,
      columnsTotal: baseMeta?.columns.length ?? null,
    },
    affectedPeople,
  };
}

export async function readScenarioPerson(
  slug: string,
  person: number,
): Promise<ScenarioPersonDiff | null> {
  const path = await deltaPathFor(slug);
  if (!path || !Number.isSafeInteger(person) || person < 0) return null;

  const manifest = await readKdif(path);
  const base = await baseFor(manifest, true);
  const materialized = await materializedFor(path);
  if (!base?.matches) return null;

  const truth = await scenarioTruthFromDelta(base.path, manifest).catch(() => null);
  const [before, after] = await Promise.all([
    readPersonDayAt(base.path, person),
    materialized ? readPersonDayAt(materialized.path, person) : Promise.resolve(null),
  ]);
  return {
    person,
    reasons: truth?.affected.find((entry) => entry.person === person)?.reasons ?? [],
    base: before,
    scenario: after,
  };
}
