"""Footprint area and centroid for Overpass `out geom` elements.

Shared by the aggregation scripts: both need to place a building, and one also
needs its floor area. Overpass emits `geometry` only under `out geom`; an
`out center` export carries a bounding-box centre instead and never reaches
this module.
"""

from math import cos, radians


def ring_metrics(ring):
    """Return (area m², (lat, lon) centroid) for one closed ring, or None.

    Equirectangular projection about the ring's own centre — over a
    building-sized ring the distortion is far below the tagging noise.
    """
    if not ring or len(ring) < 4:
        return None
    # Project about the ring's own centre, not the equator. Absolute metres put
    # a Kierston building 6.3 million metres from the origin, where the shoelace
    # cross products land around 1e13 and float64 has no precision left at the
    # metre scale — centroids came out ~25 m adrift before this was local, which
    # is further than most of these buildings are wide.
    lat0 = sum(point["lat"] for point in ring) / len(ring)
    lon0 = sum(point["lon"] for point in ring) / len(ring)
    # Metres per degree at this latitude, WGS84 close enough for a footprint.
    x_scale = 111320.0 * cos(radians(lat0))
    points = [((p["lon"] - lon0) * x_scale, (p["lat"] - lat0) * 110540.0)
              for p in ring]
    if points[0] != points[-1]:
        points.append(points[0])

    twice = cx = cy = 0.0
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        cross = x0 * y1 - x1 * y0
        twice += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    if twice == 0:
        return None
    # Area-weighted centroid, so an L-shaped footprint still lands on itself.
    # Offsets are relative to (lat0, lon0), so shift back to absolute degrees.
    return abs(twice) / 2.0, (lat0 + cy / (3 * twice) / 110540.0,
                              lon0 + cx / (3 * twice) / x_scale)


def footprint(element):
    """Return (area m² or None, (lat, lon)) for a building, or None.

    Ways carry a single ring. Relations are multipolygons: outer rings minus
    the inner ones, positioned on the largest outer ring. Standalone nodes have
    no footprint at all and fall back to their own position.
    """
    if element["type"] == "way":
        return ring_metrics(element.get("geometry"))

    if element["type"] == "relation":
        outer, inner = [], 0.0
        for member in element.get("members", []):
            metrics = ring_metrics(member.get("geometry"))
            if metrics is None:
                continue
            if member.get("role") == "inner":
                inner += metrics[0]
            else:
                outer.append(metrics)
        if outer:
            area = max(0.0, sum(a for a, _ in outer) - inner)
            return area, max(outer)[1]
        # A multipolygon whose outer ring is split across several open member
        # ways — Overpass emits the segments unstitched, and assembling them is
        # more machinery than one bank building is worth. The bounding-box
        # centre still places it, which is all a point map needs; area is left
        # unknown rather than guessed.
        return bounds_centre(element)

    if "lat" in element and "lon" in element:
        return None, (element["lat"], element["lon"])
    return bounds_centre(element)


def bounds_centre(element):
    """Return (None, (lat, lon)) from an element's bounding box, or None."""
    bounds = element.get("bounds")
    if not bounds:
        return None
    return None, ((bounds["minlat"] + bounds["maxlat"]) / 2,
                  (bounds["minlon"] + bounds["maxlon"]) / 2)
