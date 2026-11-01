"""Build the catalog of chargeable offenses from the sentencing table.

The offence list comes from the active jurisdiction bundle —
`jurisdictions/<profile>/offense_list.csv`, named by the city profile. For
Kierston that is `us-pa`, which every Pennsylvania city would share and no city
outside the state could use: grades, Offence Gravity Scores and Prior Offence
Groups are all artefacts of one sentencing system.

`us-pa/offense_list.csv` is the Pennsylvania Commission on Sentencing offence
listing: every offence sentenced under the guidelines, with its statutory grade,
Offence Gravity Score and Prior Offence Group. 1,333 rows over 661 distinct
statute sections, and the duplication is the useful part — a section appears
once per grading variant, so `3929(a)(1)` is present as an M-2 for a second
offence under $150 and an F-3 for a third, each with its own OGS. Grade is a
function of the facts of the case, and this file is that function already
tabulated. Charge selection therefore picks a *row*, not a statute.

Three columns carry the machinery the docket generator needs:

    Statutory Class   F-1..M-3, or a cross-reference for inchoate offences
    OGS               severity, 1-14ish numerically plus H1-H5 for homicide
    POG               Prior Offence Group, 1-4; what a prior conviction is
                      worth when scoring the next sentence

What the file does not contain is the two highest-volume categories in the
reference county, and their absence is structural rather than an export problem:

    Title 35 drug offences   1,462 of 3,865 county filings (37.8%). Act 64
                             offences are graded by substance and weight, on
                             the Commission's separate drug matrix.
    75 Pa.C.S. § 3802 DUI    most of the 818 "MV-other" filings. Graded and
                             sentenced by the § 3803/§ 3804 tier scheme, with
                             mandatory minimums keyed to BAC and priors.

Both are supplied below as SUPPLEMENT, and every row it adds is tagged
`source="reconstructed"` while everything from the CSV is `source="pcs"`. Any
report that quotes an OGS should be able to say where the number came from,
because these two tables are the author's reading of the statute and the CSV is
not. Summary offences are here on the same footing and for the same reason:
they are not guideline-sentenced, so the Commission never lists them, and
without them the magisterial court has nothing to hear.

Categories are assigned by statute range so the year-indexed filing mix can
select from them — see CATEGORY. They follow the AOPC caseload buckets (drug,
MV-other, public order, weapons, person) with property split out, since AOPC's
published breakdown leaves property inside a residual too small to be credible
for a county this size.
"""

import csv
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import jurisdiction as legal  # noqa: E402
import profile as city_profile  # noqa: E402
from paths import jurisdiction  # noqa: E402

LAW = legal.load()

INPUT = jurisdiction(city_profile.load().jurisdiction, "offense_list.csv")

# The export is a SharePoint list: line 1 is a ListSchema blob, line 2 is the
# real header. Read with utf-8-sig — there is a BOM in front of the blob.
SCHEMA_PREFIX = "ListSchema="

# Sections carry a trailing asterisk where an enhancement may apply — the
# deadly weapon and youth/school enhancements above all. The Mandatory column
# corroborates it with an "E", but the asterisk is on far more rows than the
# column is populated, so it is what gets read.
ENHANCEABLE = "*"

# Some rows state no grade of their own because the statute derives it from
# another offence. Three kinds, all needing the generator to resolve them
# against a target charge rather than being read as ungraded:
#
#   inchoate       attempt, solicitation, conspiracy — § 905 grades these as
#                  the completed offence, one degree down ("F-1 (-1)"), except
#                  where the target is murder and § 1102(c) applies.
#   derived        ethnic intimidation (§ 2710(b)), terrorism (§ 2717) and
#                  ecoterrorism (§ 3311) grade one degree *above* the
#                  underlying offence.
#   same           "Same as underlying offense" — carried through unchanged.
#
# All three come back with cross_reference set to the class text, so nothing
# downstream can mistake a derived grade for a missing one.
INCHOATE = re.compile(r"\(-1\)|§\s*905|§\s*1102\(c\)")
DERIVED = re.compile(r"§\s*2710\(b\)|§\s*2717|§\s*3311")
CROSS_REFERENCE = re.compile(r"§|Same as", re.I)

