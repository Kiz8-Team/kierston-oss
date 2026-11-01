"""Generate criminal, civil, family and bankruptcy dockets for Kierston.

Criminal history is the hard part of this file and the reason it exists. The
easy way to build it is a per-person coin flip against each published marginal —
35% arrested, 27% convicted, 11% felony — and it produces something useless: a
population where a felony conviction is uncorrelated with the misdemeanour that
came before it, where nobody has a *career*, and where the 35% and the 11% are
different, independently-flipped people. Real criminal records do not look like
that at all. They are extraordinarily concentrated: Wolfgang's Philadelphia
birth cohort found 6% of boys accounted for 52% of all offences, and every
replication since has found the same shape.

So this generates careers, not flags, and the marginals come out as a
consequence. Two independent processes run over each person's life:

  a latent offending class    Following Moffitt and the Nagin trajectory work.
                              Most people never offend. A large minority offend
                              through their teens and stop — the
                              adolescence-limited group, which is why the
                              age-crime curve has the shape it does. A small
                              group offends at a low rate across adulthood, and
                              a very small group offends persistently and at
                              high rate. Class is drawn once and shapes a whole
                              life.

  a situational hazard        Independent of class, and applied to everyone
                              including people who never offend otherwise. This
                              is the DUI on the way home, the fight outside a
                              bar, the fatal crash. It is what produces the
                              person with one serious felony and no other
                              contact with the system in seventy years, who is
                              a real and common kind of record and whom no
                              career model generates.

Offending is then separated from *arrest*, and from arrest to charge, to
conviction, to sentence — because they are different events with different
rates, and the interesting disparities live in the gaps between them.

Which is where race enters, and it is worth being explicit about how, because
the modelling choice is a substantive claim. Race does not multiply the latent
offending class here. It multiplies the probability of contact given offending,
access to diversion, the odds of pretrial detention, and position within the
sentencing guideline range — the four places where the empirical literature
locates the disparity and where an administrative record actually generates it.
Built the other way, with race loading onto propensity, the model would produce
the same arrest statistics while asserting something quite different and much
worse about why. The distinction is invisible in the output marginals and it is
the whole point.

The sentencing side follows PA mechanics: an Offense Gravity Score from the
Commission's listing, a Prior Record Score that accumulates chronologically
across a person's own earlier convictions, a standard range read off the matrix,
an indeterminate minimum-to-maximum sentence, county jail under two years and
state prison at or over it, RRRI reductions, and Clean Slate sealing under
18 Pa.C.S. § 9122.2 for the old minor cases. A docket that says four years'
probation on an OGS 3 with a PRS of 5 is wrong in a way that anyone who has
read a PA docket sheet would notice, and the matrix is what stops that.

Non-criminal records share the file because they share the courts and the
numbering: divorce, custody, support, protection from abuse, civil judgments,
landlord-tenant and bankruptcy all produce dockets, and several of them are
downstream of the criminal ones. Bankruptcy is federal, which is why it appears
with a federal district number rather than a county one.

What is calibrated against what:
  offence catalogue and OGS      offenses.py, from the Commission's listing
  charge frequencies             hand-weighted; the listing is a catalogue of
                                 what *can* be charged, and is dominated by
                                 obscure felonies. See CHARGE_WEIGHTS.
  case volume and disposition    the reference county's 2024 Common Pleas caseload
  prevalence marginals           assumed values (no published source), reported as checks
  concentration                  Wolfgang; the top-6% share is a printed line
"""

import argparse
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

# Stages live in sibling folders, and only this script's own folder is on
# the path when it runs as a script.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from population import pums
from personal_records import registries
from personal_records.registries import keyed


from paths import SIM_DATA
import jurisdiction as legal
import profile as city_profile

LAW = legal.load()
offenses = legal.state_module("offenses")
sentencing = legal.state_module("sentencing")
charging = legal.state_module("charging")
courts = legal.state_module("courts")
formats = legal.state_module("formats")
COUNTY = city_profile.load().locale.county
POPULATION = SIM_DATA / "population.json"
IDENTITY = SIM_DATA / "identity.json"
EMPLOYMENT = SIM_DATA / "employment.json"
OUTPUT = SIM_DATA / "dockets.json"

DEFAULT_SEED = 20260728
TODAY = registries.REFERENCE_YEAR
# Nothing is filed, disposed or sentenced after this date. A case whose
# disposition would fall later is pending.
REFERENCE = registries.REFERENCE_DATE
TODAY_ISO = REFERENCE.isoformat()

# Nobody under 10 is charged with anything, and 10-17 goes to juvenile court
# rather than to the criminal division. The distinction matters for the records:
# a juvenile adjudication is not a conviction, does not score for PRS, and is
# not a public docket.
MINIMUM_AGE = 10
ADULT_AGE = 18


# ---------------------------------------------------------------------------
# Offending classes
# ---------------------------------------------------------------------------

# Share of the population in each latent class, and the offending profile of
# each. `base` is offences per year at the peak of the age curve; `peak` and
# `spread` shape that curve; `desist` is the annual probability of stopping for
# good once past the peak.
#
# The shares are set so the marginals below come out right, which is the only
# way to set them — nothing publishes trajectory-group membership for
# the reference city. The *shape* is from the trajectory literature and is not tunable:
# a heavily-populated adolescence-limited group and a tiny high-rate group is
# the finding that replicates everywhere it has been looked for.
CLASSES = {
    "none": {
        "share": 0.585, "base": 0.0, "peak": 19, "spread": 5, "desist": 0.0,
    },
    "adolescence_limited": {
        # Offends through the teens, stops in the early twenties, and mostly
        # never appears again. The largest offending group and the smallest
        # share of serious offences.
        "share": 0.263, "base": 0.46, "peak": 18, "spread": 3.4,
        "desist": 0.34,
    },
    "chronic_moderate": {
        # A career, but a slow one: a case every few years across two decades,
        # mostly property, drug and public-order offences.
        "share": 0.105, "base": 0.60, "peak": 22, "spread": 8.5,
        "desist": 0.055,
    },
    "chronic_high": {
        # The 4%. High rate, early onset, wide offence mix including violence,
        # and long enough a career to accumulate the PRS that drives everything
        # in the sentencing matrix.
        "share": 0.047, "base": 1.60, "peak": 21, "spread": 11.0,
        "desist": 0.028,
    },
}

# Class membership is strongly sexed and the difference is real and large: men
# are arrested roughly three to four times as often as women, and the gap is
# widest for violence and narrowest for property and drug offences. Applied to
# class membership rather than to the arrest rate, because the difference is in
# offending, not in policing.
SEX_WEIGHT = {
    # PUMS SEX: 1 male, 2 female
    1: {"adolescence_limited": 1.42, "chronic_moderate": 1.62,
        "chronic_high": 2.05},
    2: {"adolescence_limited": 0.60, "chronic_moderate": 0.40,
        "chronic_high": 0.20},
}

# Probability that an offence results in an arrest. Most offences do not:
# clearance rates run around 45% for violent crime and under 15% for property
# crime nationally, and an offence nobody reports has no clearance rate at all.
# This is the single biggest lever on the prevalence marginals.
ARREST_GIVEN_OFFENCE = {
    "person": 0.42, "weapons": 0.34, "drug": 0.26, "public_order": 0.46,
    "property": 0.16, "mv_other": 0.62, "other": 0.24,
}

# --- where race enters ------------------------------------------------------
# Four multipliers, all on processing rather than propensity. See the module
# docstring: this placement is the substantive modelling claim in this file.
#
# Magnitudes are set from the national and PA-level literature — Black arrest
# rates around 2.4x white overall with much of that concentrated in drug and
# public-order offences where police discretion is widest, ARD admission rates
# roughly half, pretrial detention meaningfully higher at equivalent charge and
# record. They are estimates, not measurements of the reference county.
CONTACT_MULTIPLIER = {
    "nh_black": 1.95, "hispanic": 1.38, "nh_two_or_more": 1.35,
    "nh_other": 1.30, "nh_white": 1.0, "nh_asian": 0.62,
}

