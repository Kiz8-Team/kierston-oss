"""Pennsylvania court rules: dispositions, Clean Slate sealing, § 6105.

Read by criminal_history/dockets.py through jurisdiction.state_module().
"""

from personal_records.registries import REFERENCE_YEAR as TODAY

from . import offenses


# Disposition shares at Common Pleas, from the reference county's 2024 caseload. The
# overwhelming majority of cases are resolved by plea, which is the single most
# important fact about how the system works and the one most often modelled
# away.
DISPOSITIONS = (
    ("guilty_plea", 0.615),
    ("nolle_prossed", 0.148),     # withdrawn by the Commonwealth
    ("ard", 0.092),               # diversion, no conviction
    ("dismissed", 0.062),         # at the preliminary hearing or on motion
    ("guilty_verdict", 0.031),    # tried and convicted
    ("acquitted", 0.012),         # tried and acquitted
    ("other_diversion", 0.040),   # drug court, mental health court, § 17/18
)

# Summary offences never reach Common Pleas: they are tried before a
# magisterial district judge, and the outcome is a fine or a few days.
SUMMARY_DISPOSITIONS = (("guilty", 0.82), ("withdrawn", 0.10),
                        ("not_guilty", 0.05), ("dismissed", 0.03))

# Divorce grounds under 23 Pa.C.S. § 3301. Mutual consent and two-year
# separation are the no-fault grounds and are how almost every PA divorce is
# filed.
DIVORCE_GROUNDS = (("3301(c) mutual consent", 52),
                   ("3301(d) irretrievable breakdown", 44),
                   ("3301(a) fault", 4))


# ---------------------------------------------------------------------------
# Clean Slate
# ---------------------------------------------------------------------------

# 18 Pa.C.S. § 9122.2, as amended by Clean Slate 3.0. Summary convictions seal
# after ten years free of conviction; misdemeanours of the second and third
# degree and ungraded misdemeanours after ten years; certain F-3 property
# offences after fifteen. Sealing is automatic and does not require a petition,
# which is why it applies to a large share of old minor records here.
SEAL_AFTER = {"S": 10, "M-3": 10, "M-2": 10, "M": 10, "M-1": None,
              "F-3": 15, "F-2": None, "F-1": None, "F": None, None: None}

# Never sealed regardless of grade or age: offences against the person,
# firearms offences, sexual offences, cruelty to animals, and anything
# requiring registration.
SEAL_EXCLUDED_CATEGORIES = {"person", "weapons"}

# Category is not enough on its own. Homicide by vehicle and the other
# death-and-injury driving offences are categorised mv_other rather than person,
# because that is where the vehicle code puts them — so a fatal crash conviction
# came out eligible for sealing on the strength of being an F-3 traffic offence.
# § 9122.2 excludes any offence involving danger to the person; these are it.
SEAL_EXCLUDED_SECTIONS = {"2502", "2503", "2504", "3732", "3735", "3742",
                          "2718", "2709.1", "4915.1", "3121", "3123", "3125",
                          "3126", "6301", "4952", "6114"}


def apply_clean_slate(cases):
    """Mark which of a person's cases are sealed from public view.

    Order matters and is the reason this runs over a whole person's history at
    once rather than per case: the ten-year clock runs from the *last*
    conviction, so one new case un-seals nothing but does reset eligibility for
    everything that had not yet cleared.
    """
    convictions = sorted(c for c in
                         (case.get("disposed") for case in cases
                          if case.get("convicted")) if c)
    last = convictions[-1][:4] if convictions else None

    for case in cases:
        case["sealed"] = False
        if not case.get("convicted") or not case.get("public"):
            continue
        grades = [charge["grade"] for charge in case["charges"]]
        categories = {charge["category"] for charge in case["charges"]}
        if categories & SEAL_EXCLUDED_CATEGORIES:
            continue
        if {offenses.stem(c["section"]) for c in case["charges"]} & SEAL_EXCLUDED_SECTIONS:
            continue
        # The most serious grade in the case governs.
        waits = [SEAL_AFTER.get(g) for g in grades]
        if any(w is None for w in waits):
            continue
        wait = max(w for w in waits)
        clear_from = max(int(case["disposed"][:4]), int(last) if last else 0)
        case["sealed"] = TODAY - clear_from >= wait


# ---------------------------------------------------------------------------
# Firearms prohibition
# ---------------------------------------------------------------------------

