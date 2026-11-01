"""Build the cellular network: antenna structures and the cells on them.

This is the layer the call, message and data records will key on. A CDR does
not say where somebody was — it says which cell served them, and everything an
investigator can do with that afterwards depends on the cell being a real thing
in a real place with real neighbours.

Two tables, for the same reason devices.py has two
--------------------------------------------------
    STRUCTURE   a physical object at a coordinate. A monopole, a lattice, a
                utility pole, a rooftop. It has a height and an owner, and the
                owner is usually a tower company rather than a carrier.
    CELL        one operator's one sector on one band, transmitting from a
                structure. This is what a CDR reports.

The relationship is many-to-one and that is the whole point. Colocation is the
norm in the United States: Crown Castle, American Towers, SBA and Vertical
Bridge own the steel and lease space on it, so two or three operators transmit
from the same coordinate with entirely unrelated identifiers. A model that gave
each cell its own coordinate could not express that, and a tool that clusters
cell sites by position would never be tested against the case where it should
merge three of them into one.

The Kierston data makes the point better than the argument does. AT&T owns
**zero** registered structures here and is on the air from thirty-four sites,
because it leases. Verizon owns ten and is invisible in the crowdsourced cell
data. Neither of those is a fact you could recover from one source alone.

Where the structures come from: read, not modelled
--------------------------------------------------
`sources/<city>/asr_towers.json`, cut from the FCC's Antenna Structure
Registration database by `acquire/fetch_asr.py`. Real coordinates, real
heights, real owners, public domain. Forty of them stand inside Kierston's
radius and seventy-eight within eight kilometres.

An earlier draft of this file placed towers on a demand surface with a
zoning-aware snap to plausible host buildings. All of that is deleted. It was a
model of a thing that is a matter of public record, and the record is better
than the model was ever going to be — it knows that the mast at 670 m from the
centre is a 38 m monopole belonging to Verizon's local operating partnership,
which no demand surface was going to guess.

What is still modelled, and why it has to be
--------------------------------------------
ASR registers structures over 60.96 m (200 ft) or near an airport. Everything
shorter is exempt, so **every rooftop site and every short monopole is missing
by construction** — and in a downtown those are most of the deployment. So this
stage adds rooftops where the demand surface says coverage is needed and no
registered structure is near enough to provide it, siting them on the tallest
eligible building in the gap. Those carry `source: "modelled"` and are counted
separately in the report, because a consumer is entitled to know which
structures are evidence and which are inference.

Nothing else about the network is in any public source at the granularity this
needs. Sectors, azimuths, downtilts, bands, radiated power and cell identifiers
are all modelled here, hung off real coordinates.

Where the identifiers come from
-------------------------------
`sources/<city>/opencellid_local.json`, from `acquire/fetch_opencellid.py`.
Crowdsourced, so its *positions* are useless — they are centroids of where
handsets happened to observe each cell, hundreds of metres out and biased
toward roads. Nothing here reads a coordinate from it.

What it is read for is allocation. It says AT&T runs eNodeB identifiers between
20008 and 29640 in this market on tracking areas 9, 11, 12, 33 and 773, and
that T-Mobile runs 43422 to 880750 on 22222 and 22248. So the block this city
allocates from can be demonstrably clear of the real one.

That clearance is deliberate and it is the opposite of the decision devices.py
made about Type Allocation Codes. A TAC names a handset *model*, so a real one
on a synthetic phone is a true statement about a model nobody owns, and
colliding with the real allocation was right. A cell identifier is not like
that: **it names a place.** A real Verizon ECGI resolves, in any of the public
databases, to an actual street corner in America that is not Kierston, so
issuing one would make every location answer confidently and undetectably
wrong. Unlike the TAC case there is no benefit on the other side of the trade —
tooling that resolves a cell id to a location is *supposed* to fail on a city
that does not exist.

It is also worth saying plainly that the OpenCelliD extract is not a census.
Verizon does not appear in it at all despite owning more structures here than
anyone, because crowdsourced collection has never seen its cells well. An
operator missing from that file says nothing about whether it is on the air, so
tenancy below is assigned rather than read.

Radio technology
----------------
LTE and NR only. Every US carrier finished shutting down 3G in 2022 and 2G
before it, so at devices.py's simulation date of July 2026 there is no UMTS and
no GSM to attach to — and the local OpenCelliD extract confirms it, with 247
LTE and 179 NR cells and not one of anything else. One consequence worth
carrying downstream: all voice is VoLTE, so a call is a data bearer and there
is no circuit-switched fallback for a CDR to record.

The second consequence is a join this layer shares with devices.py. A handset
can only attach to what its radio supports, and devices.py already records the
model's release year — so a 2018 budget Android is LTE-only and will never
appear on n77 or n41, while a 2024 flagship will. The capability table below is
what makes that checkable rather than decorative.

What this deliberately does not do
----------------------------------
No traffic, no attachment, no handovers, no serving-cell selection. Those are
runtime questions — they need a position at a time, which only the simulation
has — and they belong in `sim/src/network/`, which now exists and does them:
it reads this file, scores every cell against a handset's position minute by
minute, and writes the serving-cell spans and the signalling into the packed
day. What it needed from here and got is the geometry — azimuth, downtilt,
height, EIRP, morphology — which is why those fields are worth having even
though nothing in initialization reads them back.

One thing that layer adds rather than reads is beamforming gain. `eirp_dbm`
here is a property of the site, which is the right thing for this file to
record; the gain a massive-MIMO array puts on the beam toward one handset is a
property of a link that does not exist until somebody is standing somewhere,
and it lives at the other end.

Three kinds of structure are modelled where the registry is silent, and each
carries `source: "modelled"` so a consumer can tell evidence from inference:

    rooftop     an antenna on the tallest eligible building in a busy grid
                cell that no site reaches, which is what the ASR threshold
                hides in a downtown
    monopole    a 35 m mast at the demand centroid of a busy cell with no
                building tall enough to host a rooftop, which is what it hides
                in a suburb — most of the macro network there stands on steel
                under 200 ft that never had to be registered
    small cell  a single-operator, single-sector node on a street pole in the
                dense blocks, carrying mid and capacity bands only, which is
                how the traffic in a city centre is actually carried in 2026

Indoor distributed antenna systems are still not modelled.
"""