# Discretion-heavy offences: where an arrest depends on an officer deciding to
# make one. The contact disparity concentrates here, and is much weaker for
# offences that arrive as a reported victim complaint.
DISCRETIONARY = {"drug", "public_order", "weapons"}
DISCRETION_BOOST = 1.45

# Accelerated Rehabilitative Disposition — PA's pre-trial diversion. Completing
# it means no conviction and an expungement, so who gets offered it is one of
# the most consequential decisions in the system.
ARD_ACCESS = {
    "nh_black": 0.55, "hispanic": 0.70, "nh_two_or_more": 0.72,
    "nh_other": 0.72, "nh_white": 1.0, "nh_asian": 1.05,
}

DETENTION_MULTIPLIER = {
    "nh_black": 1.62, "hispanic": 1.34, "nh_two_or_more": 1.30,
    "nh_other": 1.30, "nh_white": 1.0, "nh_asian": 0.85,
}

# Position in the standard guideline range, 0 at the bottom and 1 at the top.
# A judge sentencing inside the range is complying with the guidelines
# regardless of where in it they land, which is exactly what makes this the
# place disparity survives review.
RANGE_POSITION = {
    "nh_black": 0.12, "hispanic": 0.07, "nh_two_or_more": 0.07,
    "nh_other": 0.07, "nh_white": 0.0, "nh_asian": -0.03,
}

# The situational hazard: annual probability of a one-off offence for anyone,
# in any class. Graded by age because the components are — impaired driving and
# bar fights are young, and the fatal-crash component never goes away.
SITUATIONAL_BY_AGE = ((17, 0.0022), (24, 0.0098), (34, 0.0078),
                      (49, 0.0050), (64, 0.0031), (200, 0.0015))


# ---------------------------------------------------------------------------
# What actually gets charged
# ---------------------------------------------------------------------------

# Class-specific tilt on the category mix. The adolescence-limited group is
# doing minor property, drug and public-order offending; the high-rate chronic
# group is where violence and weapons concentrate. Multiplied over the charge
# weights above and renormalised.
CATEGORY_TILT = {
    "adolescence_limited": {"property": 1.5, "public_order": 1.6,
                            "drug": 1.3, "person": 0.55, "weapons": 0.4,
                            "mv_other": 0.7},
    "chronic_moderate": {"property": 1.3, "drug": 1.5, "public_order": 1.1,
                         "person": 0.85, "weapons": 0.8},
    "chronic_high": {"person": 1.7, "weapons": 2.4, "drug": 1.3,
                     "property": 1.0, "public_order": 0.9},
    "situational": {},
}

# Drug enforcement is not stationary and the substance is not incidental to the
# record: the same section, § 780-113(a)(30), carries a different OGS by
# substance, and which substance dominates is a function of the year. Crack
# through the late 80s and 90s, prescription opioids in the 2000s, heroin in
# the early 2010s, fentanyl and methamphetamine after 2015.
SUBSTANCE_ERAS = (
    (1990, {"cocaine": 0.52, "marijuana": 0.34, "heroin": 0.10,
            "methamph": 0.04}),
    (2003, {"cocaine": 0.44, "marijuana": 0.36, "heroin": 0.14,
            "methamph": 0.06}),
    (2012, {"cocaine": 0.24, "marijuana": 0.32, "heroin": 0.30,
            "methamph": 0.14}),
    (2018, {"heroin": 0.38, "fentanyl": 0.20, "cocaine": 0.16,
            "marijuana": 0.14, "methamph": 0.12}),
    (9999, {"fentanyl": 0.42, "methamph": 0.22, "cocaine": 0.16,
            "heroin": 0.12, "marijuana": 0.08}),
)



def age_rate(profile, age):
    """The age-crime curve: offending rate as a fraction of the class peak.

    A log-normal-ish rise and fall rather than a symmetric bell, because the
    real curve is not symmetric — it climbs fast through the mid-teens and
    decays slowly across the thirties. `spread` widens the tail, which is the
    difference between a class that stops at 22 and one that is still offending
    at 45.
    """
    if age < MINIMUM_AGE:
        return 0.0
    peak, spread = profile["peak"], profile["spread"]
    if age <= peak:
        # Steep, and zero below 10.
        rise = (age - MINIMUM_AGE) / max(1, peak - MINIMUM_AGE)
        return max(0.0, rise) ** 2.1
    return math.exp(-((age - peak) / spread) ** 1.35)


def assign_class(sex, rng):
    """Draw a latent offending class, weighted by sex."""
    weights = SEX_WEIGHT.get(sex, {})
    labels = list(CLASSES)
    shares = [CLASSES[label]["share"] * weights.get(label, 1.0)
              for label in labels]
    return rng.choices(labels, weights=shares)[0]


class Catalogue:
    """The offence catalogue, indexed the ways a charge draw needs it.

    Built once. The weight of an offence is its section's charging weight split
    across that section's grading variants by inverse severity — a retail theft
    is far more often the M-2 under $150 variant than the F-3 third-offence
    one, and the catalogue lists both with no indication of which is common.
    """

    def __init__(self):
        self.offences = offenses.load()
        self.by_stem = defaultdict(list)
        for offence in self.offences:
            self.by_stem[offenses.stem(offence["section"])].append(offence)

        self.weight = {}
        for key, variants in self.by_stem.items():
            base = charging.CHARGE_WEIGHTS.get(key)
            severities = [charging.RESIDUAL_WEIGHT.get(o["grade"], 0.2) for o in variants]
            for offence, severity in zip(variants, severities):
                if base is None:
                    # Unnamed section: the residual tail, where the grade is
                    # the only guide to how often it is charged.
                    self.weight[id(offence)] = 0.02 * severity
                else:
                    # Normalised across the section's variants, so a section's
                    # weight in CHARGE_WEIGHTS is its total share and not an
                    # amount that grows with how many gradings the Commission
                    # happens to list for it. Within the section, severity
                    # decides the split: retail theft is the M-2 under-$150
                    # variant far more often than the F-3 third-offence one.
                    self.weight[id(offence)] = (
                        base * severity / sum(severities))

        # Pre-split by category so the class tilt can be applied without
        # rescanning 1,384 offences per draw.
        self.by_category = defaultdict(list)
        for offence in self.offences:
            self.by_category[offence["category"]].append(offence)

        # Sections whose grading variants are keyed on facts the record
        # already holds: how many priors of the same section, and why the
        # person may not possess a firearm. The top prior level is what a
        # longer record still grades as ("3rd or subsequent").
        self.prior_top = {}
        self.prohibitor_stems = set()
        for key, variants in self.by_stem.items():
            levels = [prior_level(o) for o in variants]
            if any(levels):
                self.prior_top[key] = max(levels)
            if any(t.startswith("prohibitor_") for o in variants
                   for t in o["conditions"]):
                self.prohibitor_stems.add(key)

    def fits(self, offence, record):
        """Whether an offence agrees with what is already known about the case.

        `record` is a Draw: the person's earlier cases, the year, their age,
        and the most serious charge this one may be. A grading variant tagged
        with a number of priors is admissible only when the person has that
        many; a § 6105 variant only when their record carries the prohibition
        it names; a driving offence only from driving age.
        """
        if record is None:
            return True
        if record.age is not None and record.age < minimum_age(offence):
            return False
        if record.ceiling is not None \
                and sentencing.severity(offence) > record.ceiling:
            return False
        key = offenses.stem(offence["section"])
        if key in self.prohibitor_stems:
            named = {t for t in offence["conditions"]
                     if t.startswith("prohibitor_")}
            return bool(named & record.prohibitors())
        if key in self.prior_top:
            return prior_level(offence) == min(record.priors(key),
                                               self.prior_top[key])
        return True

    def draw(self, offending_class, year, rng, section=None, record=None):
        """One offence, tilted by class and — for drugs — by year.

        With `record`, the result agrees with it (see fits()). A random draw
        that lands on a section whose drawn variant does not fit is moved to a
        variant of the same section that does, which keeps section frequencies
        intact; if none does, the draw is repeated. None if nothing fits.
        """
        if section is not None:
            variants = [o for o in self.by_stem.get(section, ())
                        if self.fits(o, record)]
            if not variants:
                return None
            offence = rng.choices(
                variants, weights=[self.weight[id(o)] for o in variants])[0]
        else:
            tilt = CATEGORY_TILT.get(offending_class, {})
            pool = self.offences
            weights = [self.weight[id(o)] * tilt.get(o["category"], 1.0)
                       for o in pool]
            offence = None
            for _ in range(DRAW_ATTEMPTS):
                candidate = rng.choices(pool, weights=weights)[0]
                if self.fits(candidate, record):
                    offence = candidate
                    break
                same = [o for o in
                        self.by_stem[offenses.stem(candidate["section"])]
                        if self.fits(o, record)]
                if same:
                    offence = rng.choices(
                        same, weights=[self.weight[id(o)] for o in same])[0]
                    break
            if offence is None:
                return None

        # A PWID charge names a substance and the substance sets the OGS, so
        # the era mix has to be applied after the section is chosen rather than
        # as part of the same draw.
        if offence.get("substance"):
            era = next(mix for cutoff, mix in SUBSTANCE_ERAS if year < cutoff)
            wanted = rng.choices(list(era), weights=list(era.values()))[0]
            same = [o for o in self.by_stem[offenses.stem(offence["section"])]
                    if o.get("substance") == wanted and self.fits(o, record)]
            if same:
                offence = rng.choices(
                    same, weights=[self.weight[id(o)] for o in same])[0]
        return offence


