"""Build every input the simulation needs, from raw extracts to packed binary.

The stages below already existed as standalone scripts and still work that way;
this only puts them in order and runs them. That order is not obvious from the
filenames — `assign_dwellings` reads the file `synthesize_population` writes and
overwrites it in place, so running them out of sequence silently produces a
half-built population rather than an error.

    locale              the profile and plate rules -> city.json and
                        plate_rules.json, for everything that is not Python
    dwellings           the OSM building export -> dwellings.json, and the
                        stock parameters fitted from this city's own buildings
    pois                the OSM POI export -> pois.json, the venue catalogue
    buildings           the same export as map points -> buildings.json
    mcc                 merchant category codes per POI and per tag
    synthesize_population  PUMS extract -> population.json, unplaced
    assign_dwellings    gives every household an address, in place
    init_work           staffs the emergency services -> employment.json
    workplaces          buildings + POIs -> workplaces.json, the site catalogue
    assign_work         sends the rest of the workforce to work, in place
    schools             the school buildings -> schools.json, with bands
    assign_school       enrolls every student -> enrollment.json
    towers              FCC structure registry + OpenCelliD -> towers.json,
                        the masts and the cells that transmit from them
    orgs                POIs + worksites + schools -> orgs.json
    affiliations        who belongs to what, and to which unit inside it
    kinship             parents, siblings, partners -> kinship.json
    identity            names, birth dates, SSNs -> identity.json
    devices             the handset behind each mobile number, with its IMEI,
                        IMSI and SIM -> devices.json
    ties                the social graph -> ties.bin
    dockets             criminal histories -> dockets.json
    holdings            licences, accounts, loans, property -> holdings.json
    vehicles            the vehicle registry, keyed by VIN, residents' cars
                        and the school bus fleet -> vehicles.json
    external_traffic    recurring outside workers, deliveries and visitors ->
                        external_traffic.json; one-offs remain date-local
    fleet               operational owners and depots, by VIN -> fleet.json
    recurring_spending  the bills that arrive anyway — rent, utilities, loans,
                        subscriptions -> recurring_spending.json
    school_travel       how each student travels, and the bus runs that carry
                        them -> school_travel.json
    pack_population     population.json -> population.bin for the viewer
    pack_records        identity/dockets/holdings/vehicles -> six .bin
    pack_external       external_traffic.json -> external_traffic.bin
    pack_init           those nine binaries -> sim_init.bin, one container
                        with a section directory the viewer range-fetches

Stages are grouped in folders by what they build — population, living_places,
work, education, social, criminal_history, personal_records — and a stage
imports a sibling folder's module by name (`from population import pums`),
which works because each script puts this directory on its path before doing so.

Stages stay separate processes rather than imported functions. Each one owns a
file, prints its own validation report, and is worth running alone while
working on it; a runner that imported them would have to reproduce their
argument handling to keep that true. The cost is re-reading population.json
between stages, which is seconds against a pipeline measured in minutes.

Adding a stage is one entry in STAGES. Anything that reads a file an earlier
stage writes goes after it, and `--from` exists so a later stage can be
re-run without repeating the expensive ones.

The one loop that runs backwards
-------------------------------
`school_travel.py` has to decide which bus covers which runs, and that needs
each run's duration. It has no road graph — that lives in the simulation, by
design, because init decides structure and the runtime decides minutes. So the
first build estimates from straight-line distance, and after it:

    cd ../sim && bun run day --measure-runs
    python3 education/school_travel.py

routes every run properly, writes the durations to school_runs_measured.json,
and reschedules the fleet against them. The measurements are keyed on a
fingerprint of each run's manifest rather than on its id, so a stale file is
ignored rather than misapplied to routes it was never taken from.

This converges after one pass and does not need repeating. A run's stops, their
order and its manifest come from the riders alone; nothing in `build_runs`
consults the fleet, and only the assignment uses the duration. So feeding the
measurements back cannot change the runs that were measured.

Where the external files come in
--------------------------------
The four intake stages at the head of the chain are the only thing in the
pipeline that opens a file a user downloaded. Everything after them reads what
intake wrote into sim_data/, so the shape of an Overpass export or a PUMS pull
is known in one place.

They used to be `util_scripts/`, half in and half out of the pipeline — one of
them was already stage zero here while the other three had to be remembered and
run by hand, and all four wrote back into the directory the downloads live in.
Nothing about that split was load-bearing, and pretending the map viewer was
their only consumer was never true: the simulation reads pois.json for parking
and mcc_by_tag.json to price a card payment.

What is *not* here is acquisition. Fetching a PUMS extract or an OSM topology
is networked, credentialed and slow, and it is done by hand before a build — `acquire/`
holds helpers for the ones that have a public API, and none of them run as part
of a build.
"""