GRADES = ("F-1", "F-2", "F-3", "M-1", "M-2", "M-3", "M", "S")

# Statutory maximums, for sentence generation. "M" and "F" are the ungraded
# misdemeanour and felony the Crimes Code and Act 64 use where a section sets
# its own penalty rather than taking a degree; ungraded Act 64 felonies run to
# 15 years for Schedule I/II narcotics, which is why "F" is not 7. Offences
# that set their own maximum carry it in `maximum_years` and maximum() prefers
# that over this table.
MAXIMUM_YEARS = {"F-1": 20, "F-2": 10, "F-3": 7, "M-1": 5, "M-2": 2,
                 "M-3": 1, "M": 5, "F": 15, "S": 0.25}

# Act 64 maxima by substance, for the ungraded PWID felonies.
PWID_MAXIMUM_YEARS = {"heroin": 15, "fentanyl": 15, "cocaine": 15,
                      "methamph": 10, "marijuana": 5}

# What a prior conviction in each Prior Offence Group contributes to the Prior
# Record Score. POG1 is the most serious. These four values are the author's
# reading of the current PRS rules and are the single easiest thing here to get
# wrong; they are isolated in one dict so correcting them is a one-line change,
# and prs() below prints them in its report.
POG_POINTS = {"POG1": 4, "POG2": 3, "POG3": 2, "POG4": 1}
PRS_MAX = 5

# Statute ranges to filing categories. Title 18 chapter boundaries do most of
# the work: chapter 25 is homicide, 27 assault, 29 kidnapping, 31 sexual
# offences, 33 arson and property destruction, 35 theft, 37 robbery, 39 theft
# again, 41 forgery, 49 obstruction, 55 public order, 61 firearms, 63 minors.
CATEGORY_RANGES = (
    # (title, low section, high section, category)
    ("18", 2500, 2699, "person"),        # homicide, assault, endangerment
    ("18", 2700, 2799, "person"),
    ("18", 2900, 2999, "person"),        # kidnapping, unlawful restraint
    ("18", 3100, 3199, "person"),        # sexual offences
    ("18", 3300, 3399, "property"),      # arson, criminal mischief
    ("18", 3500, 3599, "property"),      # burglary, trespass
    ("18", 3700, 3799, "person"),        # robbery — violent, not property
    ("18", 3900, 3999, "property"),      # theft, retail theft, RSP
    ("18", 4100, 4199, "property"),      # forgery, fraud, access device
    ("18", 4900, 4999, "public_order"),  # obstruction, perjury, escape
    ("18", 5100, 5199, "public_order"),
    ("18", 5500, 5599, "public_order"),  # disorderly, riot, cruelty
    ("18", 6100, 6199, "weapons"),       # firearms
    ("18", 6300, 6399, "person"),        # offences against minors
    ("75", 0, 9999, "mv_other"),
    ("30", 0, 9999, "mv_other"),         # watercraft homicide/assault
    ("42", 0, 9999, "public_order"),     # jury tampering
)
DEFAULT_CATEGORY = "other"