# Redraws from the whole catalogue before a draw gives up.
DRAW_ATTEMPTS = 8


def prior_level(offence):
    """The number of priors a grading variant is for; 0 if it names none."""
    return max((int(tag[len("prior_"):]) for tag in offence["conditions"]
                if tag.startswith("prior_")), default=0)


def minimum_age(offence):
    """The youngest age at which this offence is charged."""
    if offenses.stem(offence["section"]) in charging.DRIVING_SECTIONS:
        return charging.DRIVING_AGE
    return charging.MINIMUM_AGE_BY_CATEGORY.get(offence["category"],
                                                MINIMUM_AGE)


class Draw:
    """What one charge draw has to agree with: the person's earlier cases as
    of `year`, their age, and the most serious charge allowed (the lead
    charge's severity, for a companion count)."""

    def __init__(self, cases, year, age, ceiling=None):
        self.cases = cases
        self.year = year
        self.age = age
        self.ceiling = ceiling
        self._prohibitors = None

    def below(self, offence):
        """The same record, capped at `offence`'s severity."""
        return Draw(self.cases, self.year, self.age,
                    sentencing.severity(offence))

    def priors(self, key):
        """Earlier convicted cases charging section `key`, inside its lookback."""
        lookback = charging.PRIOR_LOOKBACK_YEARS.get(key)
        count = 0
        for case in self.cases:
            if not case.get("convicted") or not case.get("disposed"):
                continue
            disposed = int(case["disposed"][:4])
            if disposed > self.year:
                continue
            if lookback is not None and self.year - disposed > lookback:
                continue
            if any(offenses.stem(c["section"]) == key for c in case["charges"]):
                count += 1
        return count

    def prohibitors(self):
        if self._prohibitors is None:
            self._prohibitors = courts.prohibitor_tags(self.cases, self.year)
        return self._prohibitors


# ---------------------------------------------------------------------------
# Case construction
# ---------------------------------------------------------------------------

def date_in(year, rng):
    """A date somewhere in `year`, never after the reference date."""
    year = min(year, REFERENCE.year)
    month = rng.randint(1, 12)
    day = rng.randint(1, 28)
    if year == REFERENCE.year and (month, day) > (REFERENCE.month,
                                                  REFERENCE.day):
        # Redrawn inside the part of the year that has already happened.
        month = rng.randint(1, REFERENCE.month)
        last = min(28, REFERENCE.day) if month == REFERENCE.month else 28
        day = rng.randint(1, last)
    return f"{year:04d}-{month:02d}-{day:02d}"


def add_days(date, days):
    """Crude date arithmetic on an ISO string, good enough for a docket.

    Every month is 30 days here, so a disposition date can land on the 31st of
    a 30-day month or the 30th of February. Using real calendar arithmetic
    would be correct and would also make this file depend on how many days
    each historic month had, for a gain of nothing — nothing in the simulation
    reads a docket date as anything but an ordering.

    The result can fall after the reference date. Callers decide what that
    means: a filing is capped at the reference date, and a disposition past it
    leaves the case pending.
    """
    year, month, day = int(date[:4]), int(date[5:7]), int(date[8:10])
    day += days
    while day > 30:
        day -= 30
        month += 1
        if month > 12:
            month -= 12
            year += 1
    return f"{year:04d}-{month:02d}-{max(1, day):02d}"


def not_after_today(date):
    """`date`, or the reference date if `date` is later."""
    return min(date, TODAY_ISO)


def in_future(date):
    """Whether an ISO date falls after the reference date."""
    return date > TODAY_ISO


def counts_of(offence, rng):
    """How many counts of this offence the case charges.

    Multiple counts are the norm and not noise: one incident of retail theft is
    one count, but a burglary is charged alongside the criminal trespass and
    the theft, and a drug case charges possession and paraphernalia together.
    """
    if offence["category"] == "drug":
        return rng.choices((1, 2, 3), weights=(70, 22, 8))[0]
    if offence["category"] == "property":
        return rng.choices((1, 2, 3, 4), weights=(64, 22, 9, 5))[0]
    return rng.choices((1, 2, 3), weights=(80, 15, 5))[0]


def companion_charges(offence, catalogue, offending_class, year, rng,
                      record=None):
    """The other counts filed alongside the lead charge.

    Real cases are charge-stacked: the average PA criminal case carries three
    to four counts, most of them lesser offences arising from the same
    incident. Generating one charge per case would make every docket look like
    a clean single-count filing, which almost none are.
    """
    extra = []
    companions = charging.COMPANIONS.get(offence["category"], ())
    for _ in range(rng.choices((0, 1, 2, 3), weights=(26, 38, 24, 12))[0]):
        if not companions:
            break
        section = rng.choice(companions)
        # Never more serious than the lead charge, which the ceiling enforces,
        # and held to the same priors and prohibitions as the lead: a companion
        # count is a lesser included or related offence of the same incident.
        ceiling = (record or Draw((), year, None)).below(offence)
        companion = catalogue.draw(offending_class, year, rng, section=section,
                                   record=ceiling)
        # Never a duplicate of the lead charge.
        if companion and companion is not offence:
            extra.append(companion)
    return extra


def mark_pending(record):
    """Turn a case whose disposition falls after the reference date into an
    open one. Pending cases are not convictions: they do not score for PRS,
    and they feed no firearms prohibition, licence suspension or sealing."""
    record["disposition"] = "pending"
    record["disposed"] = None
    if "convicted" in record:
        record["convicted"] = False
    record["counts_for_prs"] = False
    if "fine" in record:
        record["fine"] = None