import argparse
import os
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
INIT = ROOT / "init"
INTAKE = INIT / "intake"



def _early_out(argv):
    """--out, read before paths.py fixes SIM_DATA at import."""
    for i, arg in enumerate(argv):
        if arg == "--out" and i + 1 < len(argv):
            return argv[i + 1]
        if arg.startswith("--out="):
            return arg.split("=", 1)[1]
    return None


# --out is the same thing as KIERSTON_SIM_DATA_DIR, spelled as a flag. It has
# to land in the environment before paths.py is imported, since every path
# below is computed from it at import, and the stages inherit it from there.
if (_OUT := _early_out(sys.argv[1:])) is not None:
    os.environ["KIERSTON_SIM_DATA_DIR"] = str(Path(_OUT).expanduser().resolve())

sys.path.insert(0, str(INIT))
from paths import SIM_DATA  # noqa: E402
import city_manifest  # noqa: E402

# Stages run with their own folder as the working directory, so hand them the
# override already resolved rather than a path relative to where this started.
if "KIERSTON_SIM_DATA_DIR" in os.environ:
    os.environ["KIERSTON_SIM_DATA_DIR"] = str(SIM_DATA)


class Stage:
    """One script in the chain.

    `options` names the shared command-line options this stage accepts, so
    --seed reaches the two stages that take one and is not passed to the two
    that would reject it.
    """

    def __init__(self, name, script, produces, options=(), arguments=()):
        self.name = name
        self.script = script
        self.produces = produces
        self.options = options
        # Flags this stage always takes, regardless of what was asked for on
        # the command line. `mcc.py` reports by default and writes on request,
        # which is right when it is run by hand and not what a build wants.
        self.arguments = arguments

    def command(self, args):
        command = [sys.executable, str(self.script), *self.arguments]
        for option in self.options:
            value = getattr(args, option)
            # Only forward what was asked for explicitly. Left alone, each
            # stage applies its own default, which stays the one authority on
            # what that default is.
            if value is not None:
                command += [f"--{option}", str(value)]
        return command


