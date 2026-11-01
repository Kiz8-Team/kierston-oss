"""Site the city's ALPR fleet from measured traffic on an exported day."""

import argparse
import heapq
import json
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import profile as city_profile
from paths import CAMERAS, CAR_GRAPH, POIS, day_export, require
from surveillance.roadflow import Flow, Graph, Projector, bearing

BUDGET = 74
TRANCHES = {"cordon": 22, "arterial": 40, "commercial": 12}


ARTERIAL_CLASSES = ("primary", "primary_link", "secondary", "secondary_link",
                    "tertiary", "tertiary_link", "unclassified")
CORDON_CLASSES = ARTERIAL_CLASSES + ("motorway", "motorway_link", "trunk",
                                     "trunk_link", "residential")

CORDON_RANK = {name: index for index, name in enumerate((
    "motorway", "trunk", "primary", "secondary", "motorway_link", "trunk_link",
    "tertiary", "unclassified", "primary_link", "secondary_link", "residential"))}

JUNCTION_DEGREE = 5

ARTERIAL_FLOOR = 250

MIN_SEPARATION_M = 120.0
MAX_PER_MOUNT = 3

POLE_HEIGHT_M = 4.2
MAST_ARM_HEIGHT_M = 5.6
STOREFRONT_HEIGHT_M = 3.8

COMMERCIAL_WEIGHT = {
    "shop=mall": 10.0,
    "amenity=hospital": 8.0,
    "shop=supermarket": 6.0,
    "shop=department_store": 6.0,
    "shop=doityourself": 5.0,
    "shop=wholesale": 4.0,
    "amenity=fuel": 3.0,
    "amenity=bank": 1.5,
}
COMMERCIAL_SNAP_M = 220.0

FALCON = {
    "id": "falcon",
    "label": "Solar pole-mounted ALPR camera",
    "capture_width_m": 4.57,
    "capture_distance_m": 19.81,
    "capture_fov_deg": 13.2,
    "body_mm": [222, 127, 73],
    "mass_kg": 1.36,
    "mount": "band_clamp",
    "power": "solar",
    "backhaul": "lte",
    "note": "Field of view is the published capture zone — where a plate "
            "resolves — not the angle the sensor sees. One unit covers about "
            "one lane.",
}

MUNICIPAL_OWNER = "Kierston Police Department"
VENDOR = "Sentinel Road Systems"


def approach(graph, flow, edge):
    source = int(graph.source[edge])
    target = int(graph.target[edge])
    cost = float(graph.cost[edge])
    speed = float(graph.length[edge]) / cost if cost > 0 else 0.0
    return {
        "edge": int(edge),
        "from_node": source,
        "to_node": target,
        "to_lat": round(float(graph.lat[target]), 7),
        "to_lon": round(float(graph.lon[target]), 7),
        "street": graph.street(edge) or None,
        "class": graph.road_class(edge),
        "length_m": round(float(graph.length[edge]), 1),
        "azimuth": round(bearing(graph, edge), 1),
        "daily_passes": int(flow.passes[edge]),
        "distinct_drivers": int(flow.driver_offset[edge + 1]
                                - flow.driver_offset[edge]),
        "free_flow_mps": round(speed, 2),
        "zone_seconds": round(FALCON["capture_distance_m"] / speed, 2)
        if speed > 0 else None,
    }


def cordon_candidates(graph, flow, projector, radius_m):
    radius = projector.radius(np.asarray(graph.lat), np.asarray(graph.lon))
    inside = radius < radius_m
    source = graph.source
    target = graph.target.astype(np.int64)
    inbound = (~inside[source]) & inside[target]
    routable = ((graph.component[source] == graph.meta["largestComponent"])
                & (graph.component[target] == graph.meta["largestComponent"]))
    eligible = np.isin(graph.classId, [graph.classes.index(name)
                                       for name in CORDON_CLASSES
                                       if name in graph.classes])
    best = {}
    for edge in np.nonzero(inbound & eligible & routable)[0]:
        name = graph.road_class(edge)
        # A named highway crosses the cordon twice. Grouping on its name alone
        # made its two approaches compete for one camera, leaving an entire
        # inbound direction unwatched. The radial sector distinguishes the two
        # ends while still collapsing parallel ramps at one approach.
        x, y = projector.xy(float(graph.lat[target[edge]]),
                            float(graph.lon[target[edge]]))
        sector = round((math.degrees(math.atan2(x, y)) % 360) / 15) % 24
        corridor = (graph.street(edge) or f"<{name}>", name, sector)
        current = best.get(corridor)
        if current is None or flow.passes[edge] > flow.passes[current]:
            best[corridor] = int(edge)
    ranked = sorted(best.items(),
                    key=lambda item: (CORDON_RANK.get(item[0][1], 99),
                                      -int(flow.passes[item[1]])))
    return [edge for _, edge in ranked]


