"""Where everything lives, in one place.

Before this, every stage resolved its own paths and roughly half of them named
the city while doing it — `pums-kierston-full.json`, `kierston_buildings_geom.json`,
`topology_40.602989_-75.472188_5km.graphml`. Moving a file meant finding
fourteen scripts, and standing up a second city meant editing all of them.

The four roots, and the rule for telling them apart:

    sources/<city>/    what a user downloaded for their city. Never generated,
                       never edited by the pipeline, gitignored.
    reference/         city-independent assets that ship with the engine — the
                       vehicle market, the TAC table, the occupation mapping,
                       the name curves. The same bytes for every city, so no
                       reason for anyone to fetch them twice. `reference/raw/`
                       holds the bulk originals these were distilled from and
                       `reference/build/` the scripts that did it; neither is
                       touched by an ordinary build.
    jurisdictions/<p>/ what varies by legal system rather than by city. Every
                       Pennsylvania city shares `us-pa`.
    sim_data/          rebuildable pipeline data and simulation manifests.
    sim_outputs/       final KDAY products emitted by the simulation.

Intake products go to sim_data with the rest of the generated output. They used
to be written back into the source directory, which is what made that directory
hard to reason about: a reader had no way to tell `export.json`, which a user
downloaded, from `pois.json`, which the pipeline derived from it.

Stages import this by name (`from paths import PUMS`) on the same sys.path
insert they already use to reach a sibling package.
"""

import os
from pathlib import Path


KIERSTON = Path(__file__).resolve().parent.parent

# Which city is being built. One environment variable rather than a flag, so
# that every stage, the pathfinder and the viewers agree on it without having
# to pass it to each other.
CITY = os.environ.get("KIERSTON_CITY", "kierston")

CITIES = KIERSTON / "cities"
REFERENCE = KIERSTON / "reference"
JURISDICTIONS = KIERSTON / "jurisdictions"
SOURCES = KIERSTON / "sources" / CITY
# Where the build goes. KIERSTON_SIM_DATA_DIR points it elsewhere — a scratch
# directory for a trial build, or one to compare against the real city — with
# the same meaning the simulation gives it in sim/src/world/data.ts. Resolved
# here, once, because every stage runs with its own folder as the working
# directory and a relative path would otherwise mean a different place in each.
_SIM_DATA_OVERRIDE = os.environ.get("KIERSTON_SIM_DATA_DIR")
SIM_DATA = (Path(_SIM_DATA_OVERRIDE).resolve() if _SIM_DATA_OVERRIDE is not None
            else KIERSTON / "sim_data")
SIM_OUTPUTS = KIERSTON / "sim_outputs"

PROFILE = CITIES / f"{CITY}.toml"

# What the user supplies. The names are what the asset *is*, not what the
# service that served it happened to call it.
PUMS = SOURCES / "pums.json"
PUMS_CODEBOOK = SOURCES / "pums_codebook.json"
BUILDINGS_GEOM = SOURCES / "buildings_geom.json"
POIS_EXPORT = SOURCES / "pois_export.json"
TOPOLOGY = SOURCES / "topology.graphml"
GEOCODE_CACHE = SOURCES / "geocode_cache.json"
# The two halves of the cellular network that are read rather than modelled:
# real structures from the FCC, and real identifier allocations from
# OpenCelliD. `acquire/fetch_asr.py` and `acquire/fetch_opencellid.py` write
# them; only init/network/towers.py reads them.
ASR_TOWERS = SOURCES / "asr_towers.json"
OPENCELLID = SOURCES / "opencellid_local.json"

# What ships with the engine.
VEHICLE_MARKET = REFERENCE / "vehicle_market.json"
TAC_TABLE = REFERENCE / "tac_table.json"
OCCUPATIONS = REFERENCE / "occp_mapping.json"
NAMES = REFERENCE / "names.json"

# What intake derives, alongside every other generated product.
DWELLINGS = SIM_DATA / "dwellings.json"
POIS = SIM_DATA / "pois.json"
BUILDINGS = SIM_DATA / "buildings.json"
WORKPLACES = SIM_DATA / "workplaces.json"
MCC_BY_TAG = SIM_DATA / "mcc_by_tag.json"
POI_MCC = SIM_DATA / "poi_mcc.json"
INTAKE_MANIFEST = SIM_DATA / "intake.json"
# What makes a folder a city build: init_sim.py writes it after every run, and
# the simulation and KierstonBlue look for it. See init/city_manifest.py.
CITY_MANIFEST = SIM_DATA / "kierston-city.json"

# The cellular network: structures and the cells that transmit from them.
TOWERS = SIM_DATA / "towers.json"

CAR_GRAPH = SIM_DATA / "car_graph.bin"

CITY_ASSETS = CITIES / CITY
CAMERAS = CITY_ASSETS / "cameras.json"

# The city's long lists, read by city_data.py: its telephone exchanges and
# magisterial courts, and the local firms and offices its records name. Row
# order is part of the data — a weighted draw walks the rows in file order.
EXCHANGES = CITY_ASSETS / "exchanges.csv"
MAGISTERIAL_DISTRICTS = CITY_ASSETS / "magisterial_districts.csv"
BANKS = CITY_ASSETS / "banks.csv"
GUN_DEALERS = CITY_ASSETS / "gun_dealers.csv"
COLLEGES = CITY_ASSETS / "colleges.csv"
GRADUATE_SCHOOLS = CITY_ASSETS / "graduate_schools.csv"
HIGH_SCHOOLS = CITY_ASSETS / "high_schools.csv"
MORTGAGE_LENDERS = CITY_ASSETS / "mortgage_lenders.csv"
PHARMACIES = CITY_ASSETS / "pharmacies.csv"
BILLERS = CITY_ASSETS / "billers.csv"
SCHOOL_TRANSPORT = CITY_ASSETS / "school_transport.csv"
TAXI_OPERATORS = CITY_ASSETS / "taxi_operators.csv"
# Read by the simulation directly, like cameras.json; listed so the one place
# that names the city's files names all of them.
PAYERS = CITY_ASSETS / "payers.csv"
CAB_COMPANIES = CITY_ASSETS / "cab_companies.csv"

# What init publishes for the simulation from the profile and the jurisdiction.
CITY_JSON = SIM_DATA / "city.json"
PLATE_RULES = SIM_DATA / "plate_rules.json"


def day_export(date=None):
    if date is not None:
        return require(SIM_OUTPUTS / f"day_{date}.bin",
                       f"cd kierston/sim && bun run day --export-day --date {date}")
    days = sorted(SIM_OUTPUTS.glob("day_*.bin"))
    if not days:
        raise SystemExit(
            f"no exported day in {SIM_OUTPUTS}\n"
            "  cd kierston/sim && bun run day --export-day --date <iso-date>")
    return days[-1]


def jurisdiction(profile, name):
    """An asset from a jurisdiction bundle — `jurisdiction("us-pa", "offense_list.csv")`."""
    return JURISDICTIONS / profile / name


def jurisdiction_rules(profile):
    """The bundle's rule file, `jurisdictions/<profile>/jurisdiction.toml`."""
    return jurisdiction(profile, "jurisdiction.toml")


def require(path, hint):
    """Fail with what is missing and how to get it, rather than on a decode error.

    Every path here can be absent for a reason a stack trace does not carry: a
    source the user has not downloaded yet, a reference asset lost to a partial
    checkout, an intake stage that has not run. Saying which is cheaper than
    letting `json.loads` report a syntax error at byte 0 of nothing.
    """
    if not path.exists():
        raise SystemExit(f"missing {path}\n  {hint}")
    return path
