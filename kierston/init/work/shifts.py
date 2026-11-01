"""Set depart/arrive times and weekly hours for rostered roles from their watch.

A PUMS record's JWDP/JWAP are a survey answer about the week the respondent was
asked, and for a shift worker they describe whichever rotation that week
happened to land on. Cloning them onto a synthetic officer and then assigning
that officer to a watch produces the contradiction the roster stage otherwise
ships: 68 evening-platoon officers whose median departure is 07:00, and 50 on
nights leaving at 07:45. The two fields disagree because nothing ever made them
agree.

So the roster wins. For `class: primary` a watch is an assignment, not a
preference — the shift decides when the person leaves the house, and `depart`
and `arrive` are rewritten from it. What survives from PUMS is `travel`: how
long this person's commute takes is a fact about where they live and how they
get there, and the watch has no opinion on it.

    depart  =  shift start - report time - travel
    arrive  =  shift start - report time

Taxi drivers are the exception, and `init_work.ESTABLISHMENT` already says why:
a cab platoon is a habitual pattern rather than a rota, so their start is drawn
around the habit with an hour of spread and their weekly hours stay whatever
the survey said. Police and EMS get the roster's hours instead, because a
24-hour rotation is not a 40-hour week and leaving WKHP at 40 would leave the
record describing a job the person does not hold.

Run standalone to see what would change, or to apply it to an already-built
sim_data without re-running recruitment:

    python shifts.py              report only
    python shifts.py --write      rewrite employment.json and population.json
"""

import argparse
import json
import random
from collections import Counter, defaultdict
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from paths import SIM_DATA  # noqa: E402
POPULATION = SIM_DATA / "population.json"
EMPLOYMENT = SIM_DATA / "employment.json"

DEFAULT_SEED = 20260731

# Minutes from midnight. A shift that ends past 1440 has run into the next day,
# which is the normal case for nights and the whole point of a 24-hour tour;
# the runtime keeps them unwrapped so a block's end is always after its start.
HOUR = 60

# Watch definitions per role.
#
#   start    when the shift itself begins
#   length   how long it runs, in minutes
#   report   how early the person is expected on site — roll call for police,
#            the truck check for a medic, nothing at all for a cab
#   spread   jitter on the start, for roles that self-schedule
#
# Police run three eight-hour watches. The reference city's sworn schedule is a 5-2
# with the rest days moving through the week, so the rota is anchored per
# person rather than per platoon: every watch keeps about five sevenths of its
# strength on any given day, which is what a watch is for.
#
# EMS runs the standard 24/48. Three platoons, one on at a time, anchored to
# the platoon so that a/b/c tile the calendar exactly and the city always has
# exactly one shift of ambulances on the road.
SHIFTS = {
    "police_officer": {
        "watches": {
            "day":     {"start": 7 * HOUR,  "length": 8 * HOUR},
            "evening": {"start": 15 * HOUR, "length": 8 * HOUR},
            "night":   {"start": 23 * HOUR, "length": 8 * HOUR},
        },
        "report": 15,
        "rota": {"kind": "person", "on": 5, "off": 2},
        # A floor, not a figure. Five eights is the schedule; the overtime a
        # PUMS record reports on top of it is real — court appearances, held-
        # over jobs, details — and flattening 52 hours to 40 would delete it.
        "weekly_hours": 40,
        "hours_rule": "floor",
    },
    "paramedic": {
        "watches": {
            "a": {"start": 7 * HOUR, "length": 24 * HOUR},
            "b": {"start": 7 * HOUR, "length": 24 * HOUR},
            "c": {"start": 7 * HOUR, "length": 24 * HOUR},
        },
        "report": 15,
        "rota": {"kind": "platoon", "on": 1, "off": 2},
        # 24 on, 48 off is 2⅓ tours a week: 56 hours, not 40.
        "weekly_hours": 56,
        "hours_rule": "exact",
    },
    "emt": {
        "watches": {
            "a": {"start": 7 * HOUR, "length": 24 * HOUR},
            "b": {"start": 7 * HOUR, "length": 24 * HOUR},
            "c": {"start": 7 * HOUR, "length": 24 * HOUR},
        },
        "report": 15,
        "rota": {"kind": "platoon", "on": 1, "off": 2},
        "weekly_hours": 56,
        "hours_rule": "exact",
    },
    "taxi_driver": {
        "watches": {
            # A habit, not a rota — hence the spread, and hence no fixed
            # length: a driver works the hours they work, and WKHP is the only
            # evidence of how many that is.
            "day":     {"start": 6 * HOUR + 30, "length": None, "spread": 60},
            "evening": {"start": 15 * HOUR,     "length": None, "spread": 75},
            "night":   {"start": 21 * HOUR,     "length": None, "spread": 60},
        },
        "report": 0,
        "rota": {"kind": "person", "on": None, "off": None},
        "weekly_hours": None,
        "hours_rule": None,
    },
}