def build_case(person, identity, offence, catalogue, offending_class, year,
               prior_score, registry, rng, juvenile=False, record=None):
    """One criminal case: charges, court, disposition and sentence."""
    race = person["race_ethnicity"]
    lead = offence
    charges = [lead] + companion_charges(
        lead, catalogue, offending_class, year, rng, record)

    summary_only = all(o["grade"] == "S" for o in charges)
    felony = any(offenses.felony(o) for o in charges)

    arrest = date_in(year, rng)
    district = registry.magisterial_district(rng)

    record = {
        "person": person["id"],
        "arrest_date": arrest,
        "offence_year": year,
        "age_at_offence": year - identity_birth_year(identity),
        "juvenile": juvenile,
        "charges": [{
            "cite": o["cite"],
            "section": o["section"],
            "description": o["description"],
            "grade": o["grade"],
            "ogs": o.get("ogs"),
            "category": o["category"],
            "counts": counts_of(o, rng),
        } for o in charges],
        "lead_charge": lead["cite"],
        "felony_charged": felony,
    }

    if juvenile:
        filed_jv = not_after_today(add_days(arrest, rng.randint(1, 30)))
        # Juvenile delinquency: a petition, not a criminal complaint, and an
        # adjudication rather than a conviction. Sealed from public view and
        # worth nothing for PRS, which is why a long juvenile record does not
        # lengthen an adult sentence.
        record.update({
            "court": "juvenile",
            "filed": filed_jv,
            # Numbered by the year the petition was filed, not the year of the
            # offence. An arrest in late December is a case of the following
            # year, and a docket whose year disagrees with its own filing date
            # is the first thing anyone would notice.
            "docket": registry.next_docket(
                "common_pleas", int(filed_jv[:4]), "JV"),
            "disposition": rng.choices(
                ("adjudicated_delinquent", "consent_decree", "withdrawn",
                 "informal_adjustment", "dismissed"),
                weights=(44, 20, 14, 14, 8))[0],
            "public": False,
            "counts_for_prs": False,
        })
        record["disposed"] = add_days(record["filed"], rng.randint(30, 210))
        if in_future(record["disposed"]):
            mark_pending(record)
        return record

    if summary_only:
        # Tried in front of the magisterial district judge and never docketed
        # at Common Pleas. This is most of the volume and almost none of the
        # consequence, which is exactly why the 35% arrest figure and the 20%
        # court-case figure are different numbers.
        disposition = rng.choices([d for d, _ in courts.SUMMARY_DISPOSITIONS],
                                  weights=[w for _, w in courts.SUMMARY_DISPOSITIONS])[0]
        filed_summary = not_after_today(add_days(arrest, rng.randint(0, 14)))
        record.update({
            "court": "magisterial",
            "district": district,
            "docket": registry.next_docket(
                "magisterial", int(filed_summary[:4]), "NT", district),
            "filed": filed_summary,
            "disposition": disposition,
            "convicted": disposition == "guilty",
            "counts_for_prs": False,
            "fine": rng.choice((25, 50, 100, 150, 300)) if disposition == "guilty"
                    else None,
            "public": True,
        })
        record["disposed"] = add_days(record["filed"], rng.randint(21, 120))
        if in_future(record["disposed"]):
            mark_pending(record)
        return record

    # A misdemeanour or felony. Both start at the magisterial court with a
    # criminal complaint and a preliminary hearing, and both carry an MJ docket
    # that survives even when the case is held for court — which is why a
    # person can have two docket numbers for one arrest.
    complaint = not_after_today(add_days(arrest, rng.randint(0, 3)))
    mj_docket = registry.next_docket(
        "magisterial", int(complaint[:4]), "CR", district)

    # Held for court, or dismissed at the preliminary hearing.
    held = rng.random() < (0.94 if felony else 0.91)
    if not held:
        record.update({
            "court": "magisterial",
            "district": district,
            "docket": mj_docket,
            "filed": complaint,
            "disposition": "dismissed_at_preliminary",
            "convicted": False,
            "counts_for_prs": False,
            "public": True,
        })
        record["disposed"] = add_days(record["filed"], rng.randint(14, 90))
        if in_future(record["disposed"]):
            mark_pending(record)
        return record

    weights = []
    for label, share in courts.DISPOSITIONS:
        if label == "ard":
            # Diversion is for people without a record and without a violent
            # charge, and access is unequal at equivalent charge and record.
            share *= ARD_ACCESS.get(race, 1.0)
            if prior_score > 0 or felony:
                share *= 0.18
        elif label in ("guilty_plea", "guilty_verdict") and felony:
            share *= 1.12
        weights.append(share)
    disposition = rng.choices([d for d, _ in courts.DISPOSITIONS], weights=weights)[0]

    convicted = disposition in ("guilty_plea", "guilty_verdict")
    filed = not_after_today(add_days(arrest, rng.randint(20, 90)))
    # Median time to disposition at Common Pleas runs several months, and a
    # tried case takes far longer than a plea.
    elapsed = rng.randint(240, 700) if disposition in (
        "guilty_verdict", "acquitted") else rng.randint(75, 400)

    record.update({
        "court": "common_pleas",
        "district": district,
        "magisterial_docket": mj_docket,
        "docket": registry.next_docket("common_pleas", int(filed[:4]), "CR"),
        "filed": filed,
        "disposed": add_days(filed, elapsed),
        "disposition": disposition,
        "convicted": convicted,
        "counts_for_prs": convicted,
        "prior_record_score": prior_score,
        "public": True,
        # Pretrial detention, which is a fact about the case independent of its
        # outcome and one of the strongest predictors of that outcome.
        "detained_pretrial": rng.random() < min(0.9, (
            0.42 if felony else 0.19) * DETENTION_MULTIPLIER.get(race, 1.0)),
        "bail": None,
    })
    if not record["detained_pretrial"]:
        record["bail"] = rng.choice((0, 0, 2500, 5000, 10000, 25000, 50000))

    if in_future(record["disposed"]):
        # Still open on the reference date: no outcome, no sentence, and
        # nothing that a conviction would feed.
        mark_pending(record)
        record["sentence"] = None
        return record

    if convicted:
        # Sentenced on the most serious count, which is what drives the
        # guidelines. Concurrent sentences on the companion counts are the norm
        # and are not modelled separately.
        top = max(charges, key=sentencing.severity)

        # The plea bargain, which is the mechanism the whole system runs on and
        # the reason felony *filings* and felony *convictions* are different
        # numbers. A felony charged and pled down to a misdemeanour leaves a
        # docket that still shows the felony count and a criminal history that
        # does not. Without this, matching the 27% felony filing rate forces
        # the felony conviction rate several points too low.
        record["pled_down"] = False
        # Homicide is excluded: a murder charge pleads down to a lesser degree
        # of murder or to manslaughter, never to a misdemeanour, and the
        # catalogue has no row for that.
        if disposition == "guilty_plea" and offenses.felony(top) \
                and not top.get("homicide") and sentencing.severity(top) < 100 \
                and rng.random() < 0.20:
            lesser = [o for o in charges if not offenses.felony(o)
                      and o["grade"] != "S"]
            if lesser:
                top = max(lesser, key=sentencing.severity)
            else:
                # Nothing lesser was charged, so the plea is to a graded-down
                # version of the same offence — a very common disposition that
                # the catalogue has no row for.
                top = dict(top, grade={"F-1": "F-3", "F-2": "F-3",
                                       "F-3": "M-1", "F": "M-1"}.get(
                                           top["grade"], "M-1"),
                           ogs=max(1, (sentencing.ogs_of(top) or 4) - 3),
                           description=top["description"] + " (as pled)")
            record["pled_down"] = True

        record["convicted_of"] = top["cite"]
        record["conviction_grade"] = top["grade"]
        record["felony_convicted"] = offenses.felony(top)
        record["sentence"] = sentencing.sentence(
            top, prior_score, RANGE_POSITION.get(race, 0.0), rng)
        record["sentence"]["start"] = record["disposed"]
        record["pog"] = top.get("pog")
    else:
        record["sentence"] = None
        if disposition == "ard":
            # ARD completion means an expungement, and most people complete.
            record["expunged"] = rng.random() < 0.86
    return record


def identity_birth_year(identity):
    return int(identity["birth_date"][:4])


# ---------------------------------------------------------------------------
# Supervision and custody, as of today
# ---------------------------------------------------------------------------


