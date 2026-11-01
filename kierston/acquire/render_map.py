"""Render the complete OSM topology as a standalone HTML map.

A look at what was downloaded, not an input to anything. The render lands in
sim_data/ with the rest of the generated output.
"""

import sys
from pathlib import Path

import folium
import osmnx as ox

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "init"))

import profile as city_profile  # noqa: E402
from paths import SIM_DATA, TOPOLOGY as INPUT  # noqa: E402

OUTPUT = SIM_DATA / "topology.html"
CENTER = city_profile.load().extent.center


def main() -> None:
    graph = ox.load_graphml(INPUT)
    edges = ox.graph_to_gdfs(graph, nodes=False, fill_edge_geometry=True)

    map_ = folium.Map(
        location=CENTER,
        zoom_start=13,
        tiles="OpenStreetMap",
        control_scale=True,
    )
    folium.GeoJson(
        edges[["geometry"]].to_json(),
        name="All OSM highway ways",
        style_function=lambda _: {"color": "#e63946", "weight": 1, "opacity": 0.75},
    ).add_to(map_)
    folium.LayerControl().add_to(map_)
    map_.save(OUTPUT)
    print(f"Rendered {len(edges):,} directed edges to {OUTPUT}")


if __name__ == "__main__":
    main()
