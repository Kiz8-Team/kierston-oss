"""Pennsylvania sentencing: the guideline matrix, custody type and RRRI.

Read by criminal_history/dockets.py through jurisdiction.state_module().
"""

import math

from . import offenses


# The standard range, in months of minimum confinement, at PRS 0 for each
# Offense Gravity Score. RS is "restorative sanctions" — no confinement, which
# in practice means probation and costs.
#
# RECONSTRUCTED, and the least certain table in this file. The real 7th edition
# basic matrix is a published grid and this is its shape rather than its exact
# cells: RS through the low OGS, months growing with OGS, a steep climb above
# OGS 10. Replacing it with the real grid changes only this constant and
# PRS_INCREMENT below.
OGS_BASE = {
    1: (0, 1), 2: (0, 2), 3: (0, 6), 4: (0, 9), 5: (0, 9), 6: (3, 12),
    7: (6, 14), 8: (9, 16), 9: (12, 24), 10: (22, 36), 11: (36, 54),
    12: (48, 66), 13: (60, 78), 14: (72, 240),
}

# What a Prior Record Score adds to both ends of the standard range. The
# guidelines punish the record, not just the offence, which is why a chronic
# offender's sentences escalate on the same charge and why PRS is worth
# accumulating chronologically rather than assigning at the end.
PRS_INCREMENT = {0: 0, 1: 3, 2: 6, 3: 9, 4: 12, 5: 15}

# The increment is not flat across the matrix — it is small at the bottom and
# large at the top, so a long record adds a few months to a retail theft and
# years to a robbery. Applying it flat, which is the obvious reading, pushes
# every cell of the low-OGS rows out of the restorative-sanctions band: a
# chronic offender's disorderly conduct comes out with a fifteen-month guideline
# minimum, which then reads as a prison sentence. That single error was enough
# to put three times as many people in state prison as in county jail.
PRS_SCALE = ((5, 0.35), (9, 0.70), (99, 1.0))

# Homicide OGS codes come through the catalogue as H1-H6 rather than numbers,
# because murder is sentenced outside the matrix. Third-degree murder carries a
# 20-to-40-year maximum and first and second degree are life without parole,
# which is a sentence with no minimum to draw.
HOMICIDE_RANGE = {
    # The H matrix: first and second degree murder, and the reduced ranges that
    # apply where the offender was under 18 — Miller v. Alabama and
    # Commonwealth v. Batts, which is why a juvenile's murder conviction has a
    # minimum at all when an adult's does not.
    "H1": (240, 480), "H2": (300, 600), "H3": (300, 600),
    "H4": (420, 780), "H5": (0, 0), "H6": (0, 0),
    # The G matrix: third-degree murder, a 40-year maximum offence sentenced on
    # its own grid. Missing this was putting murder convictions on probation:
    # `G2` is not in the H table, so severity fell back to the F-1 grade and the
    # sentence came off the ordinary matrix.
    "G1": (90, 240), "G2": (120, 300), "G3": (150, 360),
}

# Life without parole, which is not a range: first-degree murder carries death
# or life and second-degree carries life, both mandatory, and neither has a
# minimum to draw. An adult convicted of either is in state custody until they
# die, and a sentence record with a release date would be wrong.
LIFE_OGS = {"H5", "H6"}

# Third-degree murder's statutory maximum, which the grade table has no entry
# for because murder is ungraded.
HOMICIDE_MAXIMUM_YEARS = 40

# Two years is the line between county and state custody in PA: a maximum of
# less than two years is served in the county jail, two years or more in a
# state correctional institution. It decides which agency holds someone,
# whether they are eligible for county work release, and who supervises them
# afterwards.
STATE_PRISON_MONTHS = 24

# RRRI — the Recidivism Risk Reduction Incentive minimum, which is the real
# release date for most eligible state prisoners. Roughly a sixth off for
# sentences under three years and a quarter off above, and unavailable for
# violent offences and firearms offences.
RRRI_INELIGIBLE = {"person", "weapons"}

# Probation is the modal sentence, and its length is only loosely tied to the
# guideline range because the range governs confinement, not supervision.
PROBATION_MONTHS = (12, 12, 18, 24, 24, 36, 36, 48, 60)


def ogs_of(offence):
    """The numeric Offense Gravity Score, or None where there is not one.

    OGS arrives from the catalogue as an int for most offences, as `H1`-`H6`
    for homicides, and as things like `F-1 (-1)` for inchoate offences, which
    are graded one degree below the completed offence.
    """
    value = offence.get("ogs")
    if isinstance(value, int):
        return value
    return None


