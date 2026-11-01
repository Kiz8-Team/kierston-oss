"""Reverse geocode the POIs that OSM has no address tags for.

Nominatim's usage policy caps us at one request per second, so a full pass over
the export takes over an hour. Every answer is written to a cache keyed by OSM
id, and the script resumes from that cache, so it can be stopped and restarted.
"""

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "init"))

from paths import GEOCODE_CACHE as CACHE, POIS_EXPORT as INPUT  # noqa: E402

ENDPOINT = "https://nominatim.openstreetmap.org/reverse"
USER_AGENT = "Kierston/0.1 (POI address enrichment)"
# The policy limit is 1 req/s; the margin keeps us clear of it under jitter.
INTERVAL_SECONDS = 1.1
# Zoom 18 resolves to a building or house-number level result rather than the
# enclosing suburb, which is the granularity an address needs.
ZOOM = 18
# Written back to disk this often so a long run never loses much work.
FLUSH_EVERY = 25

# Nominatim spreads the locality across these depending on what is mapped.
CITY_KEYS = ("city", "town", "village", "hamlet", "municipality", "suburb", "county")


def has_address_tags(tags):
    return "addr:street" in tags or "addr:housenumber" in tags


def position(element):
    if "lat" in element and "lon" in element:
        return element["lat"], element["lon"]
    center = element.get("center")
    if center:
        return center["lat"], center["lon"]
    return None


def pending(elements, cache):
    """Elements with no address tags and no cache entry yet, in file order."""
    todo = []
    for element in elements:
        key = f"{element['type']}/{element['id']}"
        if key in cache:
            continue
        if has_address_tags(element.get("tags") or {}):
            continue
        where = position(element)
        if where is None:
            continue
        todo.append((key, where))
    return todo


def reverse(lat, lon):
    query = urllib.parse.urlencode({
        "format": "jsonv2", "lat": lat, "lon": lon,
        "zoom": ZOOM, "addressdetails": 1,
    })
    request = urllib.request.Request(
        f"{ENDPOINT}?{query}", headers={"User-Agent": USER_AGENT},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read())


def condense(payload):
    """Keep only the fields the map needs, so the cache stays small."""
    address = (payload or {}).get("address") or {}
    if not address:
        return {}
    city = next((address[key] for key in CITY_KEYS if address.get(key)), "")
    return {
        "house_number": address.get("house_number", ""),
        "road": address.get("road", ""),
        "city": city,
        "state": (address.get("ISO3166-2-lvl4") or "").removeprefix("US-") or address.get("state", ""),
        "postcode": address.get("postcode", ""),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, help="stop after this many lookups")
    args = parser.parse_args()

    elements = json.loads(INPUT.read_text())["elements"]
    cache = json.loads(CACHE.read_text()) if CACHE.exists() else {}
    todo = pending(elements, cache)
    if args.limit:
        todo = todo[: args.limit]

    print(f"{len(cache):,} cached, {len(todo):,} to look up "
          f"(~{len(todo) * INTERVAL_SECONDS / 60:.0f} min)", flush=True)

    done = 0
    failures = 0
    for key, (lat, lon) in todo:
        started = time.monotonic()
        try:
            cache[key] = condense(reverse(lat, lon))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            failures += 1
            print(f"  {key}: {error}", flush=True)
            # Leave it uncached so the next run retries it, but back off in case
            # the failure is the server asking us to slow down.
            time.sleep(5)
        else:
            done += 1
            if done % FLUSH_EVERY == 0:
                CACHE.write_text(json.dumps(cache))
                print(f"  {done:,}/{len(todo):,}", flush=True)
        time.sleep(max(0.0, INTERVAL_SECONDS - (time.monotonic() - started)))

    CACHE.write_text(json.dumps(cache))
    resolved = sum(1 for value in cache.values() if value.get("road"))
    print(f"\n{done:,} looked up ({failures} failed), {len(cache):,} in cache, "
          f"{resolved:,} with a street. Wrote {CACHE}")


if __name__ == "__main__":
    main()