# Conditions the CSV states in the description. Parsed into tags so charge
# selection can match a row against facts it has already decided — how many
# priors, what the goods were worth, whether the gun was loaded, why the
# defendant was prohibited from having it — rather than picking a grading
# variant at random and contradicting itself.
#
# These do not have to be exhaustive. The full description is the variant key
# (only § 2718(a)(1) and (a)(2) repeat one within a section), so a row is always
# identifiable; the tags are the subset a generator can match on facts. Where no
# tag applies, selection falls back to an OGS-weighted draw among the variants.
CONDITIONS = (
    (re.compile(r"\b2nd off", re.I), "prior_1"),
    (re.compile(r"\b3rd/subsq|3rd or subsq|3rd/subs", re.I), "prior_2"),
    (re.compile(r"\b(?:4th|fourth)\b", re.I), "prior_3"),
    (re.compile(r"\bunloaded|no ammo\b", re.I), "unloaded"),
    (re.compile(r"\bloaded|ammo available\b", re.I), "loaded"),
    (re.compile(r"\bfirearm\b", re.I), "firearm_involved"),
    (re.compile(r"motorized vehicle|motor vehicle", re.I), "vehicle_taken"),
    (re.compile(r"<\s*12\s*yrs", re.I), "victim_under_12"),
    (re.compile(r"<\s*1[368]\s*yrs", re.I), "victim_minor"),
    (re.compile(r"\bdrug-related\b", re.I), "drug_related"),
    (re.compile(r"\bSBI\b"), "serious_bodily_injury"),
    (re.compile(r"\bBI\b"), "bodily_injury"),
    (re.compile(r"\battempt", re.I), "attempt"),
    (re.compile(r"\bdisaster\b", re.I), "during_disaster"),
    (re.compile(r"police|law enforcement", re.I), "victim_officer"),
    # § 6105 variants are distinguished by *why* the defendant may not possess
    # a firearm, which the criminal history already determines. Tagging them
    # means the charge row follows from the record instead of being guessed.
    (re.compile(r"enumerated felony|drug felony", re.I), "prohibitor_felony"),
    (re.compile(r"enumerated misd", re.I), "prohibitor_misdemeanour"),
    (re.compile(r"drug misdemeanor", re.I), "prohibitor_drug_misdemeanour"),
    (re.compile(r"\bPFA\b"), "prohibitor_pfa"),
    (re.compile(r"fugitive from justice", re.I), "prohibitor_fugitive"),
    (re.compile(r"convicted of DUI", re.I), "prohibitor_dui"),
    (re.compile(r"incompetent|mental illness", re.I), "prohibitor_mental_health"),
    (re.compile(r"\balien\b", re.I), "prohibitor_immigration"),
    (re.compile(r"adjudicated delinquent", re.I), "prohibitor_delinquency"),
)

# Dollar amounts stated in a grading variant: "($200-$2,000/no threat)",
# "(>$25,000-<$100,000)", "(=>$500,000)", "(2nd off & <$150)". Theft, retail
# theft, forgery and criminal mischief all grade on value, so the generator
# draws a loss amount and this is what it matches against.
MONEY = re.compile(r"(<|=>|>=|>)?\s*\$([\d,]+)")


def value_band(description):
    """(low, high) dollar bounds a grading variant applies to, either may be None.

    A single amount is a bound rather than a band, and which bound it is depends
    on the operator in front of it: "<$150" caps the variant, ">$1,000" floors
    it. Two amounts are the band itself.
    """
    found = [(operator, int(amount.replace(",", "")))
             for operator, amount in MONEY.findall(description)]
    if not found:
        return None, None
    if len(found) >= 2:
        return min(a for _, a in found), max(a for _, a in found)
    operator, amount = found[0]
    return (None, amount) if operator == "<" else (amount, None)


def stem(section):
    """A statute section without its subsection: `2701(a)(1)` -> `2701`."""
    return section.split("(")[0].strip()


def category(title, section):
    """The filing category for a statute, from its title and section number."""
    number = int(re.match(r"\d+", section).group()) if re.match(r"\d+", section) else 0
    # Sections read as 4-digit chapter+offence: 3929 is chapter 39, offence 29.
    for range_title, low, high, name in CATEGORY_RANGES:
        if title == range_title and low <= number <= high:
            return name
    return DEFAULT_CATEGORY


def conditions(description):
    """Tags for the grading conditions stated in a description parenthetical."""
    return tuple(tag for pattern, tag in CONDITIONS if pattern.search(description))


def grade_of(statutory_class):
    """The grade in a Statutory Class cell, or None where it names no grade.

    Murder is spelled out ("Murder of 1st Degree") rather than graded, and the
    inchoate rows cross-reference instead. Both come back None and are handled
    by their own flags.
    """
    value = (statutory_class or "").strip()
    for grade in GRADES:
        # Anchored: "M" must not match inside "Murder of 2nd Degree", and
        # "F-1" must not match the "(-1)" of an inchoate row.
        if value == grade or value.startswith(grade + " "):
            return grade
    return None


