"""Sleep traits, which PUMS never asked about and the simulation cannot do without.

Three numbers per person: how much sleep they need, when in the night they want
it, and how long they take to get out of the door once they are up. The runtime
used to derive all three from a hash of the person's id, the way `punctuality`
is still derived, and that was wrong for one specific reason worth stating.

Chronotype has to exist before the rosters are built
---------------------------------------------------
Which officer works nights is decided in `work/init_work.py`, by shuffling the
people and shuffling the watch slots and zipping the two together. That makes
the night watch a random sample of the force, and it is not one — evening types
select into night work and tolerate it, morning types leave it. A trait the
runtime invents long after the roster exists cannot feed back into who is on
that roster, so the draw has to happen here, with the person, before anybody is
posted to a watch.

The second reason is that a hash of an id knows nothing about the person it
belongs to. Chronotype's largest covariate by a wide margin is age, and the
runtime version modelled it as noise around zero for a fifteen-year-old and a
seventy-year-old alike. Here the age is already known, already jittered, and
the curve can use it.

Why this runs after `jitter`
----------------------------
Cloning copies 1,391 PUMS records into 46,039 households, so a trait drawn from
the source row would be shared by every copy of it — thirty-three people with
one chronotype. These are drawn per simulated person, after cloning, and after
`jitter` has settled the ages the chronotype curve reads.
"""

import math

# Mid-sleep on free days, in minutes after midnight, by age.
#
# The measure is the clock time halfway through a sleep nobody set an alarm
# for, which is what the chronotype literature actually surveys and therefore
# the only thing with population-scale numbers behind it. Adults centre near
# 04:00 with a standard deviation of about an hour.
#
# The curve is not monotone and that is the whole point of having one. Mid-sleep
# delays steeply through adolescence, turns over around twenty, and advances for
# the rest of life. A sixteen-year-old and a seventy-year-old are an hour and a
# half apart before any individual variation, which is a larger effect than the
# spread between individuals of the same age.
MID_SLEEP_BY_AGE = (
    (10, 180),   # 03:00
    (16, 270),   # 04:30
    (20, 300),   # 05:00 — the latest anybody gets
    (25, 285),
    (30, 255),
    (45, 225),
    (65, 195),
    (85, 180),
)

# What the runtime treats as an unshifted night, so a chronotype of zero means
# the same thing on both sides. Keep in step with PREFERRED_CENTRE in sleep.ts.
REFERENCE_MID_SLEEP = 210  # 03:30

# Men run later than women through early adulthood and the gap closes by the
# late forties. Small next to the age term, and real.
SEX_DELAY_PEAK = 26
SEX_DELAY_GONE_BY = 48

CHRONOTYPE_SIGMA = 55
# Extreme owls outnumber extreme larks, so the upper tail is stretched rather
# than the distribution being symmetric. A plain normal produces a city with as
# many people centred at half one in the morning as at half five.
CHRONOTYPE_OWL_STRETCH = 1.18
# Wide enough not to bite on the age curve itself. At 120 it clipped the owl
# tail off twenty-year-olds — whose curve already sits at +90 — and handed the
# age group that varies most the narrowest spread in the city, which is
# backwards. This only has to stop somebody coming out nocturnal.
CHRONOTYPE_CLAMP = 165

# Time in bed on an ordinary night, in minutes, by age.
#
# Drawn nearly independently of chronotype on purpose: owls do not need more
# sleep than larks, they need it at a different hour, and tying the two would
# invent a correlation the evidence does not carry.
SLEEP_NEED_BY_AGE = (
    (5, 630),
    (13, 582),
    (18, 540),
    (25, 516),
    (45, 486),
    (65, 480),
    (85, 498),
)

NEED_SIGMA = 66
NEED_MIN = 330
NEED_MAX = 660

# Waking to out of the door. Not a physiological trait but a habit, and shaped
# like one: most people take a little over half an hour and a tail of them take
# an hour and a half. Lognormal rather than uniform, because a uniform draw has
# no tail and everybody's morning is the same length.
READINESS_MEDIAN = 40
READINESS_SIGMA = 0.45
READINESS_MIN = 12
READINESS_MAX = 150
READINESS_FEMALE = 1.18

# Keys this module adds. `jitter.signature` has to ignore them: two people who
# differ only in when they like to go to bed are still the same clone for the
# purpose of counting how well cloning was disguised.
FIELDS = ("chronotype", "sleep_need", "readiness")


def interpolate(table, age):
    """Piecewise linear over an (age, value) table, flat outside its ends."""
    if age <= table[0][0]:
        return float(table[0][1])
    if age >= table[-1][0]:
        return float(table[-1][1])
    for (a0, v0), (a1, v1) in zip(table, table[1:]):
        if a0 <= age <= a1:
            return v0 + (v1 - v0) * (age - a0) / (a1 - a0)
    return float(table[-1][1])


def sex_delay(age, sex):
    """Minutes a man's mid-sleep runs later than a woman's at this age."""
    if sex != 1 or age >= SEX_DELAY_GONE_BY:
        return 0.0
    return SEX_DELAY_PEAK * (1 - age / SEX_DELAY_GONE_BY)


def chronotype(person, rng):
    """Minutes from the reference mid-sleep. Positive is an owl."""
    centre = interpolate(MID_SLEEP_BY_AGE, person["age"])
    centre += sex_delay(person["age"], person.get("sex"))

    draw = rng.gauss(0, CHRONOTYPE_SIGMA)
    if draw > 0:
        draw *= CHRONOTYPE_OWL_STRETCH

    offset = centre - REFERENCE_MID_SLEEP + draw
    return int(round(max(-CHRONOTYPE_CLAMP, min(CHRONOTYPE_CLAMP, offset))))


def sleep_need(person, rng):
    """Minutes in bed on an ordinary night."""
    centre = interpolate(SLEEP_NEED_BY_AGE, person["age"])
    value = centre + rng.gauss(0, NEED_SIGMA)
    return int(round(max(NEED_MIN, min(NEED_MAX, value))))


def readiness(person, rng):
    """Minutes between waking and being able to leave the house."""
    median = READINESS_MEDIAN
    if person.get("sex") == 2:
        median *= READINESS_FEMALE
    value = median * math.exp(rng.gauss(0, READINESS_SIGMA))
    return int(round(max(READINESS_MIN, min(READINESS_MAX, value))))


def apply(persons, quarters, rng):
    """Write the three traits onto every person, in place."""
    for person in list(persons) + list(quarters):
        person["chronotype"] = chronotype(person, rng)
        person["sleep_need"] = sleep_need(person, rng)
        person["readiness"] = readiness(person, rng)