STAGES = [
    # The profile and the jurisdiction's plate rules, republished as JSON for
    # the simulation, the pathfinder and Fastgate. Reads nothing any stage
    # writes, so `--only locale` refreshes them on an existing build.
    Stage("locale", INIT / "publish_locale.py", SIM_DATA / "city.json"),
    # Intake. These four read the city's downloads in sources/ and nothing else does.
    # `dwellings` also fits the stock parameters from this city's own
    # buildings, so it has to precede anything that counts a household.
    Stage("dwellings", INTAKE / "dwellings.py",
          SIM_DATA / "dwellings.json"),
    # Before `work`, which sites jobs and staffs the stations from the POIs.
    Stage("pois", INTAKE / "pois.py", SIM_DATA / "pois.json"),
    # After `dwellings`, whose unit counts it joins on to each building. Read
    # by the map and by the pathfinder's geocoder, not by any init stage.
    Stage("buildings", INTAKE / "buildings.py", SIM_DATA / "buildings.json"),
    # After `pois`, which it classifies. `--write` because the script is a
    # coverage report by default and only emits the tables when asked.
    Stage("mcc", INTAKE / "mcc.py", SIM_DATA / "mcc_by_tag.json",
          arguments=("--write",)),
    Stage("population", INIT / "population" / "synthesize_population.py",
          SIM_DATA / "population.json", options=("seed", "households")),
    Stage("placement", INIT / "living_places" / "assign_dwellings.py",
          SIM_DATA / "population.json", options=("seed",)),
    Stage("work", INIT / "work" / "init_work.py",
          SIM_DATA / "employment.json", options=("seed",)),
    Stage("workplaces", INIT / "work" / "workplaces.py",
          SIM_DATA / "workplaces.json", options=("seed",)),
    Stage("assign_work", INIT / "work" / "assign_work.py",
          SIM_DATA / "employment.json", options=("seed",)),
    # The cellular network. After `workplaces` because the demand surface that
    # decides which sites carry a capacity layer is residents and jobs
    # together, and before anything that will emit a call record. It reads two
    # files the user downloaded — the FCC's structure registry and an
    # OpenCelliD extract — so it is the one stage outside `intake/` that
    # touches `sources/`, which is deliberate: the structures are a matter of
    # public record and modelling them would be inventing a worse copy.
    Stage("towers", INIT / "network" / "towers.py",
          SIM_DATA / "towers.json", options=("seed",)),
    Stage("schools", INIT / "education" / "schools.py",
          SIM_DATA / "schools.json", options=("seed",)),
    Stage("assign_school", INIT / "education" / "assign_school.py",
          SIM_DATA / "enrollment.json", options=("seed",)),
    # The affiliation layer, which is where the social graph will be built
    # from. It goes here and not earlier because it reads the answers the two
    # assignment stages above produced: a workplace and a school are places
    # people belong to, and re-deriving who works and studies where would give
    # a second set that disagreed with the first.
    Stage("orgs", INIT / "social" / "orgs.py",
          SIM_DATA / "orgs.json", options=("seed",)),
    Stage("affiliations", INIT / "social" / "affiliations.py",
          SIM_DATA / "affiliations.json", options=("seed",)),
    # Who is whose parent, which has to be settled before anybody is named.
    # Surnames descend, so the graph is an input to names.py and not something
    # that could be recovered from its output — run these the other way round
    # and the only thing surname matching finds is the rule that drew them.
    Stage("kinship", INIT / "social" / "kinship.py",
          SIM_DATA / "kinship.json", options=("seed",)),
    # The personal-records chain. Order is a hard dependency, not a preference:
    # identity gives everyone the name and date of birth the other two key off,
    # dockets needs those to file a case against anybody, and holdings needs the
    # convictions from dockets to know whose licence is suspended and who may
    # not hold a firearm.
    Stage("identity", INIT / "personal_records" / "identity.py",
          SIM_DATA / "identity.json", options=("seed",)),
    # ties runs after identity because the foreign-born need a birthplace
    # before they can be given anyone to have left behind, and before dockets
    # so that a case can eventually be filed against somebody the defendant
    # actually knows rather than against a stranger.
    Stage("ties", INIT / "social" / "ties.py",
          SIM_DATA / "ties.bin", options=("seed",)),
    Stage("dockets", INIT / "criminal_history" / "dockets.py",
          SIM_DATA / "dockets.json", options=("seed",)),
    # After dockets, so people in custody receive no phone or subscription.
    # The handsets also come after identity because a device hangs
    # off the mobile number identity.py issued — this stage never mints one —
    # and after kinship because a minor's line is billed to a parent, and
    # naming the wrong one would put the subscriber on the wrong record. It is
    # the endpoint model the call and message layers will key on, so it goes in
    # before any of that exists rather than being retrofitted underneath it.
    Stage("devices", INIT / "personal_records" / "devices.py",
          SIM_DATA / "devices.json", options=("seed",)),
    # After custody and devices as well as ties, so only active phone holders
    # can adopt messaging platforms or join threads.
    # Messaging-platform adoption is contagious — an app is worth having only
    # if your people have it — so the stage reads the tie graph to decide who
    # is on what. Run before ties and every platform lands as a demographic
    # sprinkle with correct marginals and no clustering at all.
    Stage("accounts", INIT / "personal_records" / "accounts.py",
          SIM_DATA / "accounts.json", options=("seed",)),
    # Also after assign_work, and not only after dockets. A payday is a fact
    # about an employer rather than about a person — everyone at the same
    # warehouse is paid on the same Friday — so the banking model reads the
    # site assignments to draw one cycle per workplace and share it. Run this
    # before assign_work and every employer's staff scatters across four
    # different pay cycles.
    Stage("holdings", INIT / "personal_records" / "holdings.py",
          SIM_DATA / "holdings.json", options=("seed",)),
    # After holdings, because a vehicle is registered to a licensed driver and
    # holdings decides who holds a licence against the suspensions in the court
    # record. Reads reference/vehicle_market.json, which reference/build
    # distils once from the NHTS and EPA extracts rather than on every run —
    # it is national data and identical for every city. Also after
    # assign_school, because the same stage registers the school bus fleet and
    # sizes it from how many students are enrolled in the bands a bus serves.
    Stage("vehicles", INIT / "personal_records" / "vehicles.py",
          SIM_DATA / "vehicles.json", options=("seed",)),
    # Vehicles that repeatedly enter from outside are a static population in
    # the same sense as resident vehicles: their plate, model, colour and usual
    # destination must survive across exported dates. One-off visitors and
    # through traffic are intentionally left to the day exporter.
    Stage("external_traffic", INIT / "traffic" / "external.py",
          SIM_DATA / "external_traffic.json", options=("seed",)),
    # Operational ownership and depots reference the canonical registry by
    # VIN. No registered vehicle is manufactured by this stage.
    Stage("fleet", INIT / "personal_records" / "fleet.py",
          SIM_DATA / "fleet.json", options=("seed",)),
    # The bills, last of the personal-records chain because it reads most of
    # it: the dwelling and the ACS housing record behind it for rent and the
    # utilities, holdings for the mortgage and the cards, vehicles for the auto
    # loan and the registration renewal. Nothing downstream of it in this list
    # reads what it writes except pack_records, which requires it — this stage
    # was missing from STAGES entirely, so a clean rebuild reached the packer
    # with no recurring_spending.json and failed there rather than here.
    Stage("recurring_spending",
          INIT / "personal_records" / "recurring_spending.py",
          SIM_DATA / "recurring_spending.json", options=("seed",)),
    # How every student gets to school, and the bus runs that carry the ones
    # who ride. Last of the assignment stages because it reads all of them: the
    # school from assign_school, the parent from kinship, the car a lift needs
    # and the bus a run needs from vehicles, and the shift that decides whether
    # a parent could do the drop from employment.
    Stage("school_travel", INIT / "education" / "school_travel.py",
          SIM_DATA / "school_travel.json", options=("seed",)),
    Stage("pack", INIT / "population" / "pack_population.py",
          SIM_DATA / "population.bin"),
    # Both packing stages go last and read only what the stages above wrote, so
    # re-running them is always safe and always cheap. This one turns 383 MB of
    # records into six binaries the viewer can open — see pack_records.py for
    # where the cuts fall and why there are six rather than one.
    Stage("pack_records", INIT / "personal_records" / "pack_records.py",
          SIM_DATA / "identity.bin"),
    Stage("pack_external", INIT / "traffic" / "pack_external.py",
          SIM_DATA / "external_traffic.bin"),
    # Last, and reads only the two stages above it. Wraps the packed binaries
    # in one container with a section directory so a viewer can fetch the one
    # table it needs by byte range instead of the file it happens to live in.
    # Sections are copied whole, so this cannot change what they contain — see
    # pack_init.py for why it nests rather than merges.
    Stage("pack_init", INIT / "pack_init.py", SIM_DATA / "sim_init.bin"),
]


