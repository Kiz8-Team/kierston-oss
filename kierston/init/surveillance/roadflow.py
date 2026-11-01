import json
import math

import numpy as np

_LON_SPAN = 400_000_000
_LON_BIAS = 200_000_000

_KIND = {"f64": np.float64, "f32": np.float32, "u32": np.uint32,
         "u8": np.uint8, "i32": np.int32}

DRIVEN_MODES = ("car", "cab", "other")


def _align8(value):
    return (value + 7) & ~7


def _keys(lat_e6, lon_e6):
    return lat_e6.astype(np.int64) * _LON_SPAN + (lon_e6.astype(np.int64) + _LON_BIAS)


def _envelope(path, magic):
    buffer = np.memmap(path, dtype=np.uint8, mode="r")
    found = buffer[:4].tobytes()
    if found != magic:
        raise SystemExit(f"{path} is not a {magic.decode()} file (magic {found!r})")
    length = int(np.frombuffer(buffer[4:8].tobytes(), dtype="<u4")[0])
    header = json.loads(buffer[8:8 + length].tobytes())
    return buffer, header, _align8(8 + length)


class Graph:
    def __init__(self, path):
        buffer, meta, start = _envelope(path, b"KPF1")
        self.meta = {k: v for k, v in meta.items() if k != "arrays"}
        for spec in meta["arrays"]:
            setattr(self, spec["name"], np.frombuffer(
                buffer, dtype=_KIND[spec["kind"]], count=spec["length"],
                offset=start + spec["byteOffset"]))
        self.node_count = meta["nodeCount"]
        self.edge_count = meta["edgeCount"]
        self.names = meta["names"]
        self.classes = meta["classes"]
        self.source = np.repeat(np.arange(self.node_count, dtype=np.int64),
                                np.diff(self.offset.astype(np.int64)))
        self.degree = np.bincount(self.source, minlength=self.node_count) \
            + np.bincount(self.target.astype(np.int64), minlength=self.node_count)

    def street(self, edge):
        return self.names[self.nameId[edge]]

    def road_class(self, edge):
        return self.classes[self.classId[edge]]


class Projector:
    def __init__(self, centre):
        self.lat0, self.lon0 = centre
        self.mx = 111_320.0 * math.cos(math.radians(self.lat0))
        self.my = 111_320.0

    def xy(self, lat, lon):
        return (lon - self.lon0) * self.mx, (lat - self.lat0) * self.my

    def radius(self, lat, lon):
        x, y = self.xy(lat, lon)
        return np.hypot(x, y)


def bearing(graph, edge):
    u, v = int(graph.source[edge]), int(graph.target[edge])
    lat1, lon1 = float(graph.lat[u]), float(graph.lon[u])
    lat2, lon2 = float(graph.lat[v]), float(graph.lon[v])
    dy = (lat2 - lat1) * 111_320.0
    dx = (lon2 - lon1) * 111_320.0 * math.cos(math.radians((lat1 + lat2) / 2))
    return math.degrees(math.atan2(dx, dy)) % 360.0


