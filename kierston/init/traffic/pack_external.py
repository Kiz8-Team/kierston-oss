"""Pack recurring external traffic into the KEXT section embedded in KSIM."""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from population.pack_population import Packer, Table  # noqa: E402
from paths import SIM_DATA  # noqa: E402


SOURCE = SIM_DATA / "external_traffic.json"
OUTPUT = SIM_DATA / "external_traffic.bin"
MAGIC = b"KEXT"


def mask(days):
    value = 0
    for day in days:
        value |= 1 << day
    return value


def main():
    if not SOURCE.exists():
        raise SystemExit("external_traffic.json is missing — run external_traffic first")
    data = json.loads(SOURCE.read_text())
    vehicles = data["vehicles"]
    destinations = data["destinations"]
    rules = data["plate_rules"]
    market = data["market"]

    tables = {name: Table() for name in (
        "id", "kind", "state", "plate", "make", "model", "body", "colour",
        "destination_id", "destination_label", "destination_kind", "destination_source",
        "patterns",
    )}
    packer = Packer(MAGIC)
    add_enum = lambda name, values: packer.add(
        name, "u32", (tables[name].id(value) for value in values))

    add_enum("id", (row["id"] for row in vehicles))
    add_enum("kind", (row["kind"] for row in vehicles))
    add_enum("state", (row["state"] for row in vehicles))
    add_enum("plate", (row["plate"] for row in vehicles))
    packer.add("plate_sides", "u8", (
        (1 if "rear" in row["plate_sides"] else 0)
        | (2 if "front" in row["plate_sides"] else 0) for row in vehicles))
    add_enum("make", (row["make"] for row in vehicles))
    add_enum("model", (row["model"] for row in vehicles))
    add_enum("body", (row["body"] for row in vehicles))
    add_enum("colour", (row["colour"] for row in vehicles))
    packer.add("model_year", "u16", (row["model_year"] for row in vehicles))
    packer.add("home_bearing", "f32", (row["home_bearing"] for row in vehicles))
    packer.add("destination", "u32", (row["destination"] for row in vehicles))
    packer.add("arrival_minute", "u16", (row["arrival_minute"] for row in vehicles))
    packer.add("dwell_minutes", "u16", (row["dwell_minutes"] for row in vehicles))
    packer.add("weekday_mask", "u8", (mask(row["weekdays"]) for row in vehicles))
    packer.add("frequency", "f32", (row["frequency"] for row in vehicles))

    add_enum("destination_id", (row["id"] for row in destinations))
    add_enum("destination_label", (row["label"] for row in destinations))
    add_enum("destination_kind", (row["kind"] for row in destinations))
    add_enum("destination_source", (row["source"] for row in destinations))
    packer.add("destination_lat", "f64", (row["lat"] for row in destinations))
    packer.add("destination_lon", "f64", (row["lon"] for row in destinations))
    packer.add("destination_weight", "u32", (row["weight"] for row in destinations))

    packer.add("rule_state", "u32", (tables["state"].id(row["code"]) for row in rules))
    packer.add("rule_front", "u8", (int(row["front"]) for row in rules))
    packer.add("rule_tier", "u8", (row["tier"] for row in rules))
    packer.add("rule_bearing", "f32", (
        float("nan") if row["bearing"] is None else row["bearing"] for row in rules))
    add_enum("patterns", ("|".join(row["patterns"]) for row in rules))

    packer.add("market_make", "u32", (tables["make"].id(row["make"]) for row in market))
    packer.add("market_model", "u32", (tables["model"].id(row["model"]) for row in market))
    packer.add("market_body", "u32", (tables["body"].id(row["body"]) for row in market))
    packer.add("market_colour", "u32", (tables["colour"].id(row["colour"]) for row in market))
    packer.add("market_model_year", "u16", (row["model_year"] for row in market))

    for name, table in tables.items():
        packer.add_strings(name, table.values[1:])

    size = packer.write(OUTPUT, {
        "source": SOURCE.name,
        "builtAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "version": data["version"], "seed": data["seed"], "city": data["city"],
        "centre": data["centre"], "radius_m": data["radius_m"],
        "rates": data["rates"], "provenance": data["source"],
        "counts": {
            "vehicles": len(vehicles), "destinations": len(destinations),
            "plateRules": len(rules), "marketSpecimens": len(market),
        },
        "stringTables": sorted(tables),
    })
    print(f"external_traffic.bin ({size / 1e6:.2f} MB): "
          f"{len(vehicles):,} vehicles, {len(destinations):,} destinations, "
          f"{len(rules)} plate jurisdictions")


if __name__ == "__main__":
    main()