def arterial_candidates(graph, flow):
    eligible = np.isin(graph.classId, [graph.classes.index(name)
                                       for name in ARTERIAL_CLASSES
                                       if name in graph.classes])
    busy = flow.passes >= ARTERIAL_FLOOR
    junction = graph.degree[graph.source] >= JUNCTION_DEGREE
    return np.nonzero(eligible & busy & junction)[0]


def commercial_candidates(graph, flow, projector, pois):
    types = pois["groups"]
    label = {}
    for group in types:
        for entry in group["types"]:
            label[entry["i"]] = entry["id"]

    nodes_xy = np.stack(projector.xy(np.asarray(graph.lat), np.asarray(graph.lon)), axis=1)
    out = []
    for point in pois["points"]:
        lat, lon, _group, kind, name = point[0], point[1], point[2], point[3], point[4]
        address = point[5] if len(point) > 5 else ""
        weight = COMMERCIAL_WEIGHT.get(label.get(kind))
        if weight is None:
            continue
        x, y = projector.xy(lat, lon)
        distance = np.hypot(nodes_xy[:, 0] - x, nodes_xy[:, 1] - y)
        node = int(distance.argmin())
        if distance[node] > COMMERCIAL_SNAP_M:
            continue
        lo, hi = int(graph.offset[node]), int(graph.offset[node + 1])
        if hi <= lo:
            continue
        edge = max(range(lo, hi), key=lambda slot: int(flow.passes[slot]))
        passes = int(flow.passes[edge])
        if passes == 0:
            continue
        score = weight * math.log1p(passes)
        out.append((score, int(edge), name or "Unnamed site",
                    label.get(kind), address, float(distance[node]), passes))
    out.sort(key=lambda row: -row[0])
    return out


class Sites:
    def __init__(self, graph, projector):
        self.graph = graph
        self.xy = np.stack(projector.xy(np.asarray(graph.lat),
                                        np.asarray(graph.lon)), axis=1)
        self.at = {}
        self.blocked = set()

    def allows(self, node):
        if node in self.at:
            return self.at[node] < MAX_PER_MOUNT
        return node not in self.blocked

    def take(self, node):
        if node not in self.at:
            self.at[node] = 0
            near = np.nonzero(np.hypot(self.xy[:, 0] - self.xy[node, 0],
                                       self.xy[:, 1] - self.xy[node, 1])
                              < MIN_SEPARATION_M)[0]
            self.blocked.update(int(other) for other in near if int(other) != node)
        self.at[node] += 1


def greedy_coverage(flow, candidates, sites, graph, budget, covered):
    heap = []
    for edge in candidates:
        gain = int((~covered[flow.drivers(edge)]).sum())
        if gain:
            heapq.heappush(heap, (-gain, int(edge)))

    chosen = []
    while heap and len(chosen) < budget:
        stale, edge = heapq.heappop(heap)
        node = int(graph.source[edge])
        if not sites.allows(node):
            continue
        drivers = flow.drivers(edge)
        gain = int((~covered[drivers]).sum())
        if not gain:
            continue
        if heap and -gain > heap[0][0]:
            heapq.heappush(heap, (-gain, edge))
            continue
        covered[drivers] = True
        sites.take(node)
        chosen.append((edge, gain))
    return chosen


def build(graph, flow, pois, city):
    projector = Projector(tuple(city.extent.center))
    sites = Sites(graph, projector)
    covered = np.zeros(flow.person_count, dtype=bool)

    picks = []
    taken_edges = set()

    for edge in cordon_candidates(graph, flow, projector, city.extent.radius_m):
        if len(picks) >= TRANCHES["cordon"]:
            break
        node = int(graph.source[edge])
        if not sites.allows(node):
            continue
        sites.take(node)
        taken_edges.add(int(edge))
        covered[flow.drivers(edge)] = True
        picks.append(("cordon", int(edge)))

    interior = [edge for edge in arterial_candidates(graph, flow)
                if int(edge) not in taken_edges]
    for edge, _gain in greedy_coverage(flow, interior, sites, graph,
                                       TRANCHES["arterial"], covered):
        taken_edges.add(int(edge))
        picks.append(("arterial", int(edge)))

    private = 0
    for _score, edge, name, kind, address, snap, _passes in commercial_candidates(
            graph, flow, projector, pois):
        if private >= TRANCHES["commercial"]:
            break
        node = int(graph.source[edge])
        if edge in taken_edges or not sites.allows(node):
            continue
        sites.take(node)
        taken_edges.add(int(edge))
        covered[flow.drivers(edge)] = True
        picks.append(("commercial", int(edge), name, kind, address,
                      round(snap, 1)))
        private += 1

    return assemble(graph, flow, projector, picks, covered)