# What a build prints as each stage starts: what is being done, to what. The
# line ends with the file the stage writes. Keyed by stage name; a stage
# without an entry prints its name.
TITLES = {
    "locale": "Publishing city profile and license plate rules",
    "dwellings": "Extracting homes from OpenStreetMap buildings",
    "pois": "Extracting shops and venues from OpenStreetMap",
    "buildings": "Creating map points for buildings",
    "mcc": "Assigning merchant category codes to venues",
    "population": "Synthesizing households and residents",
    "placement": "Assigning households to home addresses",
    "work": "Assigning residents to police, ambulance, taxi and school bus jobs",
    "workplaces": "Building workplace catalog",
    "assign_work": "Assigning employed residents to workplaces",
    "towers": "Placing cell towers and antennas",
    "schools": "Building school list",
    "assign_school": "Enrolling students in schools",
    "orgs": "Creating organizations",
    "affiliations": "Assigning residents to organizations",
    "kinship": "Linking family members",
    "identity": "Generating names, birth dates and SSNs",
    "devices": "Issuing phones, SIM cards and phone numbers",
    "ties": "Building social graph",
    "accounts": "Creating messaging accounts",
    "dockets": "Generating criminal records",
    "holdings": "Generating licenses, bank accounts, loans and property records",
    "vehicles": "Registering vehicles",
    "external_traffic": "Generating external traffic",
    "fleet": "Assigning fleet vehicles to operators and depots",
    "recurring_spending": "Generating recurring bills",
    "school_travel": "Planning school travel",
    "pack": "Packing population",
    "pack_records": "Packing personal records",
    "pack_external": "Packing external traffic",
    "pack_init": "Combining packed files",
}


