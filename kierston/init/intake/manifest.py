"""What intake produced, from what, and which numbers it had to invent.

Every intake stage writes an entry here as it finishes. The file answers the
questions a rebuild cannot otherwise answer: which source files a product came
from and whether they have changed since, which parameters were measured on
this city and which were borrowed from Kierston, and when any of it last ran.

The borrowed-parameter record is the reason this exists rather than being a
nicety. A city fitted on nine apartment blocks and a city fitted on 367 produce
the same shaped `dwellings.json`, and without this there is nothing to tell
them apart until the population looks wrong for reasons nobody can trace.

Read-modify-write per stage, because stages are separate processes. That is
safe here — intake stages run in sequence, and each one owns its own key.
"""

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from paths import CITY, CITY_JSON, KIERSTON, INTAKE_MANIFEST, SIM_DATA


VERSION = 1

# The profile, republished as JSON beside the generated data (paths.CITY_JSON).
#
# The profile itself is TOML because a person writes it. Everything downstream
# that needs to know where the city is or what clock it keeps — the
# pathfinder's centre, the viewers, Fastgate's timestamps — is TypeScript, and
# a TOML parser in three runtimes to read a handful of values is a worse trade
# than emitting them once here. Written by the `locale` stage, publish_locale.py.


def digest(path):
    """sha256 of a file, read in chunks — the building export is 81 MB."""
    sha = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            sha.update(chunk)
    return sha.hexdigest()


def describe(path):
    """One file, as provenance: where it is, how big, and what it hashes to."""
    relative = path.relative_to(KIERSTON) if path.is_relative_to(KIERSTON) else path
    return {
        "path": str(relative),
        "bytes": path.stat().st_size,
        "sha256": digest(path),
    }


def load():
    if not INTAKE_MANIFEST.exists():
        return {"version": VERSION, "city": CITY, "stages": {}}
    manifest = json.loads(INTAKE_MANIFEST.read_text())
    # A manifest left behind by a different city is not a manifest for this
    # one. Starting over is the honest answer; merging would produce a record
    # that claims provenance it does not have.
    if manifest.get("city") != CITY or manifest.get("version") != VERSION:
        return {"version": VERSION, "city": CITY, "stages": {}}
    return manifest


def record(stage, inputs=(), outputs=(), fitted=None):
    """Note what one stage read, wrote and measured."""
    manifest = load()
    entry = {
        "ran": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "inputs": [describe(Path(path)) for path in inputs],
        "outputs": [describe(Path(path)) for path in outputs],
    }
    if fitted:
        entry["fitted"] = fitted
    manifest["stages"][stage] = entry
    SIM_DATA.mkdir(exist_ok=True)
    INTAKE_MANIFEST.write_text(json.dumps(manifest, indent=2, sort_keys=True))
    return entry


def publish_profile(profile):
    """Write the active profile where non-Python consumers can read it."""
    SIM_DATA.mkdir(parents=True, exist_ok=True)
    CITY_JSON.write_text(json.dumps({
        "name": profile.name,
        "slug": profile.slug,
        "center": list(profile.extent.center),
        "radius_m": profile.extent.radius_m,
        "jurisdiction": profile.jurisdiction,
        "microdata": {
            "dataset": profile.microdata.dataset,
            "vintage": profile.microdata.vintage,
            "state": profile.microdata.state,
            "puma": list(profile.microdata.puma),
        },
        "time_zone": profile.locale.time_zone,
    }, indent=2))


def borrowed():
    """Every parameter in the manifest that fell back to Kierston's value.

    What a `--check` wants: one list of the numbers this city did not earn.
    """
    manifest = load()
    out = []
    for stage, entry in sorted(manifest.get("stages", {}).items()):
        for group, values in (entry.get("fitted") or {}).items():
            if not isinstance(values, dict):
                continue
            for name, value in values.items():
                if isinstance(value, dict) and value.get("source") == "fallback":
                    out.append((stage, f"{group}.{name}", value))
    return out
