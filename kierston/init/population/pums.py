"""Read the Kierston PUMS extract and assemble it into household records.

PUMS ships one row per person. Households are implicit: rows sharing a
`SERIALNO` are one surveyed household, and `RELSHIPP` says how each member
relates to the householder. This module does that grouping once so the
synthesis step can treat a household as a unit — which is the whole reason to
clone households rather than sample attributes independently. Copy an intact
record and spouse ages correlate, children are younger than their parents, and
the member incomes sum to the household income, all without modelling any of it.

Two populations come out, because they synthesise differently — the same split
`extract_dwellings.py` makes on the building side:
  households — occupy dwelling units, expanded by the household weight WGTP
  quarters   — dormitory residents, no household structure, expanded by PWGTP

The extract covers a single PUMA (42-02803), which weights out to 125,408
people in 46,039 households: the reference city, essentially exactly. It carries no
within-city geography at all, so every household here is a candidate for
anywhere on the map until block-group marginals are joined in.
"""

import json
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


from paths import PUMS as INPUT, PUMS_CODEBOOK as CODEBOOK  # noqa: E402

# RELSHIPP 37/38 are the institutionalised and non-institutionalised group
# quarters populations — dormitories, nursing homes, barracks. They are not
# households: PUMS gives each one its own SERIALNO with WGTP=0 and the HINCP
# N/A sentinel, so they would silently contribute nothing to a WGTP-weighted
# draw. Filtered explicitly rather than left to vanish by arithmetic.
GQ_RELSHIPP = {"37", "38"}

# PUMS writes a literal "N" — not an empty string — where a question does not
# apply. OCCP, SOCP and INDP all carry it for the same 1,614 respondents, the
# ones who were not working. Mapped to None, since 0 is a valid code and "N"
# zero-pads into the perfectly plausible-looking "000N".
NOT_APPLICABLE = "N"

# PINCP has its own N/A convention, and it is not "N" — it is a numeric
# sentinel, -19999, on all 580 respondents under 15, the ages PUMS does not ask
# about income at all. Taken literally it reads as a $19,999 business loss, and
# it is the single most common income in the extract: 17.5% of people. Left
# alone it drags every income aggregate down by a few thousand dollars and
# jitter.py smears it into a cloud of individually-varied fake losses, which
# hides the sentinel instead of surfacing it. Mapped to None like the other
# not-applicables, so anything reading income has to decide what to do about
# people who were never asked.
PINCP_NOT_APPLICABLE = -19999

# The PUMA people here live in. POWPUMA uses a different code for the same
# ground — place-of-work PUMAs are a coarser geography than residence PUMAs —
# so `02890` is this city as a workplace, and anything else is a commute out.
HOME_POWPUMA = "02890"

# JWTRNS 11. Worth naming: these people need no workplace assigned at all, and
# the code is not the 6 that the older, shorter JWTRNS coding used.
WORKED_FROM_HOME = "11"

# Codebook keys are zero-padded to their field width; the API returns values
# unpadded, so JWTRNS comes back as "1" against a codebook key of "01". Same
# trap as OCCP "0430" above. Anything reading a code against the codebook pads
# first — see `clock`, which is the only place here that needs to.
CODE_WIDTH = {"JWDP": 3, "JWAP": 3}

# SCH, school enrollment. 0 is the under-3s the question skips and 1 is "not in
# the last 3 months", so only 2 and 3 are people who need a school assigning.
# The public/private split is kept rather than collapsed to a flag: it decides
# which sites a student is eligible for, and the two are assigned by different
# rules — public K-12 by catchment, private by choice.
ENROLLED_PUBLIC = 2
ENROLLED_PRIVATE = 3

# SCHG, grade level attending. Two digits in the codebook, unpadded from the
# API — the same trap as JWTRNS, and worth padding here rather than in every
# reader, since the band tables downstream key off the codebook form.
GRADE_WIDTH = 2
GRADE_NOT_APPLICABLE = "00"

# "6:30 p.m. to 6:39 p.m." — the start of the bin is what we want.
CLOCK = re.compile(r"(\d+):(\d+)\s*([ap])\.m\.", re.I)


def clock(label):
    """Minutes past midnight from the start of a JWDP/JWAP bin label.

    JWDP has 151 codes and JWAP 287, and neither is a uniform grid: ACS uses
    five-minute bins through the commuting peaks and half-hour bins overnight.
    Deriving a time arithmetically from the code — treating them as even
    half-hours — puts the morning peak at 21:00. The label text is the only
    thing that actually says what a code means, so it is what gets parsed.
    """
    match = CLOCK.search(label or "")
    if not match:
        return None
    hour, minute, half = int(match[1]), int(match[2]), match[3].lower()
    hour = 0 if hour == 12 else hour
    return (hour + (12 if half == "p" else 0)) * 60 + minute


def codebook():
    """{variable: {code: label}}, for the fields whose codes carry a time."""
    raw = json.loads(CODEBOOK.read_text())["variables"]
    return {name: (raw.get(name, {}).get("values") or {}).get("item", {})
            for name in CODE_WIDTH}