def score(value):
    """An OGS cell as an int, or the cell itself where it is not numeric.

    H1-H5 are the homicide levels and G2 sits on its own scale; both index a
    different part of the guideline matrix than the numeric scores, so they are
    carried through as strings rather than coerced into a number they would
    then be compared against.
    """
    value = (value or "").strip()
    if value.isdigit():
        return int(value)
    return value or None


def parse(path=INPUT):
    """Every row of the Commission's listing as an offence record."""
    lines = path.read_text(encoding="utf-8-sig").splitlines()
    if lines and lines[0].startswith(SCHEMA_PREFIX):
        lines = lines[1:]

    offences = []
    for row in csv.DictReader(lines):
        title = (row["Title"] or "").strip()
        section = (row["Section"] or "").strip()
        if not title or not section:
            continue
        description = (row["Description"] or "").strip()
        statutory_class = (row["Statutory Class"] or "").strip()

        enhanceable = section.endswith(ENHANCEABLE)
        section = section.rstrip(ENHANCEABLE)

        pog = (row["POG"] or "").strip() or None
        low, high = value_band(description)

        offences.append({
            "title": title,
            "section": section,
            "cite": LAW.citation(title, section),
            "description": description,
            # The variant key. Unique within a section bar one pair of
            # strangulation rows, so it is what identifies a grading variant.
            "variant": description,
            "grade": grade_of(statutory_class),
            "ogs": score(row["OGS"]),
            # A POG that cross-references rather than naming a group cannot be
            # scored on its own; prs() must resolve it against the target.
            "pog": pog if pog in POG_POINTS else None,
            "pog_reference": pog if pog and pog not in POG_POINTS else None,
            "category": category(title, section),
            "conditions": conditions(description),
            "value_low": low,
            "value_high": high,
            "enhanceable": enhanceable,
            "mandatory": bool((row["Mandatory/ Enhancements"] or "").strip()),
            "inchoate": bool(INCHOATE.search(statutory_class)),
            "derived": bool(DERIVED.search(statutory_class)),
            "cross_reference": (statutory_class
                                if grade_of(statutory_class) is None
                                and CROSS_REFERENCE.search(statutory_class)
                                else None),
            "homicide": statutory_class.startswith("Murder"),
            "source": "pcs",
        })
    return offences


# ---------------------------------------------------------------------------
# Supplement: what the guidelines table does not list.
#
# Everything below is reconstructed from the statutes, not from the CSV, and is
# tagged accordingly. Weight bands on § 780-113(a)(30) follow the Commission's
# separate drug matrix, which keys OGS to substance and quantity; DUI grades
# and minimums follow 75 Pa.C.S. §§ 3803-3804.
# ---------------------------------------------------------------------------

# Substance, weight band, grade, OGS. Bands are the statutory ones, in grams
# except marijuana in pounds. Heroin and fentanyl share a matrix row.
PWID_BANDS = (
    ("heroin",      (0, 1),      "F", 5),
    ("heroin",      (1, 5),      "F", 6),
    ("heroin",      (5, 10),     "F", 7),
    ("heroin",      (10, 50),    "F", 8),
    ("heroin",      (50, 100),   "F", 10),
    ("heroin",      (100, None), "F", 11),
    ("fentanyl",    (0, 1),      "F", 6),
    ("fentanyl",    (1, 5),      "F", 7),
    ("fentanyl",    (5, 10),     "F", 8),
    ("fentanyl",    (10, None),  "F", 11),
    ("cocaine",     (0, 2),      "F", 5),
    ("cocaine",     (2, 10),     "F", 6),
    ("cocaine",     (10, 50),    "F", 7),
    ("cocaine",     (50, 100),   "F", 8),
    ("cocaine",     (100, None), "F", 10),
    ("methamph",    (0, 5),      "F", 6),
    ("methamph",    (5, 10),     "F", 7),
    ("methamph",    (10, 100),   "F", 8),
    ("methamph",    (100, None), "F", 11),
    ("marijuana",   (0, 2),      "F", 3),
    ("marijuana",   (2, 10),     "F", 4),
    ("marijuana",   (10, 50),    "F", 5),
    ("marijuana",   (50, None),  "F", 6),
)