def custody_status(cases):
    """Whether this person is in custody or under supervision right now.

    Derived from the sentences rather than drawn, which is the only way the
    0.5-1% currently-incarcerated figure can be consistent with the sentence
    lengths — draw it independently and the city ends up with people in prison
    on sentences that ended years ago.
    """
    status = {"incarcerated": False, "supervision": None,
              "facility": None, "release_year": None}
    for case in cases:
        if case.get("disposition") == "pending" and case.get("detained_pretrial"):
            # Held in the county jail awaiting disposition. No release year:
            # it depends on an outcome that has not happened.
            status["incarcerated"] = True
            status["facility"] = status["facility"] or f"{COUNTY} Jail"
            continue
        sentence = case.get("sentence")
        if not sentence:
            continue
        start = int(sentence["start"][:4])
        if sentence["kind"] == "probation":
            end = start + (sentence["probation_months"] or 0) / 12
            if start <= TODAY < end:
                status["supervision"] = "probation"
            continue

        if sentence.get("life_without_parole"):
            # No release date, so the only question is whether they are still
            # alive — and if they are in the household population at all, they
            # are not in custody. A lifer in a state institution is a
            # group-quarters resident, which is where PUMS puts them.
            status["incarcerated"] = True
            status["facility"] = LAW.state_prison
            status["release_year"] = None
            continue

        served = (sentence["rrri_months"] or sentence["minimum_months"]) / 12
        out = start + served
        if start <= TODAY < out:
            status["incarcerated"] = True
            status["facility"] = (LAW.state_prison
                                  if sentence["kind"] == "state_prison"
                                  else f"{COUNTY} Jail")
            status["release_year"] = int(out)
        elif out <= TODAY < start + sentence["maximum_months"] / 12:
            # Released on parole, still serving the sentence. State parole is
            # supervised by the Board of Probation and Parole and county parole
            # by the county, which is a real distinction in who holds the file.
            status["supervision"] = (
                "state_parole" if sentence["kind"] == "state_prison"
                else "county_parole")
        elif sentence.get("probation_months"):
            end = start + (sentence["maximum_months"]
                           + sentence["probation_months"]) / 12
            if TODAY < end:
                status["supervision"] = "probation"
    return status


# ---------------------------------------------------------------------------
# Non-criminal dockets
# ---------------------------------------------------------------------------

# Civil and family filing rates, per adult per year. These are the records that
# make a person's court history look like a real one: most people who have ever
# been in court were there over a debt, a divorce or a landlord, not a crime.
#
# Set from *lifetime* prevalence rather than from annual filing counts, which is
# the calibration that matters and the one that is easy to get wrong by an order
# of magnitude. An annual rate applied across a fifty-year adult life compounds:
# the county's real eviction filing rate of about 6% of renter households a year
# does not mean 6% of renters have ever been evicted, and reading it as a
# per-person hazard put half the city in small claims court. The targets here are
# lifetime — roughly a quarter of long-term renters ever filed against, 4-5% of
# adults ever bankrupt, 6-8% ever party to a PFA.
CIVIL_RATES = {
    # Magisterial civil: small claims and landlord-tenant, the highest volume
    # court in the county and overwhelmingly against renters.
    "landlord_tenant": 0.0135,
    "small_claims": 0.0040,
    # Common Pleas civil.
    "civil_judgment": 0.0032,
    "mortgage_foreclosure": 0.0016,
    "protection_from_abuse": 0.0021,
}

# Bankruptcy, per adult per year, and the chapter split. Chapter 13 is the
# repayment plan and chapter 7 the liquidation; PA files more 13s than the
# national average.
BANKRUPTCY_RATE = 0.0011
BANKRUPTCY_CHAPTERS = ((7, 0.62), (13, 0.38))


def civil_cases(person, identity, registry, rng, renter, mortgaged):
    """Non-criminal dockets over an adult lifetime."""
    cases = []
    birth = identity_birth_year(identity)
    for year in range(birth + ADULT_AGE, TODAY + 1):
        for kind, rate in CIVIL_RATES.items():
            adjusted = rate
            # Tenure decides which of these are even possible. A homeowner does
            # not get evicted and a renter does not get foreclosed on, and
            # generating both for everyone would be the most obvious kind of
            # wrong.
            if kind in ("landlord_tenant",):
                adjusted = rate * (1.0 if renter else 0.02)
            elif kind == "mortgage_foreclosure":
                adjusted = rate * (1.0 if mortgaged else 0.0)
            if rng.random() >= adjusted:
                continue
            magisterial = kind in ("landlord_tenant", "small_claims")
            district = registry.magisterial_district(rng)
            filed = date_in(year, rng)
            case = {
                "person": person["id"],
                "kind": kind,
                "court": "magisterial" if magisterial else "common_pleas",
                "filed": filed,
                "docket": registry.next_docket(
                    "magisterial" if magisterial else "common_pleas",
                    year, "CV", district if magisterial else None),
                "public": True,
                # The person here is the defendant in a debt or eviction case
                # and the plaintiff in a PFA, which is the difference between a
                # record that harms them and one that protects them.
                "role": "plaintiff" if kind == "protection_from_abuse"
                        else "defendant",
            }
            if kind in ("landlord_tenant", "small_claims", "civil_judgment"):
                case["amount"] = rng.choice(
                    (450, 900, 1200, 1800, 2400, 3600, 6000, 12000))
                case["outcome"] = rng.choices(
                    ("judgment_for_plaintiff", "settled", "withdrawn",
                     "judgment_for_defendant"),
                    weights=(58, 22, 14, 6))[0]
            elif kind == "protection_from_abuse":
                case["outcome"] = rng.choices(
                    ("final_order", "consent_order", "withdrawn", "denied"),
                    weights=(38, 26, 26, 10))[0]
                case["order_months"] = 36 if case["outcome"] in (
                    "final_order", "consent_order") else None
            else:
                case["outcome"] = rng.choices(
                    ("judgment_in_rem", "settled", "discontinued"),
                    weights=(46, 30, 24))[0]
            case["disposed"] = add_days(filed, rng.randint(30, 500))
            if in_future(case["disposed"]):
                # Open on the reference date. An open PFA petition carries no
                # final order and so no order term.
                case["outcome"] = "pending"
                case["disposed"] = None
                if "order_months" in case:
                    case["order_months"] = None
            cases.append(case)

        if rng.random() < BANKRUPTCY_RATE:
            chapter = rng.choices([c for c, _ in BANKRUPTCY_CHAPTERS],
                                  weights=[w for _, w in BANKRUPTCY_CHAPTERS])[0]
            filed = date_in(year, rng)
            bankruptcy = {
                "person": person["id"],
                "kind": "bankruptcy",
                "court": "federal",
                "chapter": chapter,
                "filed": filed,
                # Federal, not county: bankruptcy jurisdiction is exclusively
                # federal, so this is the one record here with an EDPA number.
                "docket": registry.next_docket(
                    "federal", year, "bk",
                    base=10_000 if chapter == 7 else 20_000),
                "role": "debtor",
                "public": True,
                "outcome": rng.choices(
                    ("discharged", "dismissed", "converted"),
                    weights=(74 if chapter == 7 else 48,
                             20 if chapter == 7 else 44, 6 if chapter == 7 else 8))[0],
                "disposed": add_days(filed, rng.randint(
                    100, 200) if chapter == 7 else rng.randint(700, 1900)),
            }
            if in_future(bankruptcy["disposed"]):
                bankruptcy["outcome"] = "pending"
                bankruptcy["disposed"] = None
            cases.append(bankruptcy)
    return cases