def race_ethnicity(row):
    """Collapse RAC1P and HISP into the six categories ACS table B03002 uses.

    RAC1P alone will not do. Hispanic origin is a separate question from race,
    and 632 of the 644 "Some Other Race" responses in this extract are Hispanic
    — 98%. Controlling on RAC1P by itself would put 17% of Kierston into a
    bucket that matches no published census table.
    """
    if row["HISP"] != "01":
        return "hispanic"
    return {
        "1": "nh_white",
        "2": "nh_black",
        "6": "nh_asian",
        "9": "nh_two_or_more",
    }.get(row["RAC1P"], "nh_other")


def person(row, times):
    """One PUMS person row as a simulation-facing record.

    Occupation and industry stay strings: OCCP is zero-padded to four digits
    and occp_mapping.json keys off that padding, so "0430" must not become 430.

    The commute block is carried through unmodified because it is surveyed fact
    about this person, and workplace assignment needs it: `depart`/`arrive` give
    a real schedule rather than an invented one, `travel` is what the gravity
    model is calibrated against, and `transport`/`work_puma` decide whether this
    person needs a workplace in the city at all.
    """
    record = {
        # Provenance, at person granularity. Households already carry SERIALNO,
        # but personal records need the surveyed person: SSN and immigration
        # documents come off POBP/CIT/YOEP, none of which are worth copying into
        # every clone. (SERIALNO, SPORDER) is the PUMS primary key, so a later
        # stage can go back to the row this person is a copy of and read any of
        # the 517 columns without this module having to anticipate which.
        "serialno": row["SERIALNO"],
        "sporder": int(row["SPORDER"]),
        "relationship": int(row["RELSHIPP"]),
        "age": int(row["AGEP"]),
        "sex": int(row["SEX"]),
        "race_ethnicity": race_ethnicity(row),
        "education": int(row["SCHL"]),
        "employment": int(row["ESR"]),
        "income": None if int(row["PINCP"]) == PINCP_NOT_APPLICABLE
                  else int(row["PINCP"]),
        "weight": float(row["PWGTP"]),
    }
    def code(field, width=0):
        value = row[field]
        return value.zfill(width) if value and value != NOT_APPLICABLE else None

    record["occupation"] = code("OCCP", 4)
    record["soc"] = code("SOCP")
    record["industry"] = code("INDP")

    def number(field):
        value = row.get(field, "")
        return int(value) if value.lstrip("-").isdigit() else None

    def when(field):
        value = row.get(field, "").zfill(CODE_WIDTH[field])
        return clock(times[field].get(value))

    # 0 is the not-applicable code for both, and means "did not travel to work"
    # rather than "a zero-minute commute at midnight".
    # Enrollment, which is a separate question from attainment: SCHL says what
    # this person has finished, SCH and SCHG say where they are on a Tuesday
    # morning. A 15-year-old and a 40-year-old can share SCHL 14 and only one
    # of them is in a classroom, so nothing can infer the second from the first.
    record["enrolled"] = int(row["SCH"]) if row["SCH"] else None
    grade = row.get("SCHG", "").zfill(GRADE_WIDTH)
    record["grade"] = None if grade in ("", GRADE_NOT_APPLICABLE) else grade

    record["depart"] = when("JWDP")
    record["arrive"] = when("JWAP")
    record["travel"] = number("JWMNP") or None
    record["hours"] = number("WKHP") or None
    record["transport"] = code("JWTRNS")
    record["worker_class"] = code("COW")
    # POWPUMA's own not-applicable is the same "N" the occupation fields use.
    record["work_puma"] = code("POWPUMA")
    return record


def rows_by_person():
    """{(SERIALNO, SPORDER): raw row} — the whole extract, keyed the way clones are.

    `person()` deliberately reads a narrow slice of the 517 columns: the ones
    every downstream stage needs, carried into every clone. The personal-records
    stages need a different and much wider slice — POBP, CIT, YOEP, MAR, TEN,
    MIL, DIS and a dozen more — but only one value per *surveyed* person, not
    per clone. Copying 30 more columns into 115,343 records to read them 1,391
    times over is the wrong trade, so those stages join back to the extract
    through the (serialno, sporder) provenance instead.
    """
    raw = json.loads(INPUT.read_text())
    header, rows = raw[0], raw[1:]
    serialno, sporder = header.index("SERIALNO"), header.index("SPORDER")
    return {(row[serialno], int(row[sporder])): dict(zip(header, row))
            for row in rows}


def load():
    """Return (households, quarters).

    A household is {serialno, weight, income, members} where members is the
    person list in PUMS order — householder first, by RELSHIPP convention.
    Quarters are bare person records carrying their own PWGTP.
    """
    raw = json.loads(INPUT.read_text())
    header, rows = raw[0], raw[1:]
    times = codebook()

    grouped = defaultdict(list)
    for row in rows:
        record = dict(zip(header, row))
        grouped[record["SERIALNO"]].append(record)

    households, quarters = [], []
    for serialno, members in grouped.items():
        if any(m["RELSHIPP"] in GQ_RELSHIPP for m in members):
            quarters.extend(person(m, times) for m in members)
            continue
        households.append({
            "serialno": serialno,
            # WGTP is a household attribute, identical across its person rows.
            "weight": float(members[0]["WGTP"]),
            "income": int(members[0]["HINCP"]),
            "members": [person(m, times) for m in members],
        })
    return households, quarters