# The rest of Act 64's chargeable subsections, and the two that carry the
# volume: (a)(16) simple possession and (a)(32) paraphernalia.
DRUG_OFFENCES = (
    ("780-113(a)(16)", "Possession of controlled substance", "M", 3, "POG4"),
    ("780-113(a)(31)", "Marijuana-small amount for personal use", "M", 1, "POG4"),
    ("780-113(a)(32)", "Use/possession of drug paraphernalia", "M", 1, "POG4"),
    ("780-113(a)(12)", "Acquisition of controlled substance by fraud", "F", 5, "POG3"),
    ("780-113(a)(14)", "Delivery by practitioner", "F", 6, "POG3"),
    ("780-113(a)(36)", "Distribution of small amount of marijuana", "M", 2, "POG4"),
)

# 75 Pa.C.S. § 3802 tiers. Grade and mandatory minimum both depend on how many
# prior DUIs are within the ten-year lookback, which is why each tier appears
# once per prior count. `minimum_days` is the § 3804 mandatory floor.
DUI_TIERS = (
    # subsection, label, priors, grade, ogs, minimum_days
    ("3802(a)(1)", "DUI-general impairment",        0, "M",   1, 0),
    ("3802(a)(1)", "DUI-general impairment",        1, "M",   3, 5),
    ("3802(a)(1)", "DUI-general impairment",        2, "M-2", 5, 10),
    ("3802(b)",    "DUI-high rate (.10-<.16)",      0, "M",   1, 2),
    ("3802(b)",    "DUI-high rate (.10-<.16)",      1, "M-1", 5, 30),
    ("3802(b)",    "DUI-high rate (.10-<.16)",      2, "M-1", 7, 90),
    ("3802(c)",    "DUI-highest rate (.16+)",       0, "M",   3, 3),
    ("3802(c)",    "DUI-highest rate (.16+)",       1, "M-1", 5, 90),
    ("3802(c)",    "DUI-highest rate (.16+)",       2, "F-3", 8, 365),
    ("3802(d)",    "DUI-controlled substance",      0, "M",   3, 3),
    ("3802(d)",    "DUI-controlled substance",      1, "M-1", 5, 90),
    ("3802(d)",    "DUI-controlled substance",      2, "F-3", 8, 365),
)

# Summary offences. Not guideline-sentenced and so absent from the Commission's
# list, but they are the bulk of what a magisterial district court disposes of
# and the only record most people ever acquire.
SUMMARY_OFFENCES = (
    ("18", "5503(a)(4)", "Disorderly conduct-summary", "public_order"),
    ("18", "5505",       "Public drunkenness",         "public_order"),
    ("18", "5507",       "Obstructing highways",       "public_order"),
    ("18", "3929(a)(1)", "Retail theft-summary (1st, <$150)", "property"),
    ("75", "3714",       "Careless driving",           "mv_other"),
    ("75", "3736",       "Reckless driving",           "mv_other"),
    ("75", "1501(a)",    "Driving without a licence",  "mv_other"),
    ("75", "1543(a)",    "Driving while suspended",    "mv_other"),
    # 18 Pa.C.S. § 6308, not the vehicle code: underage drinking is not a DUI,
    # and filing it under § 3802 counted it as one for § 6105(c)(3) and drew
    # the twelve-month DUI suspension.
    ("18", "6308",       "Underage drinking-summary",  "public_order"),
    ("75", "1786(f)",    "Operating without insurance", "mv_other"),
)


ORDINAL = ("1st", "2nd", "3rd", "4th")


