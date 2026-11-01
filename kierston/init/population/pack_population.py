"""Pack the synthetic population into flat typed arrays for the tools to read.

population.json is 28 MB of text that costs a browser several seconds and a few
hundred MB of heap to parse into objects. The same data as typed arrays is
around 6 MB and decodes in one pass with no per-record work at all, which is
the difference between an inspector that opens instantly and one you avoid.

The container is the one `pathfinder/src/graph.ts` already uses, so both
binaries in sim_data read the same way:

    "KPOP"                     4 bytes
    header length              u32, little-endian
    header                     JSON — counts, provenance, array directory
    padding                    to an 8-byte boundary
    arrays                     raw little-endian typed arrays, back to back

Strings never sit in the header. Building ids and addresses alone would put
2 MB of JSON in front of the data and undo the point of the exercise, so every
string table is packed the same way a CSR adjacency is — a u32 offset array and
one blob of UTF-8 — and the columns that reference them store an index.

Households point at persons through an offset array rather than repeating a
household id per person. `persons[offset[h] : offset[h + 1]]` is one household,
contiguous in memory, which is the same trick the road graph uses for the edges
leaving a node.
"""

import array
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from paths import SIM_DATA  # noqa: E402
POPULATION = SIM_DATA / "population.json"
DWELLINGS = SIM_DATA / "dwellings.json"
OUTPUT = SIM_DATA / "population.bin"

MAGIC = b"KPOP"

# array typecodes, checked against their documented widths at import.
KINDS = {"u8": "B", "u16": "H", "u32": "I", "i32": "i", "f32": "f", "f64": "d"}
WIDTHS = {"u8": 1, "u16": 2, "u32": 4, "i32": 4, "f32": 4, "f64": 8}
for _kind, _code in KINDS.items():
    assert array.array(_code).itemsize == WIDTHS[_kind], _kind


def align8(value):
    return (value + 7) & ~7


class Packer:
    """Collects named columns, then serialises them into one buffer.

    `magic` is the four bytes the container opens with. It is a parameter
    rather than a constant because the personal-records packer writes the same
    layout under its own tag, and a reader that accepted either would happily
    decode a population as a docket file.
    """

    def __init__(self, magic=MAGIC):
        self.arrays = []
        self.magic = magic

    def add(self, name, kind, values):
        self.arrays.append((name, kind, array.array(KINDS[kind], values)))

    def add_strings(self, name, values):
        """Store a string table as offsets plus one UTF-8 blob.

        Index 0 is always the empty string, so a column can use 0 to mean
        "not applicable" without a separate null mask.
        """
        blob = bytearray()
        offsets = [0]
        for value in values:
            blob.extend(value.encode())
            offsets.append(len(blob))
        self.add(f"{name}_offset", "u32", offsets)
        self.add(f"{name}_bytes", "u8", blob)

    def write(self, path, meta):
        directory, byte_offset = [], 0
        for name, kind, values in self.arrays:
            directory.append({
                "name": name, "kind": kind,
                "length": len(values), "byteOffset": byte_offset,
            })
            byte_offset = align8(byte_offset + values.buffer_info()[1] * values.itemsize)

        header = json.dumps({**meta, "arrays": directory},
                            separators=(",", ":")).encode()
        data_start = align8(8 + len(header))
        out = bytearray(data_start + byte_offset)
        out[0:4] = self.magic
        out[4:8] = len(header).to_bytes(4, "little")
        out[8:8 + len(header)] = header
        for spec, (_, _, values) in zip(directory, self.arrays):
            start = data_start + spec["byteOffset"]
            out[start:start + values.itemsize * len(values)] = values.tobytes()
        path.write_bytes(out)
        return len(out)


class Table:
    """Interns values into a string table, returning a stable index."""

    def __init__(self):
        self.values = [""]
        self.index = {"": 0}

    def id(self, value):
        if value is None:
            return 0
        if value not in self.index:
            self.index[value] = len(self.values)
            self.values.append(value)
        return self.index[value]