# A bureau has no night watch of its own. Investigations is a day assignment
# with an on-call rotation on top of it, and the establishment split — which
# divides every facility across three watches without asking what the facility
# is — puts detectives on nights purely as an artefact of that division.
# Moving them is visible in the report and reversible by emptying this set.
DAY_ONLY_DUTIES = {"investigations"}
DAY_WATCH = {"police_officer": "day"}

# Rest days for a 5-2. Patrol covers every day of the week, so a patrol
# officer's pair of rest days walks the calendar; anyone on a day-only duty
# keeps the weekend the rest of the working world does, most of the time.
WEEKEND = (5, 6)


def watch_of(entry):
    """The watch this assignment actually works, after duty overrides."""
    platoon = entry["platoon"]
    if entry.get("duty") in DAY_ONLY_DUTIES:
        return DAY_WATCH.get(entry["role"], platoon)
    return platoon


def rest_days(entry, rota, rng):
    """Two consecutive weekdays off, or None where the rota is by platoon."""
    if rota["kind"] != "person" or rota["on"] is None:
        return None
    if entry.get("duty") in DAY_ONLY_DUTIES:
        # Mostly the weekend, but a bureau still answers the phone on Saturday.
        if rng.random() < 0.75:
            return list(WEEKEND)
    first = rng.randrange(7)
    return sorted({first, (first + 1) % 7})


def taxi_pattern(person, rng):
    """Days worked and shift length for a self-scheduling driver.

    WKHP is the constraint and the only measured thing here. A driver on 25
    hours is not working five five-hour days; they are working three or four
    longer ones, because a cab has to be collected and returned and the fixed
    cost of a shift is paid once. So days are drawn from the hours, and the
    length falls out of the division.
    """
    hours = person.get("hours") or 40
    if hours <= 20:
        days = rng.choice((3, 3, 4))
    elif hours <= 34:
        days = rng.choice((4, 4, 5))
    elif hours <= 45:
        days = rng.choice((5, 5, 6))
    else:
        days = rng.choice((6, 6, 7))
    length = round(hours * 60 / days / 15) * 15
    return days, max(3 * HOUR, min(12 * HOUR, length))


def schedule(entry, person, seed):
    """The shift record for one assignment, and the depart/arrive it implies.

    Returns `(shift, depart, arrive, hours)`. `depart` and `arrive` are minutes
    from midnight and wrap; the shift's own `start` and `end` do not, so a
    night watch ends at 1860 and a 24-hour tour at 2340.
    """
    role = SHIFTS[entry["role"]]
    rng = random.Random(seed ^ (entry["person"] * 2654435761))
    watch = watch_of(entry)
    spec = role["watches"][watch]

    start = spec["start"]
    if spec.get("spread"):
        start += round(rng.gauss(0, spec["spread"] / 2) / 5) * 5

    if entry["role"] == "taxi_driver":
        days, length = taxi_pattern(person, rng)
        rota = {"kind": "days", "days": days}
        hours = person.get("hours")
    else:
        length = spec["length"]
        rota = dict(role["rota"])
        if rota["kind"] == "person":
            rota["rest"] = rest_days(entry, role["rota"], rng)
        else:
            # a/b/c tile the cycle; the offset is what makes them not collide.
            rota["offset"] = sorted(role["watches"]).index(watch)
        hours = role["weekly_hours"]
        if role["hours_rule"] == "floor" and (person.get("hours") or 0) > hours:
            hours = person["hours"]

    report = role["report"]
    travel = person.get("travel")
    if travel is None:
        travel = 20

    arrive = (start - report) % 1440
    depart = (arrive - travel) % 1440

    shift = {
        "watch": watch,
        "start": start,
        "end": start + length,
        "report": report,
        "rota": rota,
    }
    return shift, depart, arrive, hours


