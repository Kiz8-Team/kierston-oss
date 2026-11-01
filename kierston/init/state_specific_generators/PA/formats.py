"""Pennsylvania number formats: plates, dockets and driver's licenses.

Read by personal_records/registries.py and criminal_history/dockets.py through
jurisdiction.state_module().
"""

import re


# Passenger plates: three letters, a dash, four digits.
def passenger_plate(letters, serial):
    return f"{letters}-{serial:04d}"


# A personalized plate that reads as a sequential one is refused: it would be
# indistinguishable from an issued plate to anything reading it.
SEQUENTIAL_PLATE = re.compile(r"[A-Z]{3}[- ]?\d{4}")


def municipal_plate(index):
    """Format a position in the municipal government series."""
    return f"MG-{index:05d}"


def school_bus_plate(index):
    """Format a position in the school bus series."""
    return f"SB-{index:05d}"


def licence_number(sequence):
    """An eight-digit PennDOT driver's license number."""
    return f"{sequence:08d}"


# Docket type codes. CR is a criminal case, SA a summary appeal, MD a
# miscellaneous criminal matter, CV a civil action, DR domestic relations, JV
# juvenile delinquency, NT non-traffic summary.
DOCKET_TYPES = ("CR", "SA", "MD", "CV", "DR", "JV", "NT", "TR")


def magisterial_docket(district, sequence, year, kind="CR"):
    """`MJ-31201-CR-0000123-2026` — the AOPC magisterial format.

    The district's dashes are stripped and the number zero-padded to five, so
    31-2-01 becomes 31201.
    """
    return (f"MJ-{district.replace('-', '')}-{kind}-"
            f"{sequence:07d}-{year}")


def common_pleas_docket(judicial_district, sequence, year, kind="CR"):
    """`CP-39-CR-0001234-2026` — the county Court of Common Pleas."""
    return f"CP-{judicial_district}-{kind}-{sequence:07d}-{year}"


def series_of(docket):
    """(series key, sequence, digit width) for any docket or licence number here.

    The sequence sits at a different position in each format — position 3 in the
    AOPC magisterial and Common Pleas numbers, last in the federal and county
    licence ones — so the split is on the format rather than a single index. The
    width travels with it so a renumbered docket pads to the same length it had.
    """
    parts = docket.split("-")
    index = 3 if docket[:3] in ("MJ-", "CP-") else len(parts) - 1
    key = tuple(parts[:index]) + (None,) + tuple(parts[index + 1:])
    return key, int(parts[index]), len(parts[index])