def person_columns(packer, prefix, people, tables):
    """The attribute columns shared by household members and quarters residents."""
    packer.add(f"{prefix}_age", "u8", (p["age"] for p in people))
    packer.add(f"{prefix}_sex", "u8", (p["sex"] for p in people))
    packer.add(f"{prefix}_race", "u8", (tables["race"].id(p["race_ethnicity"]) for p in people))
    packer.add(f"{prefix}_relationship", "u8", (p["relationship"] for p in people))
    packer.add(f"{prefix}_education", "u8", (p["education"] for p in people))
    packer.add(f"{prefix}_employment", "u8", (p["employment"] for p in people))
    # Income is None for under-15s, whom PUMS never asked. The binary format
    # has no null, and for anything downstream that spends or earns money a
    # child holds nothing, so they pack as 0. The distinction between "no
    # income" and "not asked" survives in population.json for anything
    # computing a marginal, where it does matter.
    packer.add(f"{prefix}_income", "i32", (p["income"] or 0 for p in people))
    packer.add(f"{prefix}_occupation", "u16", (tables["occupation"].id(p["occupation"]) for p in people))
    packer.add(f"{prefix}_industry", "u16", (tables["industry"].id(p["industry"]) for p in people))
    packer.add(f"{prefix}_soc", "u16", (tables["soc"].id(p["soc"]) for p in people))


def main() -> None:
    population = json.loads(POPULATION.read_text())
    stock = json.loads(DWELLINGS.read_text())

    households = population["household_records"]
    persons = population["person_records"]
    quarters = population["quarters_records"]
    if any(h.get("dwelling") is None for h in households):
        raise SystemExit("households are unplaced — run assign_dwellings.py first")

    # Buildings come along so the tools need one file, not three. Dwellings and
    # quarters share an index space; quarters sit after the dwelling stock.
    buildings = stock["dwellings"] + stock["quarters"]
    building_index = {b["id"]: i for i, b in enumerate(buildings)}

    tables = {name: Table() for name in
              ("race", "occupation", "industry", "soc", "kind", "source", "id", "address")}
    packer = Packer()

    packer.add("building_lat", "f64", (b["lat"] for b in buildings))
    packer.add("building_lon", "f64", (b["lon"] for b in buildings))
    packer.add("building_units", "u16", (b.get("units", 0) for b in buildings))
    packer.add("building_kind", "u8", (tables["kind"].id(b["kind"]) for b in buildings))
    packer.add("building_id", "u32", (tables["id"].id(b["id"]) for b in buildings))
    packer.add("building_address", "u32", (tables["address"].id(b["address"]) for b in buildings))

    # Persons are written in household order, so one offset array replaces a
    # household id on every person row. Guard the assumption rather than trust it.
    offsets, cursor = [0], 0
    for household in households:
        cursor += household["size"]
        offsets.append(cursor)
    if cursor != len(persons) or any(
            p["household"] != h for h, (start, end) in
            enumerate(zip(offsets, offsets[1:])) for p in persons[start:end]):
        raise SystemExit("person records are not grouped by household in order")

    packer.add("household_building", "u32", (building_index[h["dwelling"]] for h in households))
    packer.add("household_unit", "u16", (h["unit"] for h in households))
    packer.add("household_area", "f32", (h["unit_area"] for h in households))
    packer.add("household_income", "i32", (h["income"] for h in households))
    packer.add("household_size", "u8", (h["size"] for h in households))
    packer.add("household_source", "u16", (tables["source"].id(h["source"]) for h in households))
    packer.add("household_person", "u32", offsets)

    person_columns(packer, "person", persons, tables)

    packer.add("quarters_building", "u32", (building_index[q["dwelling"]] for q in quarters))
    person_columns(packer, "quarters", quarters, tables)

    for name, table in tables.items():
        packer.add_strings(name, table.values[1:])

    size = packer.write(OUTPUT, {
        "source": POPULATION.name,
        "builtAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "seed": population["seed"],
        "placementSeed": population.get("placement_seed"),
        "counts": {
            "buildings": len(buildings),
            "dwellingBuildings": len(stock["dwellings"]),
            "households": len(households),
            "persons": len(persons),
            "quarters": len(quarters),
        },
        # Every _offset/_bytes pair above is one of these, listed so a reader
        # can rebuild the tables without guessing from names.
        "stringTables": sorted(tables),
    })

    before = POPULATION.stat().st_size
    print(f"{len(buildings):,} buildings  {len(households):,} households  "
          f"{len(persons):,} people  {len(quarters):,} in quarters")
    print("\ncolumns:")
    for name, kind, values in packer.arrays:
        print(f"  {name:<24} {kind:<4} {len(values):>9,}  "
              f"{len(values) * values.itemsize / 1e6:6.2f} MB")
    print(f"\nWrote {OUTPUT} ({size / 1e6:.1f} MB) — "
          f"{before / 1e6:.1f} MB as JSON, {before / size:.1f}× smaller")


if __name__ == "__main__":
    main()
