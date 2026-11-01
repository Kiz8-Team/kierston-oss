#!/usr/bin/env bun
/**
 * iceberg — record what a simulated city looks like, then say what changed.
 *
 * The workflow it is built around is one loop: profile the binaries you trust,
 * keep that as the baseline, change some code, regenerate, and check the new
 * binaries against it. Everything else here is in service of that being two
 * commands with no arguments to remember.
 *
 *     iceberg baseline kierston/sim_data/sim_init.bin kierston/sim_outputs/day_*.bin
 *     iceberg check    kierston/sim_data/sim_init.bin kierston/sim_outputs/day_*.bin
 *
 * Baselines are named by kind, so an init file checks against the init
 * baseline and a day file against the day one without either being said. Give
 * `--name` to keep more than one — a branch, a seed, a scenario.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { diff } from "./diff.ts";
import type { Profile } from "./metrics.ts";
import { profileFile } from "./profile/index.ts";
import { markdownDiff, reportDiff, reportProfile } from "./report.ts";
import { schedulerSuites } from "./scheduler-suites.ts";
import { runSuite } from "./suites.ts";

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));

const USAGE = `iceberg — invariant detection over sim_data binaries

  iceberg profile  <file.bin>...        print a file's profile
  iceberg baseline <file.bin>...        save a file's profile as the baseline
  iceberg check    <file.bin>...        compare a file against its baseline
  iceberg diff     <a> <b>              compare two files or two saved profiles
  iceberg list                          list saved baselines
  iceberg test [suite|all]              run statistical suites

files      sim_init.bin, day_*.bin, or any of population.bin, vehicles.bin,
           holdings.bin, firearms.bin, identity.bin, criminal.bin, civil.bin,
           ties.bin

  --name <n>       baseline to write or read (default: the file's kind)
  --init <path>    the sim_init.bin to join a day file against
  --store <dir>    where baselines live (default: tools/iceberg/baselines)
  --out <path>     also write the profile, or the diff, as JSON
  --markdown <p>   write the diff as markdown
  --top <n|all>    findings to print (default 40)
  --threshold <n>  hide findings scoring below this (default 1)
  --force          profile a day file against a mismatched population
  --json           print JSON instead of a report
  --update         update committed statistical expectations (test only)
`;

interface Options {
  name?: string;
  init?: string;
  store: string;
  out?: string;
  markdown?: string;
  top: number | "all";
  threshold: number;
  force: boolean;
  json: boolean;
  update: boolean;
}

function parse(argv: string[]): { command: string; files: string[]; options: Options } {
  const files: string[] = [];
  const options: Options = {
    store: process.env.ICEBERG_STORE ?? join(HERE, "baselines"),
    top: 40,
    threshold: 1,
    force: false,
    json: false,
    update: false,
  };
  let command = argv[0] ?? "help";
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--name": options.name = argv[++i]; break;
      case "--init": options.init = argv[++i]; break;
      case "--store": options.store = argv[++i]; break;
      case "--out": options.out = argv[++i]; break;
      case "--markdown": options.markdown = argv[++i]; break;
      case "--top": {
        const value = argv[++i];
        options.top = value === "all" ? "all" : Number(value);
        break;
      }
      case "--threshold": options.threshold = Number(argv[++i]); break;
      case "--force": options.force = true; break;
      case "--json": options.json = true; break;
      case "--update": options.update = true; break;
      case "-h": case "--help": command = "help"; break;
      default:
        if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
        files.push(arg);
    }
  }
  return { command, files, options };
}

const note = (message: string) => process.stderr.write(`  note: ${message}\n`);

function measure(path: string, options: Options): Profile {
  if (!existsSync(path)) throw new Error(`${path} does not exist`);
  const started = Date.now();
  process.stderr.write(`  reading ${basename(path)} (${(statSync(path).size / 1e6).toFixed(0)} MB)…\n`);
  const profile = profileFile(path, { init: options.init, force: options.force, note });
  process.stderr.write(
    `  ${Object.keys(profile.metrics).length.toLocaleString()} metrics in ${((Date.now() - started) / 1000).toFixed(1)}s\n`,
  );
  return profile;
}

/** A saved profile, or a binary measured into one. */
function load(path: string, options: Options): Profile {
  if (path.endsWith(".json")) {
    const profile = JSON.parse(readFileSync(path, "utf8")) as Profile;
    if (profile.iceberg !== 1) throw new Error(`${path} is not an iceberg profile`);
    return profile;
  }
  return measure(path, options);
}

const slot = (store: string, name: string) => join(store, `${name}.json`);

function save(store: string, name: string, profile: Profile): string {
  mkdirSync(store, { recursive: true });
  const path = slot(store, name);
  writeFileSync(path, `${JSON.stringify(profile, null, 1)}\n`);
  return path;
}