def family_cases(person, identity, registry, rng):
    """Marriage, divorce and the support and custody cases that follow.

    Driven by MAR and MARHT, which are surveyed: how many times this person has
    married and how the last marriage ended are facts, and this only supplies
    the paperwork. A marriage licence is not a docket — it comes from the Clerk
    of Orphans' Court — so it carries a licence number instead.
    """
    marital = identity["marital"]
    status, times = marital["status"], marital["times_married"] or 0
    if status == "never_married" or not times:
        return []

    cases = []
    birth = identity_birth_year(identity)
    last = marital["married_year"]
    # Working backwards from the most recent marriage, which is the one PUMS
    # dates. Earlier ones are spaced before it.
    years = [last] if last else [birth + 26]
    for index in range(1, times):
        years.insert(0, years[0] - rng.randint(4, 12))

    for index, year in enumerate(years):
        year = max(year, birth + 16)
        cases.append({
            "person": person["id"],
            "kind": "marriage_licence",
            "court": "clerk_of_orphans_court",
            "filed": date_in(year, rng),
            # The county's licence numbering, sequential within a year.
            "docket": registry.next_licence_number("marriage", year),
            "role": "applicant",
            "public": True,
            "marriage_number": index + 1,
        })
        # Every marriage but the last ended, and the last one ended too unless
        # this person is currently married.
        final = index == len(years) - 1
        ended = not final or status in ("divorced", "separated", "widowed")
        if not ended or status == "widowed" and final:
            continue
        filed_year = min(TODAY, year + rng.randint(2, 18))
        filed = date_in(filed_year, rng)
        divorce = {
            "person": person["id"],
            "kind": "divorce",
            "court": "common_pleas",
            "filed": filed,
            "docket": registry.next_docket("common_pleas", filed_year, "CV"),
            "role": rng.choice(("plaintiff", "defendant")),
            "public": True,
            # § 3301(c) mutual consent and § 3301(d) two-year separation are the
            # no-fault grounds and are how almost every PA divorce is filed.
            "grounds": rng.choices(
                [g for g, _ in courts.DIVORCE_GROUNDS],
                weights=[w for _, w in courts.DIVORCE_GROUNDS])[0],
            "outcome": rng.choices(("decree_entered", "discontinued"),
                                   weights=(84, 16))[0],
            "disposed": add_days(filed, rng.randint(120, 900)),
        }
        if in_future(divorce["disposed"]):
            if final and status == "separated":
                # Separated is a divorce still in progress.
                divorce["outcome"] = "pending"
                divorce["disposed"] = None
            else:
                # The survey says this marriage has ended, so the decree is
                # entered no later than the reference date.
                divorce["disposed"] = TODAY_ISO
        cases.append(divorce)
        # Support follows a divorce with children, and is a separate docket in
        # the domestic relations section.
        if rng.random() < 0.46:
            cases.append({
                "person": person["id"],
                "kind": "child_support",
                "court": "common_pleas",
                "filed": not_after_today(add_days(filed, rng.randint(0, 200))),
                "docket": registry.next_docket("common_pleas", filed_year, "DR"),
                "role": rng.choice(("obligor", "obligee")),
                "public": False,
                "monthly": rng.choice((180, 260, 340, 420, 560, 720, 900)),
            })
    return cases


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------

def criminal_history(person, identity, catalogue, registry, seed, attempt=0):
    """Every criminal case one person has ever had, in order.

    `attempt` above 0 draws an alternative history from its own stream; see
    ROLE_SCREEN for when one is needed.
    """
    rng = (keyed(seed, person["id"], "crime") if not attempt
           else keyed(seed, person["id"], "crime", attempt))
    birth = identity_birth_year(identity)
    age = person["age"]
    race = person["race_ethnicity"]

    offending_class = assign_class(person["sex"], rng)
    profile = CLASSES[offending_class]

    contact = CONTACT_MULTIPLIER.get(race, 1.0)
    events = []
    desisted = False

    for current in range(MINIMUM_AGE, age + 1):
        year = birth + current
        if year > TODAY:
            break

        # Class-driven offending.
        if profile["base"] and not desisted:
            rate = profile["base"] * age_rate(profile, current)
            # Poisson, approximated by repeated Bernoulli draws — the rates
            # here are low enough that the difference is immaterial and this
            # keeps the per-offence category draw in the same loop.
            for _ in range(3):
                if rng.random() < rate / 3:
                    events.append((year, current, offending_class))
            if current > profile["peak"] and rng.random() < profile["desist"]:
                desisted = True

        # The independent situational hazard, which everyone is exposed to.
        if rng.random() < next(p for bound, p in SITUATIONAL_BY_AGE
                              if current <= bound):
            events.append((year, current, "situational"))

    cases = []
    prior_score = 0
    priors = []
    for year, current, source in events:
        record = Draw(cases, year, current)
        if source == "situational":
            # Only the parts of the mix this person is old enough for: a
            # fourteen-year-old's one-off offence is a fight, not a DUI.
            mix = [(s, w) for s, w in charging.SITUATIONAL_MIX
                   if current >= situational_age(s, catalogue)]
            if not mix:
                continue
            section = rng.choices([s for s, _ in mix],
                                  weights=[w for _, w in mix])[0]
            offence = catalogue.draw(offending_class, year, rng,
                                     section=section, record=record)
        else:
            offence = catalogue.draw(offending_class, year, rng, record=record)
        if offence is None:
            continue

        # Offending to arrest. Discretion-heavy offences carry more of the
        # racial disparity, because that is where an officer's decision is what
        # generates the record.
        multiplier = contact
        if offence["category"] in DISCRETIONARY:
            multiplier *= DISCRETION_BOOST
        chance = ARREST_GIVEN_OFFENCE.get(offence["category"], 0.25) * multiplier
        if rng.random() >= min(0.95, chance):
            continue

        juvenile = current < ADULT_AGE and not (
            current >= charging.DIRECT_FILE_AGE and offenses.felony(offence)
            and rng.random() < 0.22)

        case = build_case(person, identity, offence, catalogue, offending_class,
                          year, prior_score, registry, rng, juvenile=juvenile,
                          record=record)
        cases.append(case)

        if case.get("counts_for_prs") and case.get("pog"):
            priors.append({"pog": case["pog"]})
            prior_score = offenses.prs(priors)

    courts.apply_clean_slate(cases)
    return offending_class, cases


def situational_age(section, catalogue):
    """The youngest age any variant of a situational section is charged at."""
    variants = catalogue.by_stem.get(section, ())
    return min((minimum_age(o) for o in variants), default=MINIMUM_AGE)


def order_dockets(records):
    """Renumber every series so its sequence runs in filing-date order.

    A docket number is a filing-order stamp: case 300 of 2019 was filed after
    case 200 of 2019, always, and anyone reasoning about a set of records will
    use that. The numbers here come out in whatever order the population happens
    to be iterated in, which is deliberately shuffled — so within a year they
    are uncorrelated with the dates beside them, and the one inference a docket
    number supports is the one it would get wrong.

    Fixed by permutation rather than by allocating differently: the set of
    numbers issued in each series is already right, so this only reassigns which
    record holds which, in date order. That keeps the gaps and the starting
    offsets the allocator produced.
    """
    series = defaultdict(list)
    for record in records:
        for field in ("docket", "magisterial_docket"):
            if record.get(field):
                key, sequence, width = formats.series_of(record[field])
                series[key].append((record, field, sequence, width))

    for key, entries in series.items():
        numbers = sorted(sequence for _, _, sequence, _ in entries)
        # Sorted on the filing date, falling back on the arrest date for the
        # magisterial numbers, which are allocated at the complaint.
        entries.sort(key=lambda entry: (entry[0].get("filed")
                                        or entry[0].get("arrest_date") or ""))
        for (record, field, _, width), sequence in zip(entries, numbers):
            parts = list(key)
            parts[parts.index(None)] = f"{sequence:0{width}d}"
            record[field] = "-".join(parts)


# The primary-class roles init_work.py staffs, and whether the post also bars a
# felony conviction. Staffing runs before this stage because identity, ties and
# the rest sit between them, so the roster cannot be built around the court
# record. The record is fitted to the roster instead: a person holding one of
# these posts gets the first of their alternative histories that leaves them
# out of custody, with a driver licence that is not suspended (every one of
# these posts drives) and, where barred, without a felony conviction, which is
# the hiring screen applied after the fact.
ROLE_SCREEN = {"police_officer": True, "paramedic": True, "emt": True,
               "school_bus_driver": True, "taxi_driver": False}
SCREEN_ATTEMPTS = 25


def suspended_now(cases):
    """Whether a conviction suspends this person's licence on the reference
    date, by the same table and rule holdings.py applies."""
    table = LAW.licensing.suspension_months
    for case in cases:
        if not case.get("convicted") or not case.get("disposed"):
            continue
        for charge in case["charges"]:
            months = table.get(offenses.stem(charge["section"])) \
                or table.get(charge["section"])
            if months and int(case["disposed"][:4]) + months / 12 > TODAY:
                return True
    return False


