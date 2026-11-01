"""Extract this city's antenna structures from the FCC ASR database.

A distillation script, in the sense `build_tac_table.py` and
`build_vehicle_market.py` are: it turns a bulk public download into a small
committed asset and is not run by an ordinary build. Nothing in the pipeline
fetches anything — the extract this writes is stored with the city's other
inputs in `init-inputs.tar.zst` and read from there.

It lives here rather than in `acquire/` because `acquire/` is for the helpers a
user runs interactively against a credentialed or rate-limited service. This
needs no key, produces a forty-kilobyte file, and wants running once per city
and then never again.

What ASR is
-----------
The Antenna Structure Registration database is the FCC's record of physical
structures that carry antennas. It is a weekly full dump, public domain, and
needs no credentials — one URL and no key. Each registration carries a real
coordinate, a real height, a structure type code and the name of whoever owns
the steel.

That last field is the reason this is worth having rather than modelling. The
owner is usually *not* a carrier: Crown Castle, American Towers, SBA and
Vertical Bridge own the structures and lease space on them, which is why
colocation is the norm and why a tower's owner tells you almost nothing about
who transmits from it. Around Kierston, AT&T owns no structures at all and is
nonetheless on the air from dozens of sites.

What it cannot tell you
-----------------------
Registration is only required for structures over 60.96 m (200 ft) or sited
near an airport. Every rooftop site and every short monopole is therefore
absent by construction, and in a downtown those are most of the deployment. So
this file is a floor on the real count and not a census, and `init/network/
towers.py` adds the rooftops the demand surface implies.

It also says nothing about antennas: no sectors, no azimuths, no bands, no cell
identifiers. A structure is a mast, not a network.

Registrations that were granted but never built are dropped here — the RA
record's status has to be `C` for constructed. Roughly one in seven is not.
"""

import argparse
import io
import json
import math
import sys
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "init"))

import profile as city_profile  # noqa: E402
from paths import ASR_TOWERS as OUTPUT  # noqa: E402

SOURCE = "https://data.fcc.gov/download/pub/uls/complete/r_tower.zip"

# The dump is pipe-delimited with no header. Every record type carries the
# unique system identifier in field 4, which is what joins them; the fields
# below are the ones this extract keeps, by position.
UID = 4
CO_TYPE, CO_LAT, CO_LON = 5, 6, 11        # type, then the two DMS runs
RA_STATUS, RA_CITY, RA_STATE = 15, 24, 25
RA_HEIGHT, RA_GROUND, RA_OVERALL, RA_OVERALL_AMSL = 28, 29, 30, 31
RA_STRUCTURE = 32
# When the structure was built, which around Kierston runs back to 1941. Worth
# carrying: a 1960s lattice on high ground is a legacy broadcast site that
# cellular later leased space on, and a 2020s monopole in a retail park is a
# capacity build. The two are different objects and the date is what separates
# them.
RA_CONSTRUCTED = 12
# The free-text description of where the structure stands, and the single most
# useful field in the record. It routinely names the host outright —
# "(Hope United Church of Christ) 1031 Flexer Avenue" is a steeple site, a bare
# street address with several house numbers is a rooftop — which is a better
# answer than any inference from the structure type code alone.
RA_LOCATION = 23
RA_COUNTY, RA_ZIP = 26, 27
# Painting and lighting: the FAA advisory-circular chapters this structure is
# obliged to follow. Whether a mast is lit and how is a visible physical fact
# about it.
RA_LIGHTING = 37
EN_ROLE, EN_NAME, EN_FRN = 5, 9, 8

# The contact-person fields — 17 through 22, and the phone and email columns of
# EN.dat — are deliberately never read. They are real named individuals at
# Crown Castle, PPL and T-Mobile with their work numbers and addresses
# attached, and live personal data about real people has no place in a
# synthetic city. The structures are public infrastructure; the staff who
# filed for them are not.

# Structures outside the city still serve inside it — a mast 6 km out covers
# the edge of a 5 km radius on low band — so the extract runs wider than the
# city and lets the placement stage decide what is relevant.
MARGIN_M = 3000

# What the FCC's structure type codes mean. Not exhaustive: the codes that
# appear around Kierston, plus the common ones that do not, so a second city
# does not immediately hit an unknown. Anything unlisted passes through as-is.
STRUCTURE_TYPES = {
    "MTOWER": "monopole", "TOWER": "tower", "LTOWER": "lattice",
    "GTOWER": "guyed", "POLE": "pole", "UPOLE": "utility pole",
    "BANT": "building antenna", "BTWR": "building tower", "MAST": "mast",
    "STACK": "smokestack", "TANK": "water tank", "BPIPE": "building pipe",
    "NNGTANN": "non-guyed", "PIPE": "pipe", "SIGN": "sign",
}


def dms(fields, start):
    """Degrees, minutes, seconds and a hemisphere, as a signed decimal degree.

    ASR stores coordinates the way a surveyor writes them rather than the way
    anything consumes them. The four fields run consecutively from `start`.
    """
    degrees, minutes, seconds, direction = fields[start:start + 4]
    value = int(degrees) + int(minutes) / 60 + float(seconds) / 3600
    return -value if direction in ("S", "W") else value


def metres(lat, lon, centre):
    """Planar distance in metres. Fine at this scale and cheaper than haversine."""
    dy = (lat - centre[0]) * 111_320
    dx = (lon - centre[1]) * 111_320 * math.cos(math.radians(centre[0]))
    return math.hypot(dx, dy)