def severity(offence):
    """A single orderable severity, for picking the count to sentence on.

    Homicides carry an OGS of `H1`-`H6` rather than a number, so comparing on
    the numeric score alone treats them as zero — and a murder charged alongside
    a simple assault gets sentenced on the assault. They sort above everything
    numeric here, which is what the `H` codes mean.
    """
    value = offence.get("ogs")
    if isinstance(value, str) and value in HOMICIDE_RANGE:
        # H above G: first and second degree murder outrank third.
        return 100 + int(value[1]) + (10 if value[0] == "H" else 0)
    if isinstance(value, int):
        return value
    # Inchoate and cross-referenced offences carry no numeric score, so the
    # grade is the only severity signal they have.
    return {"F-1": 11, "F-2": 8, "F-3": 6, "F": 8, "M-1": 4, "M-2": 3,
            "M": 3, "M-3": 2, "S": 1}.get(offence.get("grade"), 0)


def standard_range(offence, prior_score):
    """(low, high) months of minimum confinement under the guidelines."""
    value = offence.get("ogs")
    if isinstance(value, str) and value in HOMICIDE_RANGE:
        return HOMICIDE_RANGE[value]
    score = ogs_of(offence)
    if score is None:
        # Inchoate and cross-referenced offences: fall back on the grade, which
        # is the only severity signal they carry.
        score = {"F-1": 11, "F-2": 8, "F-3": 6, "F": 8,
                 "M-1": 4, "M-2": 3, "M": 3, "M-3": 2, "S": 1}.get(
                     offence.get("grade"), 3)
    score = min(14, max(1, score))
    low, high = OGS_BASE.get(score, (0, 3))
    scale = next(s for bound, s in PRS_SCALE if score <= bound)
    add = PRS_INCREMENT.get(prior_score, 15) * scale
    return low + add, high + add