def passes_screen(cases, custody, felony_bar):
    if custody["incarcerated"] or suspended_now(cases):
        return False
    return not (felony_bar and any(c.get("felony_convicted") for c in cases))


def build(population, identities, seed, roles=None):
    """Every docket in the city, plus the derived status of every person.

    `roles` is {person id: primary role key} from employment.json.
    """
    catalogue = Catalogue()
    registry = registries.Registries(seed)
    roles = roles or {}

    people = population["person_records"] + population["quarters_records"]
    tenure = household_tenure(population)

    criminal, civil, status, classes = [], [], {}, {}
    unscreened = 0
    for person in people:
        identity = identities[str(person["id"])]
        role = roles.get(person["id"])
        for attempt in range(SCREEN_ATTEMPTS if role else 1):
            offending_class, cases = criminal_history(
                person, identity, catalogue, registry, seed, attempt)
            if role is None or passes_screen(
                    cases, custody_status(cases), ROLE_SCREEN.get(role, False)):
                break
        else:
            unscreened += 1
        classes[person["id"]] = offending_class
        criminal.extend(cases)

        own_civil = []
        if person["age"] >= ADULT_AGE:
            rng = keyed(seed, person["id"], "civil")
            renter, mortgaged = tenure.get(person.get("household"),
                                           (True, False))
            own_civil = civil_cases(person, identity, registry, rng,
                                    renter, mortgaged)
            own_civil += family_cases(person, identity, registry, rng)
            civil.extend(own_civil)

        status[person["id"]] = custody_status(cases)
        status[person["id"]]["offending_class"] = offending_class
        # PFA orders live in the civil list, so the prohibition has to see both.
        status[person["id"]]["firearms_prohibited"] = courts.firearms_prohibition(
            cases + own_civil, keyed(seed, person["id"], "prohibitor"))
    # Last, because it needs every record in a series at once: the numbers are
    # already allocated, this only makes them run in date order.
    order_dockets(criminal)
    order_dockets(civil)
    if unscreened:
        print(f"{unscreened} staffed people kept a record their post screens "
              f"out after {SCREEN_ATTEMPTS} attempts")
    return criminal, civil, status


# Work fields on a person record that put them on the road to a job.
WORK_FIELDS = ("employment", "occupation", "soc", "industry", "hours", "depart",
               "arrive", "travel", "transport", "worker_class", "work_puma")
# ESR 6: not in the labor force.
NOT_IN_LABOR_FORCE = 6


def apply_custody(population, employment, status):
    """Write custody onto every person record and take the people in custody
    out of work.

    Each person gets `incarcerated` and `custody_facility`. A person in custody
    loses their job fields and their employment.json assignment, both kept
    under `custody_work` and `custody_removed` so a re-run of this stage
    restores them before applying its own custody set. Returns how many
    assignments were withdrawn.
    """
    # Undo the previous run's pass first.
    removed = sorted(employment.pop("custody_removed", []),
                     key=lambda entry: entry["index"])
    for entry in removed:
        employment["assignments"].insert(entry["index"], entry["assignment"])
    for person in population["person_records"] + population["quarters_records"]:
        if "custody_work" in person:
            person.update(person.pop("custody_work"))

    held = set()
    for person in population["person_records"] + population["quarters_records"]:
        custody = status[person["id"]]
        person["incarcerated"] = custody["incarcerated"]
        person["custody_facility"] = (custody["facility"]
                                      if custody["incarcerated"] else None)
        if not custody["incarcerated"]:
            continue
        held.add(person["id"])
        if person.get("employment") in (1, 2):
            person["custody_work"] = {f: person.get(f) for f in WORK_FIELDS}
            for field in WORK_FIELDS:
                person[field] = None
            person["employment"] = NOT_IN_LABOR_FORCE

    kept, withdrawn = [], []
    for index, assignment in enumerate(employment["assignments"]):
        if assignment["person"] in held:
            withdrawn.append({"index": index, "assignment": assignment})
        else:
            kept.append(assignment)
    employment["assignments"] = kept
    if withdrawn:
        employment["custody_removed"] = withdrawn
    return len(withdrawn)


def apply_phone_custody(population, identities):
    """Withdraw personal phone numbers in custody; restore them on release."""
    for person in population["person_records"] + population["quarters_records"]:
        record = identities.get(str(person["id"]))
        if record is None:
            continue
        if "custody_phone" in record:
            record.update(record.pop("custody_phone"))
        if person.get("incarcerated"):
            record["custody_phone"] = {field: record.get(field)
                                       for field in ("mobile", "landline")}
            record["mobile"] = None
            record["landline"] = None


def household_tenure(population):
    """{household id: (renter, mortgaged)} — from TEN, for the civil rates."""
    # TEN is on the household, and dwellings.json does not carry it, so it is
    # read back off the survey through the householder's provenance. Renting is
    # the default for a household whose householder cannot be matched, since
    # 55% of this city rents.
    tenure = {h["id"]: (True, False) for h in population["household_records"]}
    survey = pums.rows_by_person()
    for person in population["person_records"]:
        if person["relationship"] != 20:
            continue
        row = survey.get((person["serialno"], person["sporder"]))
        if not row:
            continue
        # TEN 1 owned with a mortgage, 2 owned free and clear, 3 rented,
        # 4 occupied without rent, 0 not applicable.
        code = row.get("TEN")
        tenure[person["household"]] = (code in ("3", "4"), code == "1")
    return tenure