def apply(roster, by_id, seed=DEFAULT_SEED):
    """Write a shift onto every primary assignment and rewrite its person.

    Mutates both the roster entries and the person records they point at, and
    returns what changed so the caller can report it. Must run after `crew`:
    crewing reassigns a medic's platoon to match their partner's, and a shift
    derived before that would describe the watch the medic used to be on.
    """
    changed = {"depart": 0, "hours": 0, "duty_moved": 0}
    moved = Counter()
    deltas = []

    for entry in roster:
        if entry.get("class") != "primary" or entry["role"] not in SHIFTS:
            continue
        person = by_id[entry["person"]]
        shift, depart, arrive, hours = schedule(entry, person, seed)

        if shift["watch"] != entry["platoon"]:
            changed["duty_moved"] += 1
            moved[(entry["platoon"], shift["watch"])] += 1

        if person.get("depart") is not None and person["depart"] != depart:
            deltas.append(abs(person["depart"] - depart))
            changed["depart"] += 1
        if hours is not None and person.get("hours") != hours:
            changed["hours"] += 1
            person["hours"] = hours

        person["depart"] = depart
        person["arrive"] = arrive
        entry["shift"] = shift

    changed["moved"] = moved
    changed["median_delta"] = (sorted(deltas)[len(deltas) // 2] if deltas else 0)
    return changed


def report(roster, by_id, changed):
    print("\n\033[1mshifts\033[0m  roster overrides PUMS for primary roles")
    print(f"  rewrote depart/arrive on {changed['depart']:,} records "
          f"(median move {changed['median_delta']} min)")
    if changed["hours"]:
        print(f"  rewrote weekly hours on {changed['hours']:,} records "
              f"(24/48 is 56 hours, not 40)")
    for (was, now), count in changed["moved"].most_common():
        print(f"  moved {count:>3} {was} → {now} (day-only duty)")

    watches = defaultdict(list)
    for entry in roster:
        if "shift" not in entry:
            continue
        watches[(entry["role"], entry["shift"]["watch"])].append(
            by_id[entry["person"]]["depart"])

    print()
    clock = lambda m: f"{m // 60:02d}:{m % 60:02d}"
    for (role, watch), departs in sorted(watches.items()):
        departs.sort()
        print(f"  {role:<15} {watch:<8} n={len(departs):>4}  "
              f"depart p10 {clock(departs[len(departs) // 10])}  "
              f"median {clock(departs[len(departs) // 2])}  "
              f"p90 {clock(departs[len(departs) * 9 // 10])}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--write", action="store_true",
                        help="apply to sim_data instead of only reporting")
    args = parser.parse_args()

    if not EMPLOYMENT.exists():
        raise SystemExit(f"{EMPLOYMENT} not found — run init_work.py first")

    population = json.loads(POPULATION.read_text())
    employment = json.loads(EMPLOYMENT.read_text())
    by_id = {p["id"]: p for p in population["person_records"]}
    roster = employment["assignments"]

    changed = apply(roster, by_id, args.seed)
    report(roster, by_id, changed)

    if args.write:
        employment["shift_seed"] = args.seed
        POPULATION.write_text(json.dumps(population, separators=(",", ":")))
        EMPLOYMENT.write_text(json.dumps(employment, separators=(",", ":")))
        print(f"\nWrote {EMPLOYMENT.name} and {POPULATION.name}")
    else:
        print("\nreport only; pass --write to apply")


if __name__ == "__main__":
    main()
