"""Publish the city profile and the jurisdiction's plate rules for non-Python readers.

The profile and the jurisdiction are TOML because a person writes them.
Everything downstream that is not Python — the simulation, the pathfinder,
Fastgate, the scenario tools — reads JSON beside the generated data instead,
so this stage writes the two files they need:

    city.json          the profile's identity, extent, microdata and time zone
    plate_rules.json   what the ALPR layer needs to present and invent plates:
                       the home state, its motor vehicle agency, its
                       front-plate rule and the mix of states a car in no
                       registry is plated in

First in the pipeline and cheap, and it reads nothing another stage writes, so
`init_sim.py --only locale` refreshes both on an existing build without
touching anything else.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import jurisdiction as legal  # noqa: E402
import profile as city_profile  # noqa: E402
from intake.manifest import publish_profile  # noqa: E402
from paths import PLATE_RULES, SIM_DATA  # noqa: E402

# Bumped when the shape of plate_rules.json changes, so the simulation can
# refuse a file it would misread.
PLATE_RULES_VERSION = 1


def plate_rules(law):
    """The jurisdiction's plate rules, as the simulation's alpr.ts reads them."""
    return {
        "version": PLATE_RULES_VERSION,
        "jurisdiction": law.profile,
        "state": law.state.code,
        "issuer": law.licensing.issuer,
        "front": law.plates.front,
        "visitors": [{"jurisdiction": v.jurisdiction, "share": v.share,
                      "pattern": v.pattern} for v in law.plates.visitors],
    }


def main() -> None:
    profile = city_profile.load()
    publish_profile(profile)
    SIM_DATA.mkdir(parents=True, exist_ok=True)
    PLATE_RULES.write_text(json.dumps(plate_rules(legal.load()), indent=2) + "\n")
    print(f"city.json and {PLATE_RULES.name} for {profile.name} "
          f"({profile.locale.time_zone}, {profile.jurisdiction})")


if __name__ == "__main__":
    main()