async function main(argv: string[]): Promise<number> {
  const { command, files, options } = parse(argv);

  switch (command) {
    case "help":
      process.stdout.write(USAGE);
      return 0;

    case "list": {
      if (!existsSync(options.store)) {
        process.stdout.write(`no baselines: ${options.store} does not exist\n`);
        return 0;
      }
      const names = readdirSync(options.store).filter((file) => file.endsWith(".json"));
      if (!names.length) process.stdout.write("no baselines\n");
      for (const file of names.sort()) {
        const profile = JSON.parse(readFileSync(join(options.store, file), "utf8")) as Profile;
        process.stdout.write(
          `${file.replace(/\.json$/, "").padEnd(16)} ${profile.kind.padEnd(6)} ${profile.source.padEnd(24)} ` +
          `${profile.recordedAt.slice(0, 19).replace("T", " ")}  ${Object.keys(profile.metrics).length.toLocaleString()} metrics\n`,
        );
      }
      return 0;
    }

    case "test": {
      const available = schedulerSuites();
      const wanted = files.length && !files.includes("all") ? new Set(files) : null;
      const selected = wanted ? available.filter((suite) => wanted.has(suite.name)) : available;
      if (wanted) {
        const missing = [...wanted].filter((name) => !available.some((suite) => suite.name === name));
        if (missing.length) throw new Error(`unknown suite${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);
      }
      const expectationDir = join(HERE, "expectations");
      let failed = false;
      for (const suite of selected) {
        const result = await runSuite(suite, expectationDir, options.update);
        if (result.updated) {
          process.stdout.write(`  updated ${suite.name}\n`);
          continue;
        }
        process.stdout.write(`\n${suite.name}: ${result.failures.length ? "FAIL" : "pass"}\n`);
        for (const failure of result.failures) process.stdout.write(`  ! ${failure}\n`);
        const review = result.findings.filter((finding) => finding.score >= options.threshold).slice(0, options.top === "all" ? undefined : options.top);
        for (const finding of review) process.stdout.write(`  ~ ${finding.path}: ${finding.headline}\n`);
        failed ||= result.failures.length > 0;
      }
      return failed ? 2 : 0;
    }

    case "profile": {
      if (!files.length) throw new Error("profile needs a file");
      for (const file of files) {
        const profile = measure(file, options);
        if (options.out) {
          writeFileSync(options.out, `${JSON.stringify(profile, null, 1)}\n`);
          process.stderr.write(`  wrote ${options.out}\n`);
        }
        process.stdout.write(options.json ? `${JSON.stringify(profile)}\n` : reportProfile(profile));
      }
      return 0;
    }

    case "baseline": {
      if (!files.length) throw new Error("baseline needs a file");
      for (const file of files) {
        const profile = measure(file, options);
        const path = save(options.store, options.name ?? profile.kind, profile);
        process.stdout.write(`  baseline ${basename(path)} ← ${profile.source}\n`);
      }
      return 0;
    }

    case "check": {
      if (!files.length) throw new Error("check needs a file");
      let worst = 0;
      for (const file of files) {
        const candidate = measure(file, options);
        const name = options.name ?? candidate.kind;
        const path = slot(options.store, name);
        if (!existsSync(path)) {
          process.stderr.write(`  no baseline "${name}"; record one with: iceberg baseline ${file}\n`);
          process.stdout.write(reportProfile(candidate));
          worst = Math.max(worst, 1);
          continue;
        }
        worst = Math.max(worst, emit(JSON.parse(readFileSync(path, "utf8")), candidate, options));
      }
      return worst;
    }

    case "diff": {
      if (files.length !== 2) throw new Error("diff needs two files");
      return emit(load(files[0], options), load(files[1], options), options);
    }

    default:
      throw new Error(`unknown command "${command}"; see iceberg help`);
  }
}

/**
 * Print one comparison, and say in the exit code whether it needs looking at.
 *
 *     0   nothing moved past the threshold
 *     1   something did
 *     2   a rule is broken in the candidate that held in the baseline
 *
 * so a check can sit in a script without anything parsing the report.
 */
function emit(baseline: Profile, candidate: Profile, options: Options): number {
  if (baseline.kind !== candidate.kind) {
    throw new Error(`${baseline.source} is a ${baseline.kind} profile and ${candidate.source} is a ${candidate.kind} one`);
  }
  const result = diff(baseline, candidate);
  const view = { threshold: options.threshold, top: options.top };
  if (options.out) writeFileSync(options.out, `${JSON.stringify(result.findings, null, 1)}\n`);
  if (options.markdown) writeFileSync(options.markdown, markdownDiff(result, view));
  process.stdout.write(options.json ? `${JSON.stringify(result.findings)}\n` : reportDiff(result, view));

  const broke = result.findings.some(
    (finding) => finding.class === "invariant" && finding.headline.startsWith("now broken"),
  );
  if (broke) return 2;
  return result.findings.some((finding) => finding.score >= options.threshold) ? 1 : 0;
}

try {
  process.exit(await main(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(`iceberg: ${(error as Error).message}\n`);
  process.exit(3);
}
