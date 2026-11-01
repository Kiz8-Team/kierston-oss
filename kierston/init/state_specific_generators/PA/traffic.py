"""Out-of-state visitors to a Pennsylvania city: where each state lies and the mix.

Read by traffic/external.py through jurisdiction.state_module(). The one-off
weights are published into external_traffic.json for the day simulator.
"""

# (tier, bearing) of every state and DC as seen from Pennsylvania. Tier 0 is
# the home state, 1 a neighbor, 2 the wider region, 3 the rest of the country.
# Bearing is the compass direction to the state; None for the home state.
POSITION = {
    "AL": (3, 225), "AK": (3, 315), "AZ": (3, 260), "AR": (3, 245), "CA": (3, 275), "CO": (3, 275),
    "CT": (2, 55), "DE": (1, 155), "DC": (2, 190), "FL": (3, 195), "GA": (3, 210), "HI": (3, 270),
    "ID": (3, 290), "IL": (3, 275), "IN": (3, 275), "IA": (3, 285), "KS": (3, 270), "KY": (2, 250),
    "LA": (3, 225), "ME": (2, 45), "MD": (1, 190), "MA": (2, 55), "MI": (2, 300), "MN": (3, 305),
    "MS": (3, 225), "MO": (3, 265), "MT": (3, 300), "NE": (3, 285), "NV": (3, 275), "NH": (2, 45),
    "NJ": (1, 90), "NM": (3, 255), "NY": (1, 25), "NC": (2, 205), "ND": (3, 310), "OH": (1, 280),
    "OK": (3, 255), "OR": (3, 290), "PA": (0, None), "RI": (2, 60), "SC": (3, 205), "SD": (3, 300),
    "TN": (3, 235), "TX": (3, 240), "UT": (3, 280), "VT": (2, 25), "VA": (2, 205), "WA": (3, 300),
    "WV": (1, 240), "WI": (3, 295), "WY": (3, 285),
}

# Repeat visitors to eastern Pennsylvania, by kind of vehicle. Same-state traffic
# dominates because "outside" means outside the model area, not outside
# Pennsylvania. Workers are the most local; commercial traffic carries the
# longest national tail. A state not listed falls back to its tier's weight.
RECURRING_WEIGHTS = {
    "worker": {"NJ": 22, "NY": 15, "MD": 4, "DE": 4, "CT": 2,
               "OH": 1.5, "WV": 0.8, "VA": 0.8},
    "delivery": {"NJ": 17, "NY": 12, "MD": 7, "DE": 5, "OH": 5,
                 "CT": 3, "VA": 3, "WV": 2, "MI": 1.5},
    "repeat_visitor": {"NJ": 21, "NY": 15, "MD": 5, "DE": 5,
                       "CT": 2.5, "OH": 2, "VA": 1.2, "WV": 1},
}

# Date-local through traffic and single visits, read by the day simulator.
ONE_OFF_WEIGHTS = {
    "through": {"NJ": 19, "NY": 16, "MD": 8, "OH": 7, "DE": 5, "CT": 4,
                "VA": 4, "NC": 2.5, "MI": 2.5, "MA": 2.5, "WV": 2},
    "single_visit": {"NJ": 24, "NY": 17, "MD": 6, "DE": 5, "CT": 3,
                     "OH": 2.5, "VA": 1.5, "WV": 1},
}