def rows(archive, name):
    """Every record in one .dat, split on the delimiter.

    latin-1 rather than utf-8: the dump carries the occasional high byte in an
    owner's name, and a decode error part-way through a 67 MB file would lose
    the whole extract over one apostrophe.
    """
    with archive.open(name) as handle:
        for line in io.TextIOWrapper(handle, encoding="latin-1"):
            yield line.rstrip("\n").split("|")


def extract(archive, centre, radius):
    """Constructed structures within `radius` of `centre`, joined across three files.

    Coordinates first, because that is the only filter that cuts the file down
    to something worth joining — 202,000 registrations nationally against a few
    dozen here. The bounding-box test before the distance one is not
    micro-optimisation: it skips the trigonometry on 99.9% of the rows.
    """
    span = radius / 111_320 * 1.5
    located = {}
    for fields in rows(archive, "CO.dat"):
        if len(fields) < 16 or fields[CO_TYPE] != "T":
            continue
        try:
            lat, lon = dms(fields, CO_LAT), dms(fields, CO_LON)
        except (ValueError, IndexError):
            continue
        if abs(lat - centre[0]) > span or abs(lon - centre[1]) > span * 1.4:
            continue
        distance = metres(lat, lon, centre)
        if distance <= radius:
            located[fields[UID]] = (fields[3], lat, lon, distance)

    registrations = {f[UID]: f for f in rows(archive, "RA.dat")
                     if len(f) > RA_LIGHTING and f[UID] in located}
    owners = {f[UID]: (f[EN_NAME], f[EN_FRN]) for f in rows(archive, "EN.dat")
              if len(f) > EN_NAME and f[UID] in located and f[EN_ROLE] == "O"}

    structures = []
    for uid, (registration, lat, lon, distance) in located.items():
        fields = registrations.get(uid)
        # A registration with no RA record, or one that was granted and never
        # built, is not a structure anybody can hang an antenna on.
        if not fields or fields[RA_STATUS] != "C":
            continue
        # Space-padded to a fixed width in the dump — "TOWER " and "POLE  " are
        # what the bytes say. Stripping here rather than at every read site is
        # the difference between a lookup table that works and one that
        # silently misses on four codes in five.
        code = fields[RA_STRUCTURE].strip()
        owner, frn = owners.get(uid, ("", ""))

        def number(index):
            try:
                return float(fields[index])
            except (ValueError, IndexError):
                return None

        def text(index):
            try:
                return fields[index].strip() or None
            except IndexError:
                return None

        structures.append({
            "asr": registration,
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "metres_from_centre": round(distance),
            "structure_type": code,
            "structure": STRUCTURE_TYPES.get(code, code.lower()),
            "height_m": number(RA_HEIGHT),
            "overall_height_agl_m": number(RA_OVERALL),
            # Terrain, and therefore a real propagation input: two masts of the
            # same height do not cover the same ground if one stands ninety
            # metres higher up.
            "ground_elevation_m": number(RA_GROUND),
            "overall_height_amsl_m": number(RA_OVERALL_AMSL),
            "constructed": text(RA_CONSTRUCTED),
            "location_description": text(RA_LOCATION),
            "lighting_spec": text(RA_LIGHTING),
            "owner": owner.strip() or None,
            # The FCC Registration Number of the owning entity. A real
            # corporate identifier, and the thing to join on rather than the
            # name — "T-Mobile Northeast LLC" and "STC Five LLC" are one
            # company and two strings.
            "owner_frn": frn.strip() or None,
            "city": fields[RA_CITY].strip(),
            "state": fields[RA_STATE].strip(),
            "county_fips": text(RA_COUNTY),
            "zip": text(RA_ZIP),
        })
    structures.sort(key=lambda row: row["metres_from_centre"])
    return structures


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=OUTPUT)
    parser.add_argument("--margin", type=int, default=MARGIN_M,
                        help="search margin beyond the city radius, in meters")
    args = parser.parse_args()

    city = city_profile.load()
    centre = tuple(city.extent.center)
    radius = city.extent.radius_m + args.margin

    print(f"downloading {SOURCE}")
    with urllib.request.urlopen(SOURCE) as response:
        payload = response.read()
    print(f"  {len(payload) / 1e6:.1f} MB")

    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        created = next((line.split(":", 1)[1].strip()
                        for line in archive.read("counts").decode().splitlines()
                        if line.startswith("File Creation Date")), None)
        structures = extract(archive, centre, radius)

    inside = sum(1 for s in structures
                 if s["metres_from_centre"] <= city.extent.radius_m)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps({
        "source": "FCC Antenna Structure Registration, weekly complete dump",
        "url": SOURCE,
        "file_creation_date": created,
        "license": "US federal government work, public domain",
        "centre": list(centre),
        "radius_m": radius,
        "city_radius_m": city.extent.radius_m,
        "note": "Constructed structures only. ASR registers structures over "
                "60.96 m (200 ft) or near an airport, so rooftop and short "
                "monopole sites are absent by construction and are modelled by "
                "init/network/towers.py. The owner is the structure's, which "
                "for a tower company is not who transmits from it.",
        "count": len(structures),
        "within_city_radius": inside,
        "structures": structures,
    }, indent=1))

    print(f"\n{args.out}")
    print(f"  {len(structures)} constructed structures within {radius / 1000:.0f} km, "
          f"{inside} inside the {city.extent.radius_m / 1000:.0f} km city radius")


if __name__ == "__main__":
    main()