def record(title, section, description, grade, ogs, pog, cat, cite=None, **extra):
    """One reconstructed offence, with the same keys parse() produces.

    Every field parse() sets is set here too, defaulted, so nothing downstream
    has to know which half of the catalogue a row came from.
    """
    low, high = value_band(description)
    offence = {
        "title": title,
        "section": section,
        "cite": cite or LAW.citation(title, section),
        "description": description,
        "variant": description,
        "grade": grade,
        "ogs": ogs,
        "pog": pog,
        "pog_reference": None,
        "category": cat,
        "conditions": (),
        "value_low": low,
        "value_high": high,
        "enhanceable": False,
        "mandatory": False,
        "inchoate": False,
        "derived": False,
        "cross_reference": None,
        "homicide": False,
        "source": "reconstructed",
    }
    offence.update(extra)
    return offence


def supplement():
    """The offences the guidelines table omits, reconstructed from statute."""
    out = []

    for substance, (low, high), grade, ogs in PWID_BANDS:
        unit = "lb" if substance == "marijuana" else "g"
        band = f"{low}-<{high}{unit}" if high else f"{low}{unit}+"
        out.append(record(
            "35", "780-113(a)(30)", f"PWID-{substance} ({band})", grade, ogs,
            "POG3", "drug", cite="35 P.S. § 780-113(a)(30)",
            conditions=(f"substance_{substance}",), enhanceable=True,
            substance=substance, weight_low=low, weight_high=high,
            maximum_years=PWID_MAXIMUM_YEARS[substance],
            # A weight band is not a dollar band; value_band() would otherwise
            # read "50-<100g" as money.
            value_low=None, value_high=None))

    for section, description, grade, ogs, pog in DRUG_OFFENCES:
        out.append(record("35", section, description, grade, ogs, pog, "drug",
                          cite=f"35 P.S. § {section}", maximum_years=1
                          if grade == "M" else None))

    for section, label, priors, grade, ogs, minimum in DUI_TIERS:
        out.append(record(
            "75", section, f"{label} ({ORDINAL[priors]} off)", grade, ogs,
            "POG4" if grade == "M" else "POG3", "mv_other",
            conditions=(f"prior_{priors}",) if priors else (),
            mandatory=minimum > 0, minimum_days=minimum))

    for title, section, description, cat in SUMMARY_OFFENCES:
        out.append(record(title, section, description, "S", None, None, cat))

    return out


def maximum(offence):
    """Statutory maximum in years, preferring an offence's own if it sets one."""
    return offence.get("maximum_years") or MAXIMUM_YEARS.get(offence.get("grade"))


def load(path=INPUT):
    """The full catalogue: the Commission's listing plus the supplement."""
    return parse(path) + supplement()


def by_category(offences):
    """{category: [offence]}, for the filing-mix draw."""
    grouped = {}
    for offence in offences:
        grouped.setdefault(offence["category"], []).append(offence)
    return grouped


def prs(priors):
    """Prior Record Score from previously convicted offences.

    PA scores the record, not the offence count: each prior conviction is worth
    its Prior Offence Group in points, and the total caps at 5. Summary
    convictions score nothing. The cap is why a long record stops lengthening
    sentences after a while, which is a real feature of the guidelines and the
    reason a chronic offender's tenth case is not sentenced twice as hard as
    their sixth.
    """
    points = sum(POG_POINTS.get(p["pog"], 0) for p in priors if p.get("pog"))
    return min(points, PRS_MAX)


def felony(offence):
    """Whether a grade is a felony, for the 27.1% AOPC cross-check."""
    grade = offence.get("grade") or ""
    return grade.startswith("F") or bool(offence.get("homicide"))