def report(criminal, civil, status, population):
    """The prevalence marginals, the concentration, and the case volume."""
    people = population["person_records"] + population["quarters_records"]
    adults = [p for p in people if p["age"] >= ADULT_AGE]
    adult_ids = {p["id"] for p in adults}
    by_person = defaultdict(list)
    for case in criminal:
        by_person[case["person"]].append(case)

    print(f"{len(criminal):,} criminal cases and {len(civil):,} civil, family "
          f"and bankruptcy dockets over {len(people):,} residents\n")

    def share(predicate, label, target=None):
        count = sum(1 for p in adults if predicate(by_person[p["id"]]))
        line = (f"  {label:<28} {count:>7,}  "
                f"{count / len(adults) * 100:5.1f}%")
        if target:
            line += f"   target {target}"
        print(line)

    print("prevalence among adults:")
    share(lambda cases: bool(cases), "ever arrested", "35%")
    share(lambda cases: any(c["court"] == "common_pleas" for c in cases),
          "ever a Common Pleas case")
    share(lambda cases: any(c.get("convicted") for c in cases),
          "ever convicted", "25-30%")
    # Convicted *of* a felony, not merely charged with one — the plea-down is
    # the difference and it is roughly a third of felony pleas.
    share(lambda cases: any(c.get("felony_convicted") for c in cases),
          "ever a felony conviction", "10-12%")
    share(lambda cases: any(c["felony_charged"] and not c.get("felony_convicted")
                            and c.get("convicted") for c in cases),
          "felony charged, pled down")
    share(lambda cases: any(
        (c.get("sentence") or {}).get("kind") in ("county_jail", "state_prison")
        for c in cases), "ever incarcerated", "5-7%")

    supervised = sum(1 for p in adults if status[p["id"]]["supervision"])
    inside = sum(1 for p in adults if status[p["id"]]["incarcerated"])
    print(f"  {'under supervision now':<28} {supervised:>7,}  "
          f"{supervised / len(adults) * 100:5.1f}%   target 2-4%")
    print(f"  {'incarcerated now':<28} {inside:>7,}  "
          f"{inside / len(adults) * 100:5.1f}%   target 0.5-1%")

    # The concentration check, and the one that separates this from a set of
    # independent coin flips. Wolfgang found 6% of a cohort responsible for 52%
    # of offences; anything much flatter than that means the latent classes are
    # not doing their job.
    counts = sorted((len(by_person[p["id"]]) for p in adults), reverse=True)
    top = int(len(adults) * 0.06)
    print(f"\nconcentration: the most-charged 6% of adults hold "
          f"{sum(counts[:top]) / max(1, sum(counts)) * 100:.0f}% of all cases "
          f"(Wolfgang: 52%)")
    charged = [c for c in counts if c]
    print(f"  {len(charged):,} adults have at least one case, "
          f"{sum(1 for c in counts if c >= 5):,} have five or more, "
          f"most on one record: {counts[0]}")

    print("\noffending class:")
    classes = Counter(status[p["id"]]["offending_class"] for p in adults)
    width = max(len(k) for k in classes)
    for label, count in classes.most_common():
        cases = sum(len(by_person[p["id"]]) for p in adults
                    if status[p["id"]]["offending_class"] == label)
        print(f"  {label:<{width}}  {count:>7,}  "
              f"{count / len(adults) * 100:5.1f}% of adults  "
              f"{cases:>7,} cases  {cases / max(1, len(criminal)) * 100:5.1f}%")

    print("\nby race and ethnicity — arrest, conviction and incarceration:")
    races = Counter(p["race_ethnicity"] for p in adults)
    width = max(len(k) for k in races)
    print(f"  {'':<{width}}  {'adults':>7}  {'arrest':>7}  {'convict':>8}  "
          f"{'prison':>7}")
    for race, total in races.most_common():
        cohort = [p for p in adults if p["race_ethnicity"] == race]
        arrested = sum(1 for p in cohort if by_person[p["id"]])
        convicted = sum(1 for p in cohort
                        if any(c.get("convicted") for c in by_person[p["id"]]))
        prison = sum(1 for p in cohort if any(
            (c.get("sentence") or {}).get("kind") == "state_prison"
            for c in by_person[p["id"]]))
        print(f"  {race:<{width}}  {total:>7,}  "
              f"{arrested / total * 100:6.1f}%  {convicted / total * 100:7.1f}%  "
              f"{prison / total * 100:6.1f}%")

    cp = [c for c in criminal if c["court"] == "common_pleas"]
    cp_felony = sum(1 for c in cp if c["felony_charged"])
    # Deliberately printed without a target. The AOPC 27.1% felony figure is a
    # share of *all* criminal filings, magisterial included, and most
    # misdemeanour and summary matters never reach Common Pleas — so the felony
    # share of held-for-court cases is necessarily much higher. The comparable
    # number is the second line.
    print(f"\nfelony share of Common Pleas filings:  "
          f"{cp_felony / max(1, len(cp)) * 100:5.1f}%")
    all_felony = sum(1 for c in criminal if c["felony_charged"])
    print(f"felony share of all criminal filings: "
          f"{all_felony / max(1, len(criminal)) * 100:5.1f}%   AOPC 2024: 27.1%")

    print(f"\nCommon Pleas criminal filings by year ({COUNTY} 2024: ~1,700; "
          "city is a third of the county):")
    filings = Counter(int(c["filed"][:4]) for c in criminal
                      if c["court"] == "common_pleas")
    for year in range(TODAY - 6, TODAY):
        print(f"  {year}  {filings[year]:>6,}")

    print("\ndisposition of Common Pleas cases:")
    dispositions = Counter(c["disposition"] for c in criminal
                           if c["court"] == "common_pleas")
    total = sum(dispositions.values())
    width = max(len(k) for k in dispositions)
    for label, count in dispositions.most_common():
        print(f"  {label:<{width}}  {count:>7,}  {count / total * 100:5.1f}%")

    print("\nlead charge, most common:")
    leads = Counter(c["charges"][0]["description"][:52] for c in criminal)
    for label, count in leads.most_common(14):
        print(f"  {count:>6,}  {label}")

    print("\ngrade of the most serious charge filed:")
    grades = Counter()
    for case in criminal:
        order = ["S", "M-3", "M-2", "M", "M-1", "F-3", "F", "F-2", "F-1", None]
        grades[max((c["grade"] for c in case["charges"]),
                   key=lambda g: order.index(g) if g in order else 0)] += 1
    for label, count in grades.most_common():
        print(f"  {str(label):<5}  {count:>7,}  "
              f"{count / len(criminal) * 100:5.1f}%")

    prohibited = sum(1 for p in adults if status[p["id"]]["firearms_prohibited"])
    print(f"\nfirearms: {prohibited:,} adults ({prohibited / len(adults) * 100:.1f}%) "
          f"are prohibited from possessing one under § 6105")

    sealed = sum(1 for c in criminal if c.get("sealed"))
    convicted = sum(1 for c in criminal if c.get("convicted"))
    print(f"\nClean Slate: {sealed:,} of {convicted:,} convictions "
          f"({sealed / max(1, convicted) * 100:.0f}%) are sealed under "
          f"§ 9122.2")

    print("\nsentences imposed:")
    kinds = Counter((c["sentence"] or {}).get("kind") for c in criminal
                    if c.get("sentence"))
    for label, count in kinds.most_common():
        print(f"  {str(label):<14}  {count:>7,}")
    county = kinds.get("county_jail", 0)
    state = kinds.get("state_prison", 0)
    print(f"  county:state ratio {county / max(1, state):.2f}:1  "
          f"KNOWN DEVIATION, target ~2:1 (too many minimums above the "
          f"24-month county ceiling; see OGS_BASE)")

    custodial = [c["sentence"] for c in criminal
                 if c.get("sentence") and c["sentence"]["minimum_months"]]
    if custodial:
        minima = sorted(s["minimum_months"] for s in custodial)
        print(f"  median minimum {minima[len(minima) // 2]} months, "
              f"longest {minima[-1]} months")

    print("\ncivil, family and bankruptcy dockets:")
    kinds = Counter(c["kind"] for c in civil)
    width = max(len(k) for k in kinds)
    for label, count in kinds.most_common():
        holders = len({c["person"] for c in civil if c["kind"] == label})
        print(f"  {label:<{width}}  {count:>7,}  "
              f"{holders / len(adults) * 100:5.1f}% of adults have one")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    args = parser.parse_args()

    population = json.loads(POPULATION.read_text())
    identity_file = json.loads(IDENTITY.read_text())
    identities = identity_file["identities"]
    employment = json.loads(EMPLOYMENT.read_text())
    # Including the posts a previous run of this stage withdrew, which
    # apply_custody puts back before deciding again.
    assignments = employment["assignments"] + [
        entry["assignment"] for entry in employment.get("custody_removed", [])]
    roles = {a["person"]: a["role"] for a in assignments
             if a.get("class") == "primary"}

    criminal, civil, status = build(population, identities, args.seed, roles)

    # Custody feeds back into the files the earlier stages wrote, so every
    # later stage and the simulation see who is inside: no job, no commute.
    withdrawn = apply_custody(population, employment, status)
    apply_phone_custody(population, identities)
    POPULATION.write_text(json.dumps(population, separators=(",", ":")))
    EMPLOYMENT.write_text(json.dumps(employment, separators=(",", ":")))
    IDENTITY.write_text(json.dumps(identity_file, separators=(",", ":")))
    print(f"{withdrawn:,} work assignments withdrawn for people in custody")

    OUTPUT.write_text(json.dumps({
        "seed": args.seed,
        "reference_year": TODAY,
        "criminal_cases": len(criminal),
        "civil_cases": len(civil),
        # Named so nothing downstream mistakes the modelled parts for surveyed
        # ones. Marital status and tenure are the only survey inputs here.
        "surveyed": ["marital status (MAR, MARHT, MARHYP)", "tenure (TEN)"],
        "modelled": ["offending class", "every criminal case", "every civil "
                     "and family case", "sentences", "sealing"],
        "criminal": criminal,
        "civil": civil,
        # Derived from the sentences rather than drawn, so it cannot disagree
        # with them. holdings.py reads this for § 6105 firearms prohibition.
        "status": status,
    }, separators=(",", ":")))

    report(criminal, civil, status, population)
    print(f"\nWrote {OUTPUT} ({OUTPUT.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