class Flow:
    def __init__(self, graph, day_path, chunk=4_000_000):
        buffer, meta, start = _envelope(day_path, b"KDAY")
        columns = {spec["name"]: (_KIND[spec["type"]], spec["count"],
                                  start + spec["byteOffset"])
                   for spec in meta["columns"]}

        def column(name):
            dtype, count, offset = columns[name]
            return np.frombuffer(buffer, dtype=dtype, count=count, offset=offset)

        def optional(name):
            return column(name) if name in columns else None

        self.date = meta["date"]
        self.version = meta["version"]
        modes = meta["enums"]["mode"]
        purposes = meta["enums"]["purpose"]

        mode = column("leg.mode")
        purpose = column("leg.purpose")
        path_offset = column("leg.pathOffset").astype(np.int64)
        path_count = column("leg.pathCount").astype(np.int64)

        driven = np.isin(mode, [modes.index(name) for name in DRIVEN_MODES])
        driven |= (mode == modes.index("bus")) & (purpose == purposes.index("run"))
        external_trip_vehicle = optional("externalTrip.vehicle")
        external_vehicle_count = int(meta.get("counts", {}).get("externalVehicles", 0))
        external_trip_count = 0 if external_trip_vehicle is None else int(external_trip_vehicle.shape[0])
        self.vehicle_legs = int(driven.sum()) + external_trip_count
        self.total_legs = int(mode.shape[0]) + external_trip_count
        self.external_vehicles = external_vehicle_count

        leg_offset = column("person.legOffset").astype(np.int64)
        leg_count = column("person.legCount").astype(np.int64)
        has = leg_count > 0
        ends = np.cumsum(leg_count[has])
        slot = np.repeat(leg_offset[has], leg_count[has]) + (
            np.arange(int(ends[-1])) - np.repeat(ends - leg_count[has], leg_count[has]))
        person_of_leg = np.full(mode.shape[0], -1, dtype=np.int64)
        person_of_leg[slot] = np.repeat(np.nonzero(has)[0], leg_count[has])
        resident_count = int(leg_offset.shape[0])
        # The coverage index is a physical road-user identity. Resident traffic
        # retains its historical person id; external traffic follows it with a
        # vehicle id because no resident person exists for those movements.
        self.person_count = resident_count + external_vehicle_count

        # KDAY is written by JavaScript's Math.round, whose half case goes
        # toward +infinity. np.round uses ties-to-even; nodes sitting exactly
        # on a half microdegree therefore failed to join their own exported
        # path, especially at the newly forced boundary gateways.
        node_key = _keys(np.floor(graph.lat * 1e6 + 0.5).astype(np.int64),
                         np.floor(graph.lon * 1e6 + 0.5).astype(np.int64))
        node_order = np.argsort(node_key)
        node_sorted = node_key[node_order]

        edge_key = graph.source * graph.node_count + graph.target.astype(np.int64)
        edge_order = np.argsort(edge_key)
        edge_sorted = edge_key[edge_order]

        lengths = (path_count[driven] - 1).clip(0)
        starts = path_offset[driven]
        leg_ids = np.nonzero(driven)[0]
        ends = np.cumsum(lengths)
        within = np.arange(int(ends[-1])) - np.repeat(ends - lengths, lengths)
        opens = np.repeat(starts, lengths) + within

        lat = column("path.latE6")
        lon = column("path.lonE6")
        total = int(lat.shape[0])
        usable = np.zeros(total, dtype=bool)
        usable[opens] = True
        leg_at = np.full(total, -1, dtype=np.int64)
        leg_at[opens] = np.repeat(leg_ids, lengths)

        self.passes = np.zeros(graph.edge_count, dtype=np.int64)
        self.matched = self.unmatched = 0
        pairs = []
        for lo in range(0, total, chunk):
            hi = min(total, lo + chunk)
            top = min(total, hi + 1)
            key = _keys(lat[lo:top], lon[lo:top])
            at = np.searchsorted(node_sorted, key)
            at[at >= node_sorted.shape[0]] = 0
            node = np.where(node_sorted[at] == key, node_order[at], -1)

            u, v = node[:-1], node[1:]
            ok = usable[lo:lo + u.shape[0]] & (u >= 0) & (v >= 0)
            if not ok.any():
                continue
            pair = u[ok] * graph.node_count + v[ok]
            at = np.searchsorted(edge_sorted, pair)
            at[at >= edge_sorted.shape[0]] = 0
            hit = edge_sorted[at] == pair
            slots = edge_order[at[hit]]
            self.passes += np.bincount(slots, minlength=graph.edge_count)
            self.matched += int(hit.sum())
            self.unmatched += int((~hit).sum())
            pairs.append(slots * self.person_count
                         + person_of_leg[leg_at[lo:lo + u.shape[0]][ok][hit]])

        # KDAY v9 stores external paths once per route and has trips reference
        # them. Count each route segment by how many trips used it, then attach
        # every external vehicle on that route to its distinct watched edges.
        if external_trip_vehicle is not None and external_trip_count:
            trip_route = column("externalTrip.route").astype(np.int64)
            route_offset = column("trafficRoute.pathOffset").astype(np.int64)
            route_count = column("trafficRoute.pathCount").astype(np.int64)
            traffic_lat = column("trafficPath.latE6")
            traffic_lon = column("trafficPath.lonE6")

            lengths = (route_count - 1).clip(0)
            ends = np.cumsum(lengths)
            within = np.arange(int(ends[-1])) - np.repeat(ends - lengths, lengths)
            opens = np.repeat(route_offset, lengths) + within
            route_at = np.repeat(np.arange(route_count.shape[0]), lengths)

            key = _keys(traffic_lat, traffic_lon)
            at = np.searchsorted(node_sorted, key)
            at[at >= node_sorted.shape[0]] = 0
            nodes = np.where(node_sorted[at] == key, node_order[at], -1)
            u, v = nodes[opens], nodes[opens + 1]
            ok = (u >= 0) & (v >= 0)
            pair = u[ok] * graph.node_count + v[ok]
            at = np.searchsorted(edge_sorted, pair)
            at[at >= edge_sorted.shape[0]] = 0
            hit = edge_sorted[at] == pair
            slots = edge_order[at[hit]]
            route_hit = route_at[ok][hit]
            trip_counts = np.bincount(trip_route, minlength=route_count.shape[0])
            self.passes += np.bincount(
                slots, weights=trip_counts[route_hit], minlength=graph.edge_count
            ).astype(np.int64)
            self.matched += int(trip_counts[route_hit].sum())
            self.unmatched += int(trip_counts[route_at[ok][~hit]].sum())

            order = np.argsort(trip_route, kind="stable")
            counts = np.bincount(trip_route, minlength=route_count.shape[0])
            offsets = np.zeros(route_count.shape[0] + 1, dtype=np.int64)
            np.cumsum(counts, out=offsets[1:])
            route_order = np.argsort(route_hit, kind="stable")
            edge_counts = np.bincount(route_hit, minlength=route_count.shape[0])
            edge_offsets = np.zeros(route_count.shape[0] + 1, dtype=np.int64)
            np.cumsum(edge_counts, out=edge_offsets[1:])
            sorted_slots = slots[route_order]
            for route in np.nonzero(counts & edge_counts)[0]:
                vehicles = np.unique(external_trip_vehicle[
                    order[offsets[route]:offsets[route + 1]]
                ]).astype(np.int64) + resident_count
                edges = np.unique(sorted_slots[
                    edge_offsets[route]:edge_offsets[route + 1]
                ]).astype(np.int64)
                pairs.append(np.repeat(edges, vehicles.shape[0]) * self.person_count
                             + np.tile(vehicles, edges.shape[0]))

        flat = np.unique(np.concatenate(pairs)) if pairs else np.empty(0, dtype=np.int64)
        self.driver_edge = (flat // self.person_count).astype(np.int32)
        self.driver_person = (flat % self.person_count).astype(np.int32)
        self.driver_offset = np.zeros(graph.edge_count + 1, dtype=np.int64)
        np.cumsum(np.bincount(self.driver_edge, minlength=graph.edge_count),
                  out=self.driver_offset[1:])
        self.distinct_drivers = int(np.unique(self.driver_person).shape[0])

    def drivers(self, edge):
        lo, hi = self.driver_offset[edge], self.driver_offset[edge + 1]
        return self.driver_person[lo:hi]
