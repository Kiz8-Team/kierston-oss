/**
 * Turning a file into a profile, whichever of the sim_data files it is.
 *
 * A profile has a kind — "init" or "day" — and only like is ever compared with
 * like. Everything else is worked out from the magic bytes, so `iceberg` takes
 * a path and no flags: sim_init.bin fans out into its sections, a lone
 * vehicles.bin profiles just that, and a day file finds the population it was
 * planned against so its mode splits can be read by age.
 *
 * That last join is why `init` is threaded through here. A day file names the
 * digest of the init it came from, and iceberg looks for that init beside it.
 * If the digests disagree the join is refused rather than made wrongly — a
 * mode share by age band computed against a city that has since been rebuilt
 * is worse than not having one, because it looks exactly as trustworthy.
 */

import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { openFile, sections, type Envelope } from "../format.ts";
import { Builder, type Profile } from "../metrics.ts";
import { Population } from "../population.ts";
import { RecordSet } from "../tables.ts";
import { analyseDay } from "./day.ts";
import { analysePopulation } from "./population.ts";
import { analyseRecords } from "./records.ts";
import { analyseTies } from "./ties.ts";

export interface ProfileOptions {
  /** A sim_init.bin to join a day file against, if not the one beside it. */
  init?: string;
  /** Profile a day file even when its digest names a different population. */
  force?: boolean;
  note?: (message: string) => void;
}

export function profileFile(path: string, options: ProfileOptions = {}): Profile {
  const env = openFile(path);
  const source = basename(path);
  switch (env.magic) {
    case "KSIM": return profileInit(env, source, options);
    case "KDAY": return profileDay(env, path, source, options);
    case "KPOP": {
      const b = new Builder();
      const pop = new Population(env);
      stamp(b, env);
      analysePopulation(b, pop);
      return b.profile("init", source);
    }
    case "KREC": {
      const b = new Builder();
      stamp(b, env);
      analyseRecords(b, new RecordSet(env), loadInit(options.init, options.note));
      return b.profile("init", source);
    }
    case "KTIE": {
      const b = new Builder();
      stamp(b, env);
      analyseTies(b, env, loadInit(options.init, options.note));
      return b.profile("init", source);
    }
    default:
      throw new Error(`${source}: iceberg does not read "${env.magic}" files`);
  }
}

function profileInit(env: Envelope, source: string, options: ProfileOptions): Profile {
  const b = new Builder();
  stamp(b, env);
  const parts = sections(env);
  b.scalar("container.sections", parts.length);
  b.scalar("container.bytes", env.meta.byteLength ?? env.bytes.byteLength);

  const populationPart = parts.find((part) => part.magic === "KPOP");
  const pop = populationPart ? new Population(populationPart.env) : null;
  if (pop) analysePopulation(b, pop);
  else options.note?.("no population section; skipping population joins");

  const records = new Map<string, RecordSet>();
  for (const part of parts) {
    b.scalar(`container.section.${part.name}.bytes`, part.env.bytes.byteLength);
    if (part.magic === "KREC") {
      const set = new RecordSet(part.env);
      records.set(set.dataset, set);
      analyseRecords(b, set, pop);
    } else if (part.magic === "KTIE") {
      analyseTies(b, part.env, pop);
    }
  }
  if (pop) identityAgainstPopulation(b, records.get("identity"), pop);
  return b.profile("init", source);
}

function profileDay(env: Envelope, path: string, source: string, options: ProfileOptions): Profile {
  const b = new Builder();
  stamp(b, env);
  const initPath = options.init ?? beside(path);
  let pop: Population | null = null;
  if (initPath) {
    const init = openFile(initPath);
    const digest = init.meta.digest;
    if (digest && env.meta.initDigest && digest !== env.meta.initDigest && !options.force) {
      options.note?.(
        `${basename(initPath)} is population ${digest}, ${source} was planned against ` +
        `${env.meta.initDigest}; skipping demographic joins (--force to override)`,
      );
    } else if (init.magic === "KPOP") {
      pop = new Population(init);
    } else {
      const part = sections(init).find((section) => section.magic === "KPOP");
      if (part) pop = new Population(part.env);
      else options.note?.(`${basename(initPath)} has no population section; skipping demographic joins`);
    }
  } else {
    options.note?.("no sim_init.bin beside the day file; skipping demographic joins");
  }
  analyseDay(b, env, pop);
  return b.profile("day", source);
}

/** The init file next to a day file, which is where the packer puts it. */
function beside(path: string): string | null {
  const candidate = join(dirname(path), "sim_init.bin");
  return existsSync(candidate) ? candidate : null;
}

function loadInit(path: string | undefined, note?: (message: string) => void): Population | null {
  if (!path) {
    note?.("no --init given; skipping population joins");
    return null;
  }
  const env = openFile(path);
  if (env.magic === "KPOP") return new Population(env);
  const part = sections(env).find((section) => section.magic === "KPOP");
  if (!part) throw new Error(`${path} has no population section`);
  return new Population(part.env);
}

/** Whatever the file says about how it was made, kept beside the numbers. */
function stamp(b: Builder, env: Envelope): void {
  for (const key of ["seed", "placementSeed", "digest", "builtAt", "date", "day", "initDigest", "dataset", "referenceYear", "version"]) {
    if (env.meta[key] !== undefined) b.provenance[key] = env.meta[key];
  }
  b.provenance.magic = env.magic;
}

/**
 * The one join between two record files worth making by hand.
 *
 * identity.bin holds one row per resident in resident order, and each row
 * carries a birth date the population's age column knows nothing about. Two
 * generators, one fact — so if the ages were resampled and the identities were
 * not, every downstream date check would keep passing while every person in
 * the city quietly aged a year away from their own birthday.
 */
function identityAgainstPopulation(b: Builder, identity: RecordSet | undefined, pop: Population): void {
  const table = identity?.table("identity");
  const field = table?.field("birth_date");
  if (!table || !field || table.rows !== pop.residents) return;

  const reference = identity!.meta.today
    ? Number(String(identity!.meta.today).slice(0, 4))
    : identity!.meta.referenceYear;
  let mismatched = 0;
  let missing = 0;
  const examples: string[] = [];
  for (let id = 0; id < pop.residents; id += 1) {
    const ordinal = field.column[id];
    if (!ordinal) { missing += 1; continue; }
    const born = Math.floor(ordinal / 10000);
    const age = pop.age(id);
    // A birthday either side of the reference date makes one year of slack
    // legitimate; two is a generator disagreeing with another generator.
    if (Math.abs(reference - born - age) > 1) {
      mismatched += 1;
      if (examples.length < 5) examples.push(`resident ${id}: born ${born}, population age ${age}`);
    }
  }
  b.invariant("records.identity.identity.birth_date.matchesAge", "a birth date agrees with the population's age", mismatched, pop.residents, examples);
  b.countAndShare("records.identity.identity.birth_date.absent", missing, pop.residents);
}
