"""Download all mapped OSM transport topology around the city's centre.

Not part of a build: this is one of the acquire helpers, run by hand when a new
city is being stood up, and it needs osmnx — which the pipeline itself does not.
The extent comes from the city profile, so pointing it at a different town means
editing `cities/<slug>.toml` and nothing here.
"""

import sys
from pathlib import Path

import osmnx as ox

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "init"))

import profile as city_profile  # noqa: E402
from paths import TOPOLOGY as OUTPUT  # noqa: E402

_PROFILE = city_profile.load()
CENTER = _PROFILE.extent.center
RADIUS_METERS = _PROFILE.extent.radius_m


def main() -> None:
    ox.settings.use_cache = True
    ox.settings.log_console = True

    graph = ox.graph_from_point(
        CENTER,
        dist=RADIUS_METERS,
        # Include every OSM highway type, including paths and private access ways.
        network_type="all",
        custom_filter='["highway"]["area"!~"yes"]',
        # Preserve intermediate OSM nodes and disconnected components.
        simplify=False,
        retain_all=True,
    )
    ox.save_graphml(graph, OUTPUT)
    print(f"Saved {len(graph.nodes):,} nodes and {len(graph.edges):,} edges to {OUTPUT}")


if __name__ == "__main__":
    main()