def assemble(graph, flow, projector, picks, covered):
    mounts = {}
    mount_records = []
    camera_records = []
    owner_kind_of = {}

    for index, pick in enumerate(picks):
        role, edge = pick[0], pick[1]
        node = int(graph.source[edge])
        if node not in mounts:
            if role == "commercial":
                kind, height, owner, owner_kind = (
                    "storefront", STOREFRONT_HEIGHT_M, pick[2], "private")
            elif graph.degree[node] >= JUNCTION_DEGREE + 2:
                kind, height, owner, owner_kind = (
                    "mast_arm", MAST_ARM_HEIGHT_M, MUNICIPAL_OWNER, "police")
            else:
                kind, height, owner, owner_kind = (
                    "pole", POLE_HEIGHT_M, MUNICIPAL_OWNER, "police")
            mounts[node] = f"MNT-{len(mounts) + 1:03d}"
            owner_kind_of[node] = owner_kind
            mount_records.append({
                "id": mounts[node],
                "node": node,
                "lat": round(float(graph.lat[node]), 7),
                "lon": round(float(graph.lon[node]), 7),
                "kind": kind,
                "height_m": height,
                "owner": owner,
                "owner_kind": owner_kind,
            })

        record = {
            "id": f"ALPR-{index + 1:03d}",
            "mount": mounts[node],
            "role": role,
            "owner_kind": owner_kind_of[node],
            "reads": "rear",
            "optics": FALCON["id"],
            **approach(graph, flow, edge),
        }
        if role == "commercial":
            record["site"] = pick[2]
            record["site_type"] = pick[3]
            record["address"] = pick[4] or record["street"]
            record["site_distance_m"] = pick[5]
        else:
            record["address"] = record["street"]
            record["network"] = VENDOR
        camera_records.append(record)

    return mount_records, camera_records, int(covered.sum())


def validate(mounts, cameras):
    if len(cameras) != BUDGET:
        raise RuntimeError(f"sited {len(cameras)} cameras against a budget of {BUDGET}")
    by_mount = {}
    for camera in cameras:
        by_mount.setdefault(camera["mount"], []).append(camera)
    for mount, group in by_mount.items():
        if len(group) > MAX_PER_MOUNT:
            raise RuntimeError(f"{mount} carries {len(group)} cameras")
        edges = {camera["edge"] for camera in group}
        if len(edges) != len(group):
            raise RuntimeError(f"{mount} has two cameras on one approach")
    for camera in cameras:
        if not 0 <= camera["azimuth"] < 360:
            raise RuntimeError(f"{camera['id']} points at {camera['azimuth']}")
    placed = {mount["node"] for mount in mounts}
    if len(placed) != len(mounts):
        raise RuntimeError("two mounts share a node")


def coverage(flow, cameras):
    seen = np.zeros(flow.person_count, dtype=bool)
    curve = []
    for camera in cameras:
        seen[flow.drivers(camera["edge"])] = True
        curve.append(int(seen.sum()))

    roles = {}
    for role in ("cordon", "arterial", "commercial"):
        seen[:] = False
        for camera in cameras:
            if camera["role"] == role:
                seen[flow.drivers(camera["edge"])] = True
        roles[role] = int(seen.sum())

    return curve, roles