def sentence(offence, prior_score, range_shift, rng):
    """A sentence consistent with the guidelines, or None for no confinement.

    PA sentences are indeterminate: a minimum and a maximum, with parole
    eligibility at the minimum and the maximum never more than twice it under
    42 Pa.C.S. § 9756(b). The maximum also cannot exceed the statutory maximum
    for the grade, which is what stops an OGS-driven range from producing a
    sentence longer than the offence allows.
    """
    low, high = standard_range(offence, prior_score)

    # Where in the range. `range_shift` is the caller's race adjustment, and
    # it is invisible on a docket sheet: any point inside the standard range is
    # a guideline-compliant sentence.
    position = min(1.0, max(0.0, rng.random() + range_shift))
    minimum = low + (high - low) * position

    # Homicides carry no grade, so the grade-keyed maximum table has nothing for
    # them and the fallback would cap murder at five years. Third-degree murder
    # is a 40-year maximum and first and second degree are life.
    if offence.get("ogs") in LIFE_OGS:
        return {
            "kind": "state_prison",
            "life_without_parole": True,
            "minimum_months": None,
            "maximum_months": None,
            "rrri_months": None,
            "probation_months": None,
            "fine": 0,
        }
    statutory = offenses.maximum(offence) or (
        HOMICIDE_MAXIMUM_YEARS if offence.get("homicide")
        or offence.get("ogs") in HOMICIDE_RANGE else 5)

    # A range whose bottom is restorative sanctions is a range in which the
    # court may impose no confinement at all, and for most of those cases it
    # does: probation is the modal sentence in Pennsylvania by a wide margin.
    # Reading any minimum above zero as jail time — which is what the arithmetic
    # does if left alone — puts three times as many people behind bars as have
    # ever been there, and it is wrong about which people, because the RS band
    # is where the misdemeanour volume sits.
    # Confinement is a separate decision from the range. The guidelines say how
    # long a minimum may be, not that one must be imposed, and Pennsylvania
    # courts impose probation or county intermediate punishment across most of
    # the lower half of the matrix. This graded schedule is what brings the
    # ever-incarcerated share down to the 5-7% the city actually has; reading
    # the range as mandatory put it near 13%. It has to climb back to near
    # certainty at the top of the matrix, though — a court does not put a
    # vehicular homicide on probation, and a flat rate across the whole matrix
    # did exactly that seven times in ten.
    confinement = (0.018 if low == 0 else 0.060 if low <= 8 else
                   0.135 if low <= 18 else 0.40 if low <= 36 else 0.96)
    if prior_score >= 3:
        confinement = min(0.95, confinement * 2.1)
    elif prior_score >= 1:
        confinement = min(0.95, confinement * 1.45)
    if rng.random() >= confinement or minimum < 1:
        return {
            "kind": "probation",
            "probation_months": rng.choice(PROBATION_MONTHS),
            "fine": rng.choice((0, 0, 100, 200, 300, 500, 1000)),
            "minimum_months": None, "maximum_months": None,
            "rrri_months": None,
        }

    # The statutory maximum binds the *minimum*, not just the maximum. Under
    # 42 Pa.C.S. § 9756(b) the maximum must be at least twice the minimum, so a
    # minimum above half the statutory ceiling is not an available sentence —
    # and the guidelines say as much, capping the standard range at the
    # statutory limit. This is what stops an OGS 7 simple assault, which is an
    # M-2 with a two-year ceiling, from coming out as a twenty-month state
    # sentence: the most it can carry is twelve to twenty-four, and in practice
    # a county sentence below that.
    minimum = max(1, min(int(round(minimum)), int(statutory * 12) // 2))

    # An offence whose statutory ceiling is two years or less cannot carry a
    # state sentence in any practical sense: the maximum has to come in under
    # 24 months, which is by definition county custody. Checked before the
    # negotiated path because it is a legal constraint rather than a bargain.
    if int(statutory * 12) <= 24:
        return {
            "kind": "county_jail",
            "minimum_months": min(minimum, 11),
            "maximum_months": 23,
            "rrri_months": None,
            "probation_months": (rng.choice(PROBATION_MONTHS)
                                 if rng.random() < 0.5 else None),
            "fine": rng.choice((0, 0, 100, 300, 500)),
        }

    # The county sentence. A guideline minimum in the low twenties is in state
    # prison territory by arithmetic, and in practice an enormous share of those
    # cases are negotiated down to "11½ to 23 months" — a county sentence
    # imposed precisely because it keeps the defendant out of a state
    # institution, under county supervision, and eligible for county work
    # release. It is one of the most recognisable strings on a Pennsylvania
    # docket sheet. Without it the arithmetic sends three times more people to
    # state prison than to county jail, which is backwards.
    # The window is wide for non-violent offences and narrow for violence and
    # firearms, where prosecutors will not negotiate as far and where the
    # legislature has attached mandatory minimums to stop them — but not closed,
    # because assault and weapons cases are pled to county time constantly.
    # Closing it entirely is what left state prison sentences outnumbering
    # county ones two to one, which is the reverse of the real ratio.
    violent = offence["category"] in RRRI_INELIGIBLE
    negotiable = 24 if violent else 54
    chance = 0.45 if violent else 0.80
    if 12 <= minimum <= negotiable and not offence.get("mandatory") \
            and rng.random() < chance:
        return {
            "kind": "county_jail",
            "minimum_months": 11,
            "maximum_months": 23,
            "rrri_months": None,
            "probation_months": (rng.choice(PROBATION_MONTHS)
                                 if rng.random() < 0.62 else None),
            "fine": rng.choice((0, 0, 0, 500, 1000)),
            "negotiated": True,
        }

    # The maximum. Two things bind it: the statutory ceiling for the grade, and
    # the county/state line at 24 months. Courts sentencing in the county range
    # cap the maximum at 23 months for the same reason, which is why so many
    # real PA sentences read "6 to 23 months" and almost none read "12 to 24".
    if minimum <= 11:
        maximum = min(23, max(minimum * 2, minimum + 3))
    else:
        maximum = max(minimum * 2, minimum + 12)
    maximum = min(int(statutory * 12), maximum)
    maximum = max(maximum, minimum + 1)
    # A mandatory minimum overrides the guidelines entirely — § 3804 for DUI is
    # the one that bites most often, in days.
    if offence.get("minimum_days"):
        minimum = max(minimum, math.ceil(offence["minimum_days"] / 30))
        maximum = max(maximum, minimum * 2)

    state = maximum >= STATE_PRISON_MONTHS
    rrri = None
    if state and offence["category"] not in RRRI_INELIGIBLE \
            and not offence.get("mandatory"):
        rrri = int(minimum * (0.75 if minimum >= 36 else 0.8333))
    return {
        "kind": "state_prison" if state else "county_jail",
        "minimum_months": minimum,
        "maximum_months": maximum,
        "rrri_months": rrri,
        # Consecutive probation after a short custodial sentence is routine.
        "probation_months": (rng.choice(PROBATION_MONTHS)
                             if not state and rng.random() < 0.55 else None),
        "fine": rng.choice((0, 0, 0, 500, 1000, 2500)),
    }