def run(stage, args, position, count):
    """Run one stage, returning how long it took. Raises on failure."""
    if args.verbose_output:
        print(f"\n\033[1m── {stage.name} ─\033[0m {stage.script.name}", flush=True)
    else:
        width = len(str(count))
        print(f"[{position:>{width}}/{count}] {TITLES.get(stage.name, stage.name)}"
              f" -> {stage.produces.name}", flush=True)
    start = time.monotonic()

    # By default a build says only which stage it has started. The scripts'
    # validation reports and breakdowns are captured, and shown only if the
    # stage fails; --verbose-output lets them through as they are printed.
    result = subprocess.run(
        stage.command(args),
        cwd=stage.script.parent,
        capture_output=not args.verbose_output,
        text=True,
    )
    elapsed = time.monotonic() - start

    if result.returncode != 0:
        if result.stdout:
            print(result.stdout, end="")
        if result.stderr:
            print(result.stderr, end="", file=sys.stderr)
        raise SystemExit(
            f"\n{stage.name} failed ({stage.script.name}, "
            f"exit {result.returncode}); later stages were not run")

    return elapsed


def selected(args):
    """The stages to run, honouring --only and --from."""
    names = [s.name for s in STAGES]
    if args.only:
        return [s for s in STAGES if s.name in args.only]
    if args.start:
        return STAGES[names.index(args.start):]
    return STAGES


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__.splitlines()[0],
        epilog="stages: " + ", ".join(s.name for s in STAGES))
    parser.add_argument("--from", dest="start", choices=[s.name for s in STAGES],
                        help="start at this stage")
    parser.add_argument("--only", nargs="+", choices=[s.name for s in STAGES],
                        help="run only these stages, in pipeline order")
    parser.add_argument("--seed", type=int, default=None,
                        help="override the seed of every stage that takes one")
    parser.add_argument("--households", type=int, default=None,
                        help="number of households (default: sum of WGTP)")
    parser.add_argument("--out", metavar="PATH",
                        help="build into PATH instead of kierston/sim_data; "
                             "same as KIERSTON_SIM_DATA_DIR")
    parser.add_argument("--manifest-only", action="store_true",
                        help="write kierston-city.json for an existing build "
                             "and run nothing")
    parser.add_argument("--verbose-output", action="store_true",
                        help="print each stage's report, then timings and file "
                             "sizes (default: stage names only)")
    args = parser.parse_args()

    if args.manifest_only:
        if not (SIM_DATA / "population.json").exists():
            raise SystemExit(f"{SIM_DATA} has no population.json and is not a city build")
        city_manifest.write(args.seed, args.households, [])
        print(f"Wrote {city_manifest.CITY_MANIFEST}")
        return

    stages = selected(args)
    SIM_DATA.mkdir(parents=True, exist_ok=True)

    # A stage started from --from reads what an earlier one wrote, and there is
    # no way to tell a file that is merely old from one that was never built.
    # Say what is being trusted rather than failing later on a missing key.
    if stages != STAGES:
        skipped = [s for s in STAGES if s not in stages]
        missing = [s.name for s in skipped if not s.produces.exists()]
        if missing:
            raise SystemExit(
                f"{', '.join(missing)} skipped but has no output; "
                f"run it first")
        # Stages can share an output file (placement rewrites population.json
        # in place), so name each reused file once.
        reused = dict.fromkeys(s.produces.name for s in skipped)
        print(f"running {len(stages)} of {len(STAGES)} stages, "
              f"reusing existing {', '.join(reused)}")

    timings = [(stage.name, run(stage, args, position, len(stages)))
               for position, stage in enumerate(stages, 1)]

    city_manifest.write(args.seed, args.households, timings)

    total = sum(t for _, t in timings)
    if not args.verbose_output:
        print(f"City built in {total:.0f} s -> {SIM_DATA}")
        return
    print(f"\n\033[1m── done ─\033[0m {total:.1f}s")
    for name, elapsed in timings:
        print(f"  {name:<12} {elapsed:>6.1f}s")
    for path in sorted({s.produces for s in stages}):
        print(f"  {path.name:<20} {path.stat().st_size / 1e6:>6.1f} MB")

if __name__ == "__main__":
    main()