def report(graph, flow, mounts, cameras, reached, curve):
    from collections import Counter

    print(f"\n{len(cameras)} cameras on {len(mounts)} mounts, "
          f"sited from {flow.date}\n")

    print(f"{'role':12} {'n':>3} {'passes/day':>11} {'drivers seen':>13}")
    for role in ("cordon", "arterial", "commercial"):
        group = [c for c in cameras if c["role"] == role]
        if not group:
            continue
        seen = set()
        for camera in group:
            seen.update(flow.drivers(camera["edge"]).tolist())
        print(f"{role:12} {len(group):3d} "
              f"{sum(c['daily_passes'] for c in group):11,} {len(seen):13,}")
    print(f"{'total':12} {len(cameras):3d} "
          f"{sum(c['daily_passes'] for c in cameras):11,} {reached:13,}")
    quiet = sum(1 for c in cameras
                if c["role"] == "cordon" and c["daily_passes"] == 0)
    if quiet:
        print(f"\n{quiet} cordon cameras on corridors with no measured "
              f"traffic on {flow.date} (cordon keeps major approaches)")
    print(f"\n{reached:,} of {flow.distinct_drivers:,} drivers "
          f"({100 * reached / flow.distinct_drivers:.1f}%) pass at least one "
          f"camera on an ordinary day")

    print("\nmounts:")
    for kind, count in Counter(m["kind"] for m in mounts).most_common():
        print(f"  {kind:12} {count:3d}")
    print("owners:")
    for owner, count in Counter(m["owner"] for m in mounts).most_common():
        print(f"  {owner:32} {count:3d}")

    print("\nroad classes watched:")
    for name, count in Counter(c["class"] for c in cameras).most_common():
        print(f"  {name:16} {count:3d}")

    print("\ncordon:")
    for camera in cameras:
        if camera["role"] != "cordon":
            continue
        print(f"  {camera['id']}  {camera['class']:14} "
              f"{(camera['street'] or '—')[:30]:30} "
              f"az {camera['azimuth']:5.1f}  {camera['daily_passes']:6,}/day")

    print("\ntop ten arterials by added coverage:")
    shown = 0
    for camera in cameras:
        if camera["role"] != "arterial" or shown >= 10:
            continue
        print(f"  {camera['id']}  {camera['class']:14} "
              f"{(camera['street'] or '—')[:30]:30} "
              f"az {camera['azimuth']:5.1f}  {camera['daily_passes']:6,}/day  "
              f"{camera['distinct_drivers']:6,} drivers")
        shown += 1

    print("\ncoverage added per budget tranche:")
    print(f"  {'cameras':>7} {'drivers seen':>13} {'share':>7} {'added':>8}")
    previous = 0
    for index in (1, 5, 10, 20, 30, 40, 50, 60, BUDGET):
        total = curve[index - 1]
        print(f"  {index:7d} {total:13,} "
              f"{100 * total / flow.distinct_drivers:6.1f}% {total - previous:8,}")
        previous = total

    print(f"\noptics: {FALCON['label']}")
    print(f"  capture zone {FALCON['capture_width_m']} m wide at "
          f"{FALCON['capture_distance_m']} m ({FALCON['capture_fov_deg']}°, "
          f"about one lane)")
    dwell = [c["zone_seconds"] for c in cameras if c["zone_seconds"]]
    fast = min(dwell); slow = max(dwell)
    print(f"  free-flow time in zone {fast:.1f}–{slow:.1f} s "
          f"(median {sorted(dwell)[len(dwell) // 2]:.1f} s)")
    depression = math.degrees(math.atan(
        POLE_HEIGHT_M / FALCON["capture_distance_m"]))
    print(f"  far edge of zone {depression:.0f}° below horizontal at "
          f"{POLE_HEIGHT_M} m pole height")
    print("  lane counts not in the road graph; unread share of wide "
          "approaches unknown")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--date", default=None,
                        help="exported day to site from (default: most recent)")
    parser.add_argument("--out", type=Path, default=CAMERAS)
    args = parser.parse_args()
    args.out.parent.mkdir(parents=True, exist_ok=True)

    require(CAR_GRAPH, "cd kierston/pathfinder && bun run build-graph")
    day = day_export(args.date)
    require(POIS, "run the intake stages first")

    city = city_profile.load()
    graph = Graph(CAR_GRAPH)
    flow = Flow(graph, day)
    pois = json.loads(POIS.read_text())

    mounts, cameras, reached = build(graph, flow, pois, city)
    validate(mounts, cameras)
    curve, role_drivers = coverage(flow, cameras)

    args.out.write_text(json.dumps({
        "city": city.slug,
        "centre": list(city.extent.center),
        "budget": BUDGET,
        "tranches": TRANCHES,
        "sited_from": {
            "day": flow.date,
            "graph": CAR_GRAPH.name,
            "vehicle_legs": flow.vehicle_legs,
            "edge_traversals": flow.matched,
            "unresolved_traversals": flow.unmatched,
            "distinct_drivers": flow.distinct_drivers,
            "note": "Traffic is measured from one exported day, not modelled. "
                    "Includes resident legs and the external vehicle stream; "
                    "cordon approaches are separated by radial sector so the "
                    "two ends of one named highway remain independently watched.",
        },
        "modelled": ["role", "azimuth", "mount", "height_m", "owner", "network"],
        "measured": ["daily_passes", "distinct_drivers", "free_flow_mps",
                     "zone_seconds"],
        "published": ["capture_width_m", "capture_distance_m", "capture_fov_deg",
                      "body_mm", "mass_kg"],
        "optics": {FALCON["id"]: FALCON},
        "drivers_reached": reached,
        "drivers_by_role": role_drivers,
        "coverage_curve": curve,
        "mounts": len(mounts),
        "cameras": len(cameras),
        "mount_records": mounts,
        "camera_records": cameras,
    }, separators=(",", ":")))

    print(f"cameras.json ({args.out.stat().st_size / 1e3:.0f} kB)")
    report(graph, flow, mounts, cameras, reached, curve)


if __name__ == "__main__":
    main()