import argparse
import json
import math
import sys
import zlib
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from paths import (ASR_TOWERS, BUILDINGS, DWELLINGS, OPENCELLID,  # noqa: E402
                   TOWERS, WORKPLACES, require)
import profile as city_profile  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "personal_records"))

from registries import keyed  # noqa: E402

DEFAULT_SEED = 20260728


def stream_key(*parts):
    """A stable integer for a string key, for `keyed` to draw a stream from.

    CRC32 rather than `hash`, and the distinction is not pedantry: Python
    randomises string hashing per process unless PYTHONHASHSEED is set, so a
    stream keyed on `hash(structure_id)` gives a different network on every
    run of the same seed. That is exactly the reproducibility this pipeline
    exists to have, and it was silently broken until the output was hashed
    twice and the digests disagreed.
    """
    return zlib.crc32("|".join(str(part) for part in parts).encode())


# ---------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------

# Everything here is local to one city of a few kilometres across, where a
# planar approximation is accurate to well under a metre and a haversine call
# per candidate pair would dominate the runtime. The latitude scale is fixed
# once from the city centre rather than recomputed per point.

def projector(centre):
    """(to_xy, distance, to_latlon) in metres, for a city centred at `centre`."""
    scale = 111_320 * math.cos(math.radians(centre[0]))

    def to_xy(lat, lon):
        return ((lon - centre[1]) * scale, (lat - centre[0]) * 111_320)

    def to_latlon(xy):
        return (centre[0] + xy[1] / 111_320, centre[1] + xy[0] / scale)

    def distance(a, b):
        return math.hypot(a[0] - b[0], a[1] - b[1])

    return to_xy, distance, to_latlon


def bearing(origin, target):
    """Compass bearing in degrees from one projected point to another."""
    return math.degrees(math.atan2(target[0] - origin[0],
                                   target[1] - origin[1])) % 360


# ---------------------------------------------------------------------------
# Demand
# ---------------------------------------------------------------------------

# A cell is placed where the traffic is, and traffic is people. Both halves of
# where people are already exist in sim_data: dwellings carry unit counts and
# workplace sites carry a capacity, so the busy-hour surface is a blend rather
# than either one alone. A network planned only on residents misses the
# industrial park; one planned only on jobs misses every bedroom street.
DEMAND_CELL_M = 250
RESIDENT_WEIGHT = 0.55
WORKER_WEIGHT = 0.45
# People per dwelling unit, only to put the two halves on the same scale. The
# exact value does not matter — the surface is normalised — but the ratio
# between a home and a desk does.
PEOPLE_PER_UNIT = 2.5