# 18 Pa.C.S. § 6105 — persons not to possess a firearm. The enumerated list is
# long; what matters for the records is that it is broadly "any felony
# conviction, plus a specific set of misdemeanours", and that it is a lifetime
# bar rather than a term. A PFA final order is a separate, temporary
# prohibition under federal law and § 6105(c)(6), and three DUI convictions in
# five years is its own trigger under § 6105(c)(3).
#
# Derived here rather than in holdings.py so the firearms records cannot
# disagree with the criminal history they depend on: a person with a felony
# conviction and a current licence to carry is not a hard record to generate by
# accident, and it is the kind of inconsistency that makes a dataset useless.
# Narrow on purpose. § 6105(c)(9) enumerates specific misdemeanours, and simple
# assault is not one of them — under state law a simple assault conviction does
# not bar possession. It does under *federal* law, 18 U.S.C. § 922(g)(9), but
# only where the offence was against a domestic partner, which is a fact about
# the incident that no charge code records. Including simple assault wholesale
# put 19% of adults under a firearms bar, which is far too many; the domestic
# subset is applied separately below at the share that is actually domestic.
PROHIBITING_MISDEMEANOURS = {"2709.1", "2718", "6114", "4952"}

# Roughly a third of simple assault charges in a PA county arise from a domestic
# incident, and those carry the federal Lautenberg bar.
DOMESTIC_SHARE = 0.34

# § 6105(c)(3): three DUI convictions within a five-year period. Counted per
# case, not per charge: one arrest charged under § 3802(a)(1) and § 3802(c)
# together is one conviction for this purpose.
DUI_STEM = "3802"
DUI_COUNT = 3
DUI_WINDOW_YEARS = 5


def _years(date):
    """An ISO date as fractional years, on the 30-day months dockets.py uses."""
    return int(date[:4]) + (int(date[5:7]) - 1) / 12 + (int(date[8:10]) - 1) / 360


def dui_conviction_dates(cases, through_year=None):
    """Disposition dates of the convicted cases that carry a DUI count."""
    dates = []
    for case in cases:
        if not case.get("convicted") or not case.get("disposed"):
            continue
        if through_year is not None and int(case["disposed"][:4]) > through_year:
            continue
        if any(offenses.stem(charge["section"]) == DUI_STEM
               for charge in case["charges"]):
            dates.append(case["disposed"])
    return sorted(dates)


def three_duis_in_window(dates):
    """Whether any DUI_COUNT of these dates fall within DUI_WINDOW_YEARS."""
    values = [_years(d) for d in sorted(dates)]
    span = DUI_COUNT - 1
    return any(values[i + span] - values[i] <= DUI_WINDOW_YEARS
               for i in range(len(values) - span))


def prohibitor_tags(cases, year):
    """Which § 6105 grading variants a person's record supports in `year`.

    The tags match the `prohibitor_*` condition tags on the § 6105 rows in
    offenses.py. Only the grounds firearms_prohibition() also derives are
    returned, so a § 6105 charge always rests on a prohibition the status
    record shows. A PFA order is filed in the civil list after the criminal
    history is built, and the federal domestic ground is drawn at random
    there, so neither can support a charge here.
    """
    tags = set()
    for case in cases:
        if not case.get("convicted") or not case.get("disposed"):
            continue
        if int(case["disposed"][:4]) > year:
            continue
        if case.get("felony_convicted"):
            tags.add("prohibitor_felony")
        if {offenses.stem(c["section"]) for c in case["charges"]} \
                & PROHIBITING_MISDEMEANOURS:
            tags.add("prohibitor_misdemeanour")
    if three_duis_in_window(dui_conviction_dates(cases, year)):
        tags.add("prohibitor_dui")
    return tags


def firearms_prohibition(cases, rng):
    """Why, if at all, this person may not possess a firearm."""
    reasons = []
    for case in cases:
        if case.get("felony_convicted"):
            reasons.append("§ 6105(a) felony conviction")
        if case.get("convicted"):
            for charge in case["charges"]:
                section = offenses.stem(charge["section"])
                if section in PROHIBITING_MISDEMEANOURS:
                    reasons.append("§ 6105(c)(9) enumerated misdemeanour")
                elif section == "2701" and rng.random() < DOMESTIC_SHARE:
                    reasons.append(
                        "18 U.S.C. § 922(g)(9) domestic violence misdemeanour")
        # A PFA bar lasts as long as the order does — typically three years —
        # so an order from 2009 prohibits nothing today. Counting every order
        # ever entered as a live prohibition is the difference between 16% of
        # adults barred and 13%.
        if case.get("kind") == "protection_from_abuse" and case.get("order_months"):
            if int(case["filed"][:4]) + case["order_months"] / 12 > TODAY:
                reasons.append("§ 6105(c)(6) active protection from abuse order")
    if three_duis_in_window(dui_conviction_dates(cases)):
        reasons.append("§ 6105(c)(3) three DUI convictions")
    # Deduplicated but ordered, because the first reason is the one a PICS denial
    # would cite.
    return list(dict.fromkeys(reasons))