def main() -> None:
    """Report what the catalogue contains and where each part came from."""
    import argparse
    from collections import Counter

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--category", help="list the offenses in one category")
    args = parser.parse_args()

    offences = load()
    sources = Counter(o["source"] for o in offences)
    print(f"{len(offences):,} chargeable offenses  "
          f"({sources['pcs']:,} from {INPUT.name}, "
          f"{sources['reconstructed']:,} reconstructed from statute)")
    print(f"{len({o['section'] for o in offences}):,} distinct statute sections\n")

    print("by filing category:")
    grouped = by_category(offences)
    for name, rows in sorted(grouped.items(), key=lambda kv: -len(kv[1])):
        fel = sum(1 for o in rows if felony(o))
        print(f"  {name:<14}{len(rows):>5} offenses   {fel / len(rows) * 100:5.1f}% felony")

    print("\nby grade:")
    grades = Counter(o["grade"] or ("murder" if o["homicide"] else
                                    "inchoate" if o["inchoate"] else
                                    "derived" if o["derived"] else
                                    "cross-ref" if o["cross_reference"] else "?")
                     for o in offences)
    for grade, count in grades.most_common():
        years = MAXIMUM_YEARS.get(grade)
        print(f"  {grade:<10}{count:>5}" + (f"   max {years} yrs" if years else ""))
    ungraded = [o for o in offences if not o["grade"] and not o["homicide"]
                and not o["cross_reference"]]
    if ungraded:
        print(f"  !! {len(ungraded)} rows have neither a grade nor a "
              f"cross-reference: {[o['section'] for o in ungraded][:6]}")

    numeric = [o["ogs"] for o in offences if isinstance(o["ogs"], int)]
    print(f"\nOGS: {len(numeric):,} numeric, range {min(numeric)}-{max(numeric)}; "
          f"{sum(1 for o in offences if isinstance(o['ogs'], str)):,} on the "
          f"homicide/other scales")

    print("\nPrior Offense Group (points as scored by prs()):")
    for pog, count in Counter(o["pog"] for o in offences if o["pog"]).most_common():
        print(f"  {pog:<8}{count:>5} offenses   {POG_POINTS.get(pog, 0)} PRS points")

    tagged = sum(1 for o in offences if o["conditions"])
    valued = sum(1 for o in offences if o["value_low"] or o["value_high"])
    print(f"\n{tagged:,} offenses carry parsed condition tags "
          f"({tagged / len(offences) * 100:.0f}%), "
          f"{valued:,} carry a dollar band")
    print(f"{sum(1 for o in offences if o['enhanceable']):,} enhanceable, "
          f"{sum(1 for o in offences if o['mandatory']):,} with a mandatory minimum, "
          f"{sum(1 for o in offences if o['inchoate']):,} inchoate, "
          f"{sum(1 for o in offences if o['derived']):,} derived")

    # Charge selection picks a grading variant, so every variant within a
    # section has to be identifiable. The description is the key; the tags and
    # dollar bands are the subset selectable from facts the generator holds.
    variants = {}
    for offence in offences:
        variants.setdefault(offence["section"], []).append(offence)
    multi = {s: v for s, v in variants.items() if len(v) > 1}
    collisions = [s for s, v in multi.items()
                  if len({o["variant"] for o in v}) < len(v)]
    matchable = [s for s, v in multi.items()
                 if len({(o["conditions"], o["value_low"], o["value_high"])
                         for o in v}) == len(v)]
    print(f"\n{len(multi):,} sections have multiple grading variants")
    print(f"  {len(matchable):,} fully selectable from facts "
          f"(distinct tags or dollar bands)")
    print(f"  {len(multi) - len(matchable):,} fall back to an OGS-weighted draw")
    print(f"  {len(collisions):,} have colliding variant keys"
          + (f": {collisions}" if collisions else ""))

    # The catalogue is a menu, not a distribution. That drug offences are 86%
    # felony here says nothing about the felony share of drug *filings*, which
    # is dominated by § 780-113(a)(16) possession; the year-indexed mix table
    # decides frequency, not this file.
    print("\ncounts are catalog coverage, not filing frequency")

    if args.category:
        print(f"\n{args.category}:")
        for offence in sorted(grouped.get(args.category, []),
                              key=lambda o: -(o["ogs"] if isinstance(o["ogs"], int) else 0)):
            print(f"  {offence['cite']:<28}{offence['grade'] or '-':<5}"
                  f"OGS {str(offence['ogs'] or '-'):<4}{offence['description'][:52]}")


if __name__ == "__main__":
    main()