def demand_surface(dwellings, workplaces, to_xy):
    """A dict of grid cell -> demand weight, and the centroid of each."""
    grid = defaultdict(float)
    centroids = defaultdict(lambda: [0.0, 0.0, 0.0])

    def add(lat, lon, weight):
        if not weight:
            return
        x, y = to_xy(lat, lon)
        key = (int(x // DEMAND_CELL_M), int(y // DEMAND_CELL_M))
        grid[key] += weight
        centroid = centroids[key]
        centroid[0] += x * weight
        centroid[1] += y * weight
        centroid[2] += weight

    for dwelling in dwellings["dwellings"]:
        add(dwelling["lat"], dwelling["lon"],
            RESIDENT_WEIGHT * (dwelling.get("units") or 1) * PEOPLE_PER_UNIT)
    for site in workplaces["site_records"]:
        add(site["lat"], site["lon"], WORKER_WEIGHT * (site.get("capacity") or 0))

    return grid, {key: (c[0] / c[2], c[1] / c[2])
                  for key, c in centroids.items() if c[2]}


# How built-up a place is, from how many buildings stand within the grid cell.
# This drives how far apart sites can be and how fast the signal decays, and it
# is measured from this city's own buildings rather than asserted — the same
# discipline intake/fit.py applies to the dwelling stock.
MORPHOLOGY = (
    # (buildings per km², label, target spacing between sites in metres)
    (1600, "dense urban", 600),
    (800, "urban", 900),
    (250, "suburban", 1500),
    (0, "open", 2600),
)

# Radius the density is measured over, and it has to be about the size of the
# area a cell serves rather than the plot the mast stands on. Measuring it over
# a single 250 m grid cell was a real error, and the fix is not merely a bigger
# window but a different question.
#
# Zoning puts masts on industrial land, depot yards, quarry edges and the strip
# beside a rail corridor — so a tower's own surroundings are empty almost by
# definition, and a third of Kierston's in-city structures have nearly no
# buildings within 750 m while serving dense blocks a kilometre away. What
# decides how the signal decays is the district between the mast and the
# handset, which is the scale set here.
MORPHOLOGY_RADIUS_M = 1200


def morphology(per_km2):
    """The label and target site spacing at a given building density."""
    for threshold, label, spacing in MORPHOLOGY:
        if per_km2 >= threshold:
            return label, spacing
    return MORPHOLOGY[-1][1], MORPHOLOGY[-1][2]


def building_density(buildings, to_xy):
    """Buildings per demand-grid cell."""
    density = Counter()
    for point in buildings["points"]:
        x, y = to_xy(point[0], point[1])
        density[(int(x // DEMAND_CELL_M), int(y // DEMAND_CELL_M))] += 1
    return density


def density_around(density, xy, radius=MORPHOLOGY_RADIUS_M):
    """Buildings per square kilometre within `radius` of a point."""
    reach = int(radius // DEMAND_CELL_M) + 1
    key = (int(xy[0] // DEMAND_CELL_M), int(xy[1] // DEMAND_CELL_M))
    total = sum(density.get((key[0] + dx, key[1] + dy), 0)
                for dx in range(-reach, reach + 1)
                for dy in range(-reach, reach + 1)
                if math.hypot(dx, dy) * DEMAND_CELL_M <= radius)
    return total / (math.pi * (radius / 1000) ** 2)


# ---------------------------------------------------------------------------
# Structures
# ---------------------------------------------------------------------------

# Which ASR structure types can actually carry a macro cell. A registered
# structure is not necessarily a cell site — the dump includes smokestacks,
# signs and broadcast masts — but almost all of these types either carry one or
# plausibly could, and the ones that cannot are excluded by name.
NOT_A_CELL_SITE = {"SIGN", "STACK"}

# A rooftop site needs a building tall enough to clear its surroundings. Three
# storeys is the floor; below that the antenna is looking at the side of the
# next building along.
ROOFTOP_MIN_LEVELS = 3
# And it goes on something commercial, civic or industrial. Antennas on the
# roof of a house are not a thing that happens, for planning reasons rather
# than radio ones.
ROOFTOP_CATEGORIES = {"commercial", "civic", "other"}
# Metres above the roof line that the antenna itself sits.
ROOFTOP_MAST_M = 4.0
# Assumed storey height where OSM gives levels but no height.
LEVEL_HEIGHT_M = 3.2

# Only the busier cells are worth a gap site. The demand rank a grid cell has
# to reach before an uncovered one gets a rooftop or a monopole. It was 0.82
# when the modelled sites were rooftops alone, and the network it produced
# had a median same-operator site spacing of 850 m: a macro grid with none
# of the short steel a real city has. Three fifths reaches the suburbs.
GAP_DEMAND_QUANTILE = 0.6
# The mast that fills a gap no building can: an ordinary suburban monopole.
GAP_MONOPOLE_M = 35.0
# A gap is a busy cell with no site within this share of the morphology's
# target spacing. Below one, so a district is filled to its planning grid
# rather than left at the edge of it.
GAP_SPACING_FACTOR = 0.85

# Small cells: street-level nodes in the built-up core. A grid cell gets one
# when it is dense or urban, its demand rank clears the quantile, and no
# small cell stands within the spacing. Real deployments run them a few
# hundred metres apart along the busy streets, one operator each.
SMALL_CELL_DEMAND_QUANTILE = 0.7
SMALL_CELL_MORPHOLOGY = {"dense urban", "urban"}
SMALL_CELL_SPACING_M = 300
# Not under a macro site, whose own sectors serve the pavement beneath.
SMALL_CELL_MACRO_CLEARANCE_M = 120
# A pole-top node: a lamp post height, and a fraction of a macro's power.
SMALL_CELL_HEIGHT_M = 9.0
SMALL_CELL_EIRP_DBM = {"mid": 50.0, "capacity": 52.0}
SMALL_CELL_DOWNTILT = 4.0


def levels_of(point):
    """Storeys, from the OSM tags if they are there."""
    tags = point[8] if len(point) > 8 and isinstance(point[8], dict) else {}
    for key in ("building:levels", "levels"):
        try:
            return int(float(tags[key]))
        except (KeyError, TypeError, ValueError):
            continue
    return 0


def height_of(point, levels):
    """Metres to the roof, from a tagged height or from the storey count."""
    tags = point[8] if len(point) > 8 and isinstance(point[8], dict) else {}
    try:
        return float(str(tags["height"]).split()[0])
    except (KeyError, TypeError, ValueError, IndexError):
        return levels * LEVEL_HEIGHT_M


def registered_structures(asr, city_radius, to_xy):
    """The real ones, as structure records."""
    structures = []
    for row in asr["structures"]:
        if row["structure_type"] in NOT_A_CELL_SITE:
            continue
        height = row["overall_height_agl_m"] or row["height_m"]
        if not height:
            continue
        structures.append({
            "id": f"asr/{row['asr']}",
            "source": "asr",
            "asr": row["asr"],
            "lat": row["lat"],
            "lon": row["lon"],
            "structure": row["structure"],
            "structure_type": row["structure_type"],
            "height_m": round(height, 1),
            "owner": row["owner"],
            "in_city": row["metres_from_centre"] <= city_radius,
            "xy": to_xy(row["lat"], row["lon"]),
        })
    return structures


def gap_structures(buildings, grid, centroids, density, existing, to_xy,
                   to_latlon, distance):
    """Sites for demand ASR cannot account for.

    Walks the busy grid cells worst-served first, and for each one that has no
    site inside its morphology's target spacing, puts an antenna on the
    tallest eligible building in it — or, where there is no such building, a
    monopole at the cell's demand centroid. Worst-first rather than in grid
    order because a site placed in one cell also serves its neighbours — going
    in order would over-build the first corner of the city and under-build
    the last.
    """
    if not grid:
        return []
    ranked = sorted(grid.values())
    floor = ranked[int(GAP_DEMAND_QUANTILE * (len(ranked) - 1))]

    # Candidate buildings, bucketed by the grid cell they stand in.
    candidates = defaultdict(list)
    for index, point in enumerate(buildings["points"]):
        category = buildings["categories"][point[2]]["id"] \
            if 0 <= point[2] < len(buildings["categories"]) else "other"
        if category not in ROOFTOP_CATEGORIES:
            continue
        levels = levels_of(point)
        if levels < ROOFTOP_MIN_LEVELS:
            continue
        x, y = to_xy(point[0], point[1])
        candidates[(int(x // DEMAND_CELL_M), int(y // DEMAND_CELL_M))].append(
            (height_of(point, levels), levels, index, point, (x, y)))

    placed = list(existing)
    modelled = []
    busy = sorted((weight, key) for key, weight in grid.items()
                  if weight >= floor)
    for _, key in reversed(busy):
        centre = centroids[key]
        _, spacing = morphology(density_around(density, centre))
        nearest = min((distance(centre, site["xy"]) for site in placed),
                      default=float("inf"))
        if nearest <= spacing * GAP_SPACING_FACTOR:
            continue
        pool = candidates.get(key)
        if pool:
            height, levels, index, point, xy = max(pool)
            structure = {
                "id": f"roof/{point[9] if len(point) > 9 else index}",
                "source": "modelled",
                "asr": None,
                "lat": point[0],
                "lon": point[1],
                "structure": "rooftop",
                "structure_type": "ROOF",
                "height_m": round(height + ROOFTOP_MAST_M, 1),
                "building_levels": levels,
                "owner": None,
                "in_city": True,
                "xy": xy,
            }
        else:
            lat, lon = to_latlon(centre)
            structure = {
                "id": f"mast/{key[0]}_{key[1]}",
                "source": "modelled",
                "asr": None,
                "lat": round(lat, 6),
                "lon": round(lon, 6),
                "structure": "monopole",
                "structure_type": "MTOWER",
                "height_m": GAP_MONOPOLE_M,
                "owner": None,
                "in_city": True,
                "xy": centre,
            }
        modelled.append(structure)
        placed.append(structure)
    return modelled


def small_cell_structures(grid, centroids, density, macros, to_latlon,
                          distance):
    """Street-pole nodes in the built-up core, one per busy block.

    Worst-first like the gap sites, but against other small cells rather
    than against the macro grid: a small cell is not filling a hole in
    coverage, it is adding capacity under a macro that already covers the
    street. The only thing it keeps clear of is the foot of a mast.
    """
    if not grid:
        return []
    ranked = sorted(grid.values())
    floor = ranked[int(SMALL_CELL_DEMAND_QUANTILE * (len(ranked) - 1))]
    busy = sorted((weight, key) for key, weight in grid.items()
                  if weight >= floor)
    nodes = []
    for _, key in reversed(busy):
        centre = centroids[key]
        label, _ = morphology(density_around(density, centre))
        if label not in SMALL_CELL_MORPHOLOGY:
            continue
        if any(distance(centre, node["xy"]) < SMALL_CELL_SPACING_M
               for node in nodes):
            continue
        if any(distance(centre, site["xy"]) < SMALL_CELL_MACRO_CLEARANCE_M
               for site in macros):
            continue
        lat, lon = to_latlon(centre)
        nodes.append({
            "id": f"node/{key[0]}_{key[1]}",
            "source": "modelled",
            "asr": None,
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "structure": "small cell",
            "structure_type": "POLE",
            "height_m": SMALL_CELL_HEIGHT_M,
            "owner": None,
            "in_city": True,
            "xy": centre,
        })
    return nodes


# ---------------------------------------------------------------------------
# Operators, tenancy and bands
# ---------------------------------------------------------------------------

# The four host networks, with the identifiers a cell actually broadcasts.
# These MCC/MNC pairs are the same ones devices.py provisions SIMs against —
# they have to be, because a phone attaches to the network its IMSI names, and
# a disagreement here would strand every subscriber in the city.
#
# `owns` is the regex-free substring set that recognises this operator's own
# structures in the ASR owner field. Verizon's local steel is registered to a
# "<city> SMSA Limited Partnership", which is the operating partnership and not
# a name anybody would guess.
OPERATORS = {
    "verizon": {
        "label": "Verizon", "mcc": "310", "mnc": "004",
        "owns": ("SMSA", "VERIZON", "CELLCO"), "share": 34,
    },
    "att": {
        "label": "AT&T", "mcc": "310", "mnc": "410",
        "owns": ("AT&T", "NEW CINGULAR"), "share": 30,
    },
    "tmobile": {
        "label": "T-Mobile", "mcc": "310", "mnc": "260",
        "owns": ("T-MOBILE", "STC ", "OMNIPOINT", "SPRINT"), "share": 30,
    },
    "boost": {
        "label": "Boost", "mcc": "313", "mnc": "340",
        "owns": (), "share": 12,
    },
}

# Structures owned by one of these are leased to anybody. This is most of the
# market and it is why AT&T can own nothing here and still be everywhere.
TOWER_COMPANIES = ("AMERICAN TOWER", "CCATT", "CROWN CASTLE", "SBA ",
                   "VERTICAL BRIDGE", "VB-", "VB ", "TUWAY", "PPL ")

# The odds an operator takes space on a structure, relative to its base share.
# An operator is far more likely to be on its own steel than on a competitor's,
# and a tower company's structure is neutral ground. The last case — a
# competitor's own tower — does happen and is rare, which is what makes the
# multiplier small rather than zero.
TENANCY_ODDS = {"own": 9.0, "towerco": 1.0, "competitor": 0.15, "other": 0.7}

# How many operators a structure ends up carrying is bounded by what fits.
# A tall lattice carries everybody; a utility pole carries one.
MAX_TENANTS = ((45, 4), (30, 3), (18, 2), (0, 1))

# The bands each operator actually runs, as (label, radio, downlink MHz, role).
# `anchor` is the low-band layer that provides the coverage floor and goes on
# every site. `capacity` layers go on the busier ones — C-band and 2.5 GHz are
# where the throughput is and where the cells are small.
#
# These are real US allocations. T-Mobile's 600 MHz n71 and 2.5 GHz n41 are the
# two that most distinguish it; AT&T's Band 14 is FirstNet, the public-safety
# allocation, which is worth carrying because traffic on it means something.
BANDS = {
    "verizon": (
        ("B13", "LTE", 751, "anchor"),
        ("B5", "LTE", 869, "anchor"),
        ("B2", "LTE", 1960, "mid"),
        ("B66", "LTE", 2130, "mid"),
        ("n5", "NR", 869, "anchor"),
        ("n77", "NR", 3700, "capacity"),
    ),
    "att": (
        ("B12", "LTE", 731, "anchor"),
        ("B14", "LTE", 763, "firstnet"),
        ("B2", "LTE", 1960, "mid"),
        ("B66", "LTE", 2130, "mid"),
        ("n5", "NR", 869, "anchor"),
        ("n77", "NR", 3700, "capacity"),
    ),
    "tmobile": (
        ("B12", "LTE", 731, "anchor"),
        ("B2", "LTE", 1960, "mid"),
        ("B66", "LTE", 2130, "mid"),
        ("n71", "NR", 617, "anchor"),
        # n41 is T-Mobile's workhorse and not a capacity top-up. It came out of
        # Sprint's 2.5 GHz holdings, it is on essentially every site they own,
        # and it is the reason their 5G footprint is the one that actually
        # carries traffic. Classing it as capacity put it on nine cells in the
        # whole city, which is not a network.
        ("n41", "NR", 2506, "mid"),
        ("n25", "NR", 1960, "mid"),
    ),
    "boost": (
        ("n71", "NR", 617, "anchor"),
        ("n70", "NR", 2180, "mid"),
        ("n77", "NR", 3450, "capacity"),
    ),
}

# Which roles a site carries, as the demand rank it has to clear. Every site
# gets its anchor layers; mid-band goes on all but the quietest edge sites; the
# C-band capacity layer reaches the busier half, which is what makes 5G
# throughput coverage patchy in the way it really is — the low-band 5G marker
# on a handset covers the whole city and means very little, while the layer
# that carries the traffic does not.
ROLE_DEMAND_FLOOR = {"anchor": 0.0, "firstnet": 0.0, "mid": 0.12,
                     "capacity": 0.45}

# Radiated power per sector, dBm, by role. Low band runs hot because it has to
# reach; C-band massive-MIMO arrays are higher still in the boresight but over
# a much narrower beam, which is the number quoted here.
EIRP_DBM = {"anchor": 62.0, "firstnet": 62.0, "mid": 64.0, "capacity": 66.0}
# A rooftop is lower and less powerful than a mast — it is filling a hole, not
# covering a district.
ROOFTOP_EIRP_PENALTY = 3.0

# Three sectors is the overwhelming norm for a macro site. A pole or a rooftop
# in a tight spot often runs fewer.
SECTORS_BY_STRUCTURE = {"rooftop": 3, "utility pole": 2, "pole": 3,
                        "monopole": 3, "small cell": 1}
DEFAULT_SECTORS = 3
# Horizontal half-power beamwidth of a three-sector panel.
BEAMWIDTH_DEG = 65.0


def tenancy(structure, demand_at, rng):
    """Which operators transmit from this structure.

    Ownership dominates and the rest is share. The result is deliberately not
    uniform: a Verizon-owned monopole nearly always carries Verizon and often
    nobody else, while a Crown Castle lattice carries whoever wanted the
    district.
    """
    owner = (structure["owner"] or "").upper()
    towerco = any(name in owner for name in TOWER_COMPANIES)

    # A small cell is one operator's node on a pole it leases from the city.
    # Nobody shares it and nobody leaves it empty, so it is a share-weighted
    # draw of exactly one tenant.
    if structure["structure"] == "small cell":
        keys = sorted(OPERATORS)
        return [rng.choices(keys, weights=[OPERATORS[k]["share"] for k in keys])[0]]

    weights = {}
    for key, operator in OPERATORS.items():
        if operator["owns"] and any(name in owner for name in operator["owns"]):
            relation = "own"
        elif towerco or structure["source"] == "modelled":
            relation = "towerco"
        elif owner and any(
                name in owner
                for other in OPERATORS.values() if other is not operator
                for name in other["owns"]):
            relation = "competitor"
        else:
            relation = "other"
        weights[key] = operator["share"] * TENANCY_ODDS[relation]

    capacity = next(n for height, n in MAX_TENANTS
                    if structure["height_m"] >= height)
    # A busy site is worth more to everybody, so it fills up; a mast at the edge
    # of the extent often carries one operator and no more.
    if demand_at < 0.2:
        capacity = min(capacity, 2)

    tenants, pool = [], dict(weights)
    # The owner is on its own structure, always. It did not build it to lease.
    for key, operator in OPERATORS.items():
        if operator["owns"] and any(name in owner for name in operator["owns"]):
            tenants.append(key)
            pool.pop(key, None)
    while pool and len(tenants) < capacity:
        keys = sorted(pool)
        chosen = rng.choices(keys, weights=[pool[k] for k in keys])[0]
        # Not everybody who could take space does. The draw decides presence
        # rather than merely order, or every structure would fill to capacity.
        if rng.random() < 0.72:
            tenants.append(chosen)
        pool.pop(chosen)
    return tenants


# ---------------------------------------------------------------------------
# Identifier allocation
# ---------------------------------------------------------------------------

# Where this city's identifiers live. See the module docstring: the block has
# to be clear of what the operators really use, because a cell identifier is a
# location claim and a real one would resolve to a real place that is not here.
#
# An LTE eNodeB identifier is 20 bits, so the space runs to 1,048,575. The
# observed maximum in this market is T-Mobile's 880,750, and AT&T sits in the
# twenty thousands. 950,000 upward is clear of both with room for four
# operators, and `validate` proves the clearance against the extract rather
# than trusting this comment.
ENB_BLOCK_BASE = 950_000
ENB_BLOCK_SIZE = 20_000
# A 5G NR cell identity is 36 bits and the split between gNodeB and cell is
# configurable; 12 bits of cell is the common choice and the one the OpenCelliD
# reader assumes. Observed local gNB ids reach 1,370,498, so this block sits an
# order of magnitude clear.
GNB_BLOCK_BASE = 30_000_000
GNB_BLOCK_SIZE = 500_000

# Tracking areas. A phone that is idle reports only its tracking area, never
# its cell, so this is the coarse location the network holds on most of its
# subscribers most of the time — which makes the number of them the single
# biggest lever on how much a CDR stream actually reveals. Real operators here
# run between two and five over an area this size.
TRACKING_AREAS = 3
TA_BLOCK_BASE = {"verizon": 41_000, "att": 42_000, "tmobile": 43_000,
                 "boost": 44_000}

# Physical cell identities. 504 of them in LTE, and the two rules that matter:
# no two cells sharing one within reuse distance of each other, and the three
# sectors of one site distinct modulo 3, because the reference signals of two
# cells that agree mod 3 collide and the handset cannot separate them.
PCI_COUNT = 504
PCI_REUSE_M = 3000


def allocate_stations(structures, tenants_by_structure):
    """A station identifier per (operator, structure), from this city's block.

    Consecutive within an operator and ordered by distance from the centre, so
    that neighbouring sites carry neighbouring identifiers. That is how real
    markets are numbered, and it is a property anything analysing a CDR stream
    may reasonably lean on.
    """
    stations = {}
    for index, key in enumerate(OPERATORS):
        base = ENB_BLOCK_BASE + index * ENB_BLOCK_SIZE
        nr_base = GNB_BLOCK_BASE + index * GNB_BLOCK_SIZE
        ordered = [s for s in structures if key in tenants_by_structure[s["id"]]]
        ordered.sort(key=lambda s: math.hypot(*s["xy"]))
        for offset, structure in enumerate(ordered):
            stations[(key, structure["id"])] = (base + offset, nr_base + offset)
    return stations


def tracking_areas(structures, to_xy):
    """Which tracking area each structure falls in, per operator.

    Geographic, because that is what a tracking area is: a contiguous district
    the network pages a phone across. Split on angle about the centre rather
    than by clustering — it produces contiguous wedges, and a real tracking
    area boundary is an arbitrary line through a city much like this one.
    """
    assignment = {}
    for structure in structures:
        x, y = structure["xy"]
        angle = math.degrees(math.atan2(x, y)) % 360
        assignment[structure["id"]] = int(angle / (360 / TRACKING_AREAS))
    return assignment


def assign_pci(cells, distance, seed):
    """A physical cell identity for every cell, honouring both reuse rules.

    Greedy and deliberately simple: walk the cells busiest-first and take the
    lowest identity that breaks nothing. Real planning tools do better, but the
    property that matters downstream is that the constraints hold, and
    `validate` checks that they do rather than assuming this got it right.

    Both constraints are *co-channel* and the planning is therefore per band,
    not per operator. Two cells on different frequencies cannot interfere with
    each other however close they sit or however their identities agree, and
    planning across bands would be not merely wasteful but impossible: three
    residues mod 3 cannot separate the dozen cells one operator runs at one
    site across four band layers.
    """
    by_channel = defaultdict(list)
    for cell in cells:
        by_channel[(cell["operator"], cell["radio"], cell["band"])].append(cell)

    for channel, group in by_channel.items():
        # Candidate order is shuffled per channel rather than ascending. With
        # a reuse floor of a few kilometres in a city ten across, almost
        # nothing conflicts, so always taking the lowest free identity packed
        # the whole network onto two dozen of the 504 and reused one of them a
        # hundred times over. Nothing about that is invalid and all of it is a
        # tell — real plans spread across the range, and a stream where every
        # cell reports a PCI under 30 is not one anybody recorded.
        rng = keyed(seed, stream_key(*channel), "pci")
        order = list(range(PCI_COUNT))
        rng.shuffle(order)

        taken = []
        for cell in group:
            site_pcis = [other["pci"] for other in taken
                         if other["structure"] == cell["structure"]
                         and "pci" in other]
            for candidate in order:
                if any(candidate % 3 == pci % 3 for pci in site_pcis):
                    continue
                if any(other["pci"] == candidate
                       and distance(cell["xy"], other["xy"]) < PCI_REUSE_M
                       for other in taken):
                    continue
                cell["pci"] = candidate
                break
            else:
                # Every identity is either colliding at the site or reused too
                # close. Take the least bad rather than leaving the cell
                # without one — a cell with no PCI is not a cell.
                cell["pci"] = min(
                    range(PCI_COUNT),
                    key=lambda c: min(
                        (distance(cell["xy"], other["xy"])
                         for other in taken if other["pci"] == c),
                        default=float("inf")))
            taken.append(cell)
    return by_channel


# ---------------------------------------------------------------------------
# Coverage
# ---------------------------------------------------------------------------

# An indicative radius per cell, which is not how the runtime will decide who
# is served — that is a path-loss calculation against a real position — but is
# what a map needs to draw and what the report needs to sanity-check spacing.
# Range falls with frequency and rises with antenna height, and the constants
# below reproduce the familiar shape: low band reaches two to three times as
# far as C-band from the same mast.
REFERENCE_FREQ_MHZ = 900.0
REFERENCE_HEIGHT_M = 40.0
BASE_RANGE_M = {"dense urban": 700, "urban": 1100,
                "suburban": 2000, "open": 3400}


def indicative_range(frequency, height, morphology_label):
    """Metres to the usable edge, as a planning estimate."""
    base = BASE_RANGE_M[morphology_label]
    frequency_factor = (REFERENCE_FREQ_MHZ / frequency) ** 0.75
    height_factor = (max(height, 8.0) / REFERENCE_HEIGHT_M) ** 0.35
    return round(base * frequency_factor * height_factor)


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------

def build(asr, opencellid, buildings, dwellings, workplaces, city, seed):
    """(structures, cells) — the physical network and what transmits from it."""
    centre = tuple(city.extent.center)
    to_xy, distance, to_latlon = projector(centre)

    grid, centroids = demand_surface(dwellings, workplaces, to_xy)
    density = building_density(buildings, to_xy)

    structures = registered_structures(asr, city.extent.radius_m, to_xy)
    structures += gap_structures(buildings, grid, centroids, density,
                                 structures, to_xy, to_latlon, distance)
    structures += small_cell_structures(grid, centroids, density, structures,
                                        to_latlon, distance)
    structures.sort(key=lambda s: math.hypot(*s["xy"]))

    def cell_key(xy):
        return (int(xy[0] // DEMAND_CELL_M), int(xy[1] // DEMAND_CELL_M))

    # The local demand each structure sits in, and the direction of the traffic
    # it should be pointed at.
    raw, aim, shape = {}, {}, {}
    for structure in structures:
        key = cell_key(structure["xy"])
        # Demand within a couple of grid cells, not just the one the mast
        # stands in — a tower in a car park serves the blocks around it.
        nearby = [(grid.get((key[0] + dx, key[1] + dy), 0.0),
                   centroids.get((key[0] + dx, key[1] + dy)))
                  for dx in range(-2, 3) for dy in range(-2, 3)]
        total = sum(weight for weight, _ in nearby)
        raw[structure["id"]] = total
        if total:
            x = sum(weight * point[0] for weight, point in nearby if point) / total
            y = sum(weight * point[1] for weight, point in nearby if point) / total
            aim[structure["id"]] = bearing(structure["xy"], (x, y))
        else:
            aim[structure["id"]] = 0.0
        shape[structure["id"]] = morphology(
            density_around(density, structure["xy"]))

    # Demand as a rank rather than as a fraction of the peak. The distinction
    # matters: one downtown block can carry twenty times the traffic of a good
    # suburban site, so dividing by the maximum pushes almost every site to
    # nearly zero and the band-layer thresholds below stop meaning anything.
    # A rank says "the busiest two fifths of sites", which is both what a
    # rollout plan actually says and a threshold that survives a second city.
    order = sorted(raw, key=lambda key: raw[key])
    local = {key: index / max(1, len(order) - 1)
             for index, key in enumerate(order)}

    tenants_by_structure = {}
    for structure in structures:
        rng = keyed(seed, stream_key(structure["id"]), "tenancy")
        tenants_by_structure[structure["id"]] = tenancy(
            structure, local[structure["id"]], rng)

    stations = allocate_stations(structures, tenants_by_structure)
    areas = tracking_areas(structures, to_xy)

    cells = []
    for structure in structures:
        label, _ = shape[structure["id"]]
        busy = local[structure["id"]]
        sectors = SECTORS_BY_STRUCTURE.get(structure["structure"],
                                           DEFAULT_SECTORS)
        first = aim[structure["id"]]

        for operator in tenants_by_structure[structure["id"]]:
            enb, gnb = stations[(operator, structure["id"])]
            rng = keyed(seed, enb, "cells")
            # The antenna sits below the top of the structure — there is a
            # lightning rod, and where several operators share a mast they are
            # stacked, so not everybody gets the summit.
            height = max(8.0, structure["height_m"] - rng.uniform(1.0, 6.0))
            area = (TA_BLOCK_BASE[operator] + areas[structure["id"]])

            small = structure["structure"] == "small cell"
            for band, radio, frequency, role in BANDS[operator]:
                if busy < ROLE_DEMAND_FLOOR[role]:
                    continue
                # A small cell carries the wide carriers and no coverage
                # layer: the macro above it already provides the floor, and
                # a low band on a lamp post would only interfere with it.
                if small and role not in SMALL_CELL_EIRP_DBM:
                    continue
                for sector in range(sectors):
                    azimuth = (first + sector * (360 / sectors)) % 360
                    if small:
                        eirp = SMALL_CELL_EIRP_DBM[role]
                    else:
                        eirp = EIRP_DBM[role]
                        if structure["structure"] == "rooftop":
                            eirp -= ROOFTOP_EIRP_PENALTY
                    station = enb if radio == "LTE" else gnb
                    # The cell identity within the station: the band picks the
                    # high nibble and the sector the low, so two cells of one
                    # site never collide and the identity is legible to anyone
                    # reading it.
                    index = BANDS[operator].index((band, radio, frequency, role))
                    local_id = index * 16 + sector
                    identity = (station << 8 | local_id) if radio == "LTE" \
                        else (station << 12 | local_id)
                    prefix = f"{OPERATORS[operator]['mcc']}{OPERATORS[operator]['mnc']}"
                    cells.append({
                        "id": f"{operator}/{station}/{local_id}",
                        "structure": structure["id"],
                        "operator": OPERATORS[operator]["label"],
                        "operator_key": operator,
                        "mcc": OPERATORS[operator]["mcc"],
                        "mnc": OPERATORS[operator]["mnc"],
                        "radio": radio,
                        "band": band,
                        "role": role,
                        "frequency_mhz": frequency,
                        "station_id": station,
                        "cell_id": local_id,
                        # The global identity a CDR carries: ECGI on LTE, NCGI
                        # on NR. Written out as the decimal the standards use.
                        "cgi": f"{prefix}-{area}-{identity}",
                        "identity": identity,
                        "tracking_area": area,
                        "sector": sector,
                        "azimuth": round(azimuth, 1),
                        # A single-sector node radiates all round.
                        "beamwidth": 360.0 if small else BEAMWIDTH_DEG,
                        # Electrical plus mechanical, steeper where the cell is
                        # small, which is how a dense site is kept from
                        # interfering with its neighbours.
                        "downtilt": SMALL_CELL_DOWNTILT if small
                        else round(2.0 + 6.0 * busy, 1),
                        "height_m": round(height, 1),
                        "eirp_dbm": round(eirp, 1),
                        "range_m": indicative_range(frequency, height, label),
                        "morphology": label,
                        "lat": structure["lat"],
                        "lon": structure["lon"],
                        "xy": structure["xy"],
                    })

    # Busiest first, so the greedy assignment spends its best identities where
    # interference actually costs something.
    cells.sort(key=lambda c: -local[c["structure"]])
    assign_pci(cells, distance, seed)
    cells.sort(key=lambda c: (c["operator_key"], c["station_id"], c["cell_id"]))

    for cell in cells:
        del cell["xy"]
    for structure in structures:
        del structure["xy"]
    return structures, cells


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def observed_ranges(opencellid):
    """Station identifier spans really in use here, per (operator, radio)."""
    spans = {}
    for row in opencellid.get("allocation", ()):
        if row["station_id_min"] is None:
            continue
        spans[(row["operator"], row["radio"])] = (row["station_id_min"],
                                                  row["station_id_max"])
    return spans


def validate(structures, cells, opencellid):
    """What a downstream join, and an honest location answer, are entitled to."""
    known = {s["id"] for s in structures}
    for cell in cells:
        if cell["structure"] not in known:
            raise RuntimeError(
                f"cell {cell['id']} transmits from {cell['structure']}, "
                f"which no structure record carries")
        if not 0 <= cell["azimuth"] < 360:
            raise RuntimeError(f"cell {cell['id']} points at {cell['azimuth']}")
        if not 0 <= cell["pci"] < PCI_COUNT:
            raise RuntimeError(f"cell {cell['id']} has PCI {cell['pci']}")

    identities = [cell["cgi"] for cell in cells]
    if len(identities) != len(set(identities)):
        duplicated = [k for k, n in Counter(identities).items() if n > 1]
        raise RuntimeError(
            f"{len(duplicated)} cell global identities issued twice: "
            f"{duplicated[:3]}")

    # The three sectors of one site must differ modulo 3, or their reference
    # signals collide and no handset can tell them apart.
    by_site = defaultdict(list)
    for cell in cells:
        by_site[(cell["structure"], cell["operator_key"], cell["radio"],
                 cell["band"])].append(cell)
    for key, group in by_site.items():
        residues = [cell["pci"] % 3 for cell in group]
        if len(group) <= 3 and len(set(residues)) != len(group):
            raise RuntimeError(
                f"sectors at {key} share a PCI residue mod 3: "
                f"{[cell['pci'] for cell in group]}")

    # And the allocation has to stay clear of the real one. This is the check
    # the module docstring's argument rests on, so it is a check and not a
    # comment: a station identifier inside an observed span would make a cell
    # in this city resolve to a real transmitter somewhere else.
    spans = observed_ranges(opencellid)
    for cell in cells:
        for (operator, radio), (low, high) in spans.items():
            if radio != cell["radio"]:
                continue
            if low <= cell["station_id"] <= high:
                raise RuntimeError(
                    f"station {cell['station_id']} ({cell['operator']} "
                    f"{radio}) falls inside the {low}–{high} range observed "
                    f"for {operator} in this market")


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

def report(structures, cells, opencellid, asr):
    """Everything worth failing a build over, printed."""
    real = [s for s in structures if s["source"] == "asr"]
    modelled = Counter(s["structure"] for s in structures
                       if s["source"] == "modelled")
    print(f"{len(structures):,} structures carrying {len(cells):,} cells\n")
    print(f"  {len(real):,} registered with the FCC "
          f"({asr['file_creation_date']}); modeled below ASR's 200 ft "
          f"threshold: "
          + ", ".join(f"{n} {label}{'s' if n != 1 else ''}"
                      for label, n in modelled.most_common()))
    inside = sum(1 for s in structures if s["in_city"])
    print(f"  {inside:,} stand inside the city radius")

    print("\nstructure type:")
    for label, count in Counter(s["structure"] for s in structures).most_common():
        print(f"  {label:<18} {count:>4}")

    print("\nstructure owner (registered only):")
    for label, count in Counter(
            s["owner"] or "unknown" for s in real).most_common(8):
        print(f"  {count:>4}  {label}")

    print("\ntenants per structure:")
    tenants = Counter()
    for cell in cells:
        tenants[(cell["structure"], cell["operator_key"])] = 1
    per_structure = Counter()
    for structure_id, _ in tenants:
        per_structure[structure_id] += 1
    spread = Counter(per_structure.values())
    for count in sorted(spread):
        print(f"  {count} operator{'s' if count > 1 else ' '}   "
              f"{spread[count]:>4} structures")
    occupied = sum(per_structure.values())
    print(f"  {occupied / max(1, len(per_structure)):.2f} tenants per occupied "
          f"structure (US tower companies: 2.2-2.4)")
    empty = len(structures) - len(per_structure)
    if empty:
        print(f"  {empty} carry no cells (ASR includes masts that were never "
              f"cell sites)")

    print("\noperator:")
    for key, operator in OPERATORS.items():
        own = [c for c in cells if c["operator_key"] == key]
        sites = len({c["structure"] for c in own})
        print(f"  {operator['label']:<10} {len(own):>5} cells on {sites:>3} sites")

    print("\nradio and band:")
    for label, count in Counter(
            f"{c['radio']} {c['band']}" for c in cells).most_common():
        print(f"  {label:<10} {count:>5}")
    print("  no GSM or UMTS (US 3G shut down in 2022; none in the "
          "OpenCelliD extract)")

    # Split by whether the mast stands inside the city, because the aggregate
    # on its own reads as a bug. Nearly half the structures the extract reaches
    # sit in the open county outside the radius, serving the approaches —
    # and "open" is the right answer for those, not a misclassification of
    # somewhere built up.
    print("\nmorphology of the district each cell serves:")
    in_city = {s["id"] for s in structures if s["in_city"]}
    for label, name in (("in the city", True), ("outside the radius", False)):
        subset = [c for c in cells if (c["structure"] in in_city) == name]
        if not subset:
            continue
        spread = Counter(c["morphology"] for c in subset).most_common()
        print(f"  {label:<20} " + ", ".join(f"{k} {v}" for k, v in spread))

    print("\nindicative range by band role (meters):")
    for role in ("anchor", "firstnet", "mid", "capacity"):
        ranges = sorted(c["range_m"] for c in cells if c["role"] == role)
        if ranges:
            print(f"  {role:<10} median {ranges[len(ranges) // 2]:>5}  "
                  f"min {ranges[0]:>5}  max {ranges[-1]:>5}")

    print("\nidentifier allocation:")
    spans = observed_ranges(opencellid)
    for (operator, radio), (low, high) in sorted(spans.items()):
        print(f"  observed  {operator:<22} {radio:<3} {low:>9,} – {high:>9,}")
    for key, operator in OPERATORS.items():
        for radio in ("LTE", "NR"):
            own = [c["station_id"] for c in cells
                   if c["operator_key"] == key and c["radio"] == radio]
            if own:
                print(f"  issued    {operator['label']:<22} {radio:<3} "
                      f"{min(own):>9,} – {max(own):>9,}")
    print("  no issued block overlaps an observed one")

    print("\ntracking areas:")
    for key, operator in OPERATORS.items():
        own = sorted({c["tracking_area"] for c in cells
                      if c["operator_key"] == key})
        if own:
            print(f"  {operator['label']:<10} {own}")
    print("  idle handsets report their tracking area, not their cell")

    print("\nphysical cell identities:")
    pcis = Counter(c["pci"] for c in cells)
    print(f"  {len(pcis)} of {PCI_COUNT} in use, most reused "
          f"{max(pcis.values())} times")
    print(f"  reuse distance floor {PCI_REUSE_M} m, mod-3 distinct within every "
          f"site (checked in validate())")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--out", type=Path, default=TOWERS)
    args = parser.parse_args()

    require(ASR_TOWERS,
            "run reference/build/build_asr_towers.py")
    require(OPENCELLID,
            "run reference/build/build_opencellid.py --token <token>")
    for path in (BUILDINGS, DWELLINGS, WORKPLACES):
        require(path, "run the earlier stages first")

    asr = json.loads(ASR_TOWERS.read_text())
    opencellid = json.loads(OPENCELLID.read_text())
    buildings = json.loads(BUILDINGS.read_text())
    dwellings = json.loads(DWELLINGS.read_text())
    workplaces = json.loads(WORKPLACES.read_text())
    city = city_profile.load()

    structures, cells = build(asr, opencellid, buildings, dwellings,
                              workplaces, city, args.seed)
    validate(structures, cells, opencellid)

    args.out.write_text(json.dumps({
        "seed": args.seed,
        "city": city.slug,
        "centre": list(city.extent.center),
        "structures_source": {
            "source": asr["source"],
            "url": asr["url"],
            "license": asr["license"],
            "file_creation_date": asr["file_creation_date"],
            "note": asr["note"],
        },
        "identifiers_source": {
            "source": opencellid["source"],
            "license": opencellid["license"],
            "retrieved": opencellid["retrieved"],
            "note": "Read for identifier allocation only. This city's station "
                    "identifiers are allocated clear of every range observed "
                    "here, because a cell identifier names a place and a real "
                    "one would name the wrong place.",
        },
        # Real, and derived, named apart. A consumer is entitled to know which
        # structures are evidence and which are inference.
        "surveyed": ["lat", "lon", "height_m", "structure", "owner"],
        "modelled": ["tenancy", "sector", "azimuth", "downtilt", "band",
                     "eirp_dbm", "station_id", "cell_id", "tracking_area",
                     "pci", "range_m"],
        "structures": len(structures),
        "cells": len(cells),
        "structure_records": structures,
        "cell_records": cells,
    }, separators=(",", ":")))

    print(f"towers.json ({args.out.stat().st_size / 1e6:.1f} MB)\n")
    report(structures, cells, opencellid, asr)


if __name__ == "__main__":
    main()
