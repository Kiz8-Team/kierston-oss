"""The file that marks a folder as a city build: `kierston-city.json`.

A city build is a directory of init outputs — what `init_sim.py` writes,
`kierston/sim_data/` by default or wherever `--out` put it. Nothing else in the
folder says what it is: city.json names the city but not the build, and the
seeds are scattered across a dozen outputs. The manifest gathers the few facts
needed to recognise a build and to reproduce it:

    format, version   "kierston-city", 1 — what to check before trusting the rest
    city, name        the profile slug (KIERSTON_CITY) and its display name
    seed              the --seed the build ran with; null means each stage's
                      own default
    populationSeed    the seed population.json records, which is the one
                      `bun run day` draws from unless given --seed
    households        the --households override, or null
    days              where this build's KDAY files go, relative to the folder
    commit, dirty     the engine that built it
    builtAt           when the last stage finished
    stages            per stage, when it last ran and how long it took

It is rewritten after every run rather than only after a full one, so a
`--from` or `--only` run updates the stages it touched and keeps the rest.
`seed` and `households` describe the latest run.

`days` is "../sim_outputs" for the default build, which is where day files
have always gone, and "days" for any other: a build made with --out keeps its
days inside itself, so the folder is the whole unit.
"""

import json
import re
import subprocess
from datetime import datetime, timezone

from paths import CITY, CITY_MANIFEST, KIERSTON, SIM_DATA

FORMAT = "kierston-city"
VERSION = 1


def _git(*args):
    try:
        return subprocess.run(["git", *args], cwd=KIERSTON, capture_output=True,
                              text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def _population_seed():
    """The seed population.json opens with, without parsing 50 MB for it."""
    path = SIM_DATA / "population.json"
    if not path.exists():
        return None
    with path.open("rb") as handle:
        head = handle.read(4096).decode("utf-8", "replace")
    match = re.search(r'"seed"\s*:\s*(-?\d+)', head)
    return int(match.group(1)) if match else None


def _name():
    try:
        return json.loads((SIM_DATA / "city.json").read_text())["name"]
    except (OSError, ValueError, KeyError):
        return None


def load():
    """The manifest as it stands, or None when the folder has none."""
    try:
        manifest = json.loads(CITY_MANIFEST.read_text())
    except (OSError, ValueError):
        return None
    if manifest.get("format") != FORMAT or manifest.get("version") != VERSION:
        return None
    return manifest


def write(seed, households, timings):
    """Record a run. `timings` is [(stage, seconds)] for the stages it ran."""
    previous = load() or {}
    if previous.get("city") not in (None, CITY):
        raise SystemExit(f"{SIM_DATA} is a build of {previous['city']}, not {CITY}")
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    stages = dict(previous.get("stages", {}))
    for name, seconds in timings:
        stages[name] = {"ranAt": now, "seconds": round(seconds, 1)}
    default = SIM_DATA == (KIERSTON / "sim_data").resolve()
    manifest = {
        "format": FORMAT,
        "version": VERSION,
        "city": CITY,
        "name": _name(),
        "seed": seed,
        "populationSeed": _population_seed(),
        "households": households,
        "days": previous.get("days", "../sim_outputs" if default else "days"),
        "commit": _git("rev-parse", "--short", "HEAD"),
        "dirty": bool(_git("status", "--porcelain", "--", ".")),
        "builtAt": now,
        "stages": stages,
    }
    CITY_MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest

