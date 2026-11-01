"""What gets charged in Pennsylvania: charge weights by statute stem.

Read by criminal_history/dockets.py through jurisdiction.state_module().
"""

# The catalogue in offenses.py is the Commission's sentencing listing: it says
# what *can* be charged and at what gravity, and it is dominated by offences
# nobody is ever charged with. 422 property sections, and PA criminal dockets
# are mostly retail theft. Drawing from the catalogue by any severity-neutral
# rule produces a city of arsonists and racketeers.
#
# So charge volume is weighted explicitly, by statute stem. Weights are
# relative and hand-set from the shape of PA magisterial and Common Pleas
# filings — this is the estimate most improved by real AOPC charge counts, and
# the one place where being wrong shows up immediately as an implausible docket.
# Anything not listed keeps a small residual weight so the long tail exists.
CHARGE_WEIGHTS = {
    # drug
    "780-113(a)(16)": 210,   # possession of a controlled substance
    "780-113(a)(32)": 190,   # paraphernalia
    "780-113(a)(31)": 95,    # small amount of marijuana
    "780-113(a)(30)": 190,   # possession with intent to deliver
    # traffic and impaired driving
    "3802": 330,             # DUI
    "1543": 145,             # driving while operating privilege suspended
    "3742": 22,              # accident involving death or personal injury
    "3732": 6,               # homicide by vehicle
    "3735": 3,               # homicide by vehicle while DUI
    # person
    "2701": 300,             # simple assault
    "2702": 125,             # aggravated assault
    "2705": 130,             # recklessly endangering another person
    "2706": 105,             # terroristic threats
    "2709": 140,             # harassment
    "2709.1": 30,            # stalking
    "2718": 26,              # strangulation
    "2502": 5,               # murder
    "2503": 2,               # voluntary manslaughter
    "2504": 4,               # involuntary manslaughter
    "3121": 9, "3123": 7, "3125": 12, "3126": 34,   # sexual offences
    # property
    "3929": 260,             # retail theft
    "3921": 200,             # theft by unlawful taking
    "3925": 60,              # receiving stolen property
    "3934": 70,              # theft from a motor vehicle
    "3304": 175,             # criminal mischief
    "3502": 112,             # burglary
    "3503": 85,              # criminal trespass
    "3701": 52,              # robbery
    "3702": 4,               # robbery of a motor vehicle
    "3922": 30,              # theft by deception
    "3927": 22,              # theft by failure to make required disposition
    "3928": 26,              # unauthorized use of a motor vehicle
    "4101": 18,              # forgery
    "4104": 30,              # tampering with records
    "4113": 14,              # misapplication of entrusted property
    "4120": 55,              # identity theft
    "3301": 14,              # arson
    # weapons
    "6105": 82,              # persons not to possess firearms
    "6106": 88,              # firearms not to be carried without a licence
    "6108": 20,              # carrying firearms on Philadelphia streets
    "907": 60,               # possessing instruments of crime
    # public order and administration of justice
    "5503": 235,             # disorderly conduct
    "5104": 110,             # resisting arrest
    "4914": 75,              # false identification to law enforcement
    "5505": 60,              # public drunkenness
    "5506": 20,              # loitering and prowling at night
    "4952": 24,              # intimidation of a witness or victim
    "5121": 18,              # escape
    "4915.1": 12,            # failure to comply with registration
    "6301": 40,              # corruption of minors
    "5902": 26,              # prostitution
    "901": 55, "903": 45,    # attempt, conspiracy
}

# Everything in the catalogue that is not named above. Small, and graded by
# severity so the tail is mostly minor: an unnamed M-3 is far likelier to turn
# up on a docket than an unnamed F-1.
RESIDUAL_WEIGHT = {"S": 6.0, "M-3": 4.0, "M-2": 3.0, "M-1": 2.2, "M": 3.0,
                   "F-3": 1.40, "F-2": 0.62, "F-1": 0.26, "F": 0.75, None: 0.2}

# What a situational offence actually is. Overwhelmingly impaired driving,
# which is the single most common serious charge in Pennsylvania and the one
# that most often appears on an otherwise clean record.
SITUATIONAL_MIX = (
    ("3802", 0.46),          # DUI
    ("2701", 0.13),          # simple assault
    ("5503", 0.08),          # disorderly conduct
    ("2705", 0.05),          # recklessly endangering
    ("3929", 0.05),          # retail theft
    ("2706", 0.04),          # terroristic threats
    ("1543", 0.05),          # driving while suspended
    ("3304", 0.04),          # criminal mischief
    ("3742", 0.03),          # accident involving death or injury
    ("3732", 0.02),          # homicide by vehicle
    ("2504", 0.01),          # involuntary manslaughter
    ("6106", 0.02),          # carrying a firearm without a licence
    ("780-113(a)(16)", 0.02),  # possession
)

# Direct file — a juvenile charged as an adult. In PA, murder is excluded from
# juvenile jurisdiction outright and § 6355 allows transfer for a list of
# serious offences committed with a deadly weapon from age 15.
DIRECT_FILE_AGE = 15

# Counts filed alongside a lead charge, by the lead charge's category.
COMPANIONS = {
    "drug": ("780-113(a)(32)", "780-113(a)(16)", "907"),
    "person": ("2701", "2705", "2706", "5503", "907"),
    "property": ("3925", "3503", "3304", "907", "903"),
    "weapons": ("907", "6105", "6106", "5503"),
    "public_order": ("5503", "5104", "4914", "2709"),
    "mv_other": ("1543", "3802"),
    "other": ("903", "5503"),
}

# Offences that need someone at the wheel. Nobody below the learner's permit
# age is charged with impaired driving, driving under suspension or a fatal
# crash. Keyed by statute stem; MINIMUM_AGE_BY_CATEGORY covers whole filing
# categories, and anything in neither falls back on the docket generator's
# floor for any charge.
DRIVING_AGE = 16
DRIVING_SECTIONS = {"3802", "1543", "3742", "3732", "3735", "3714", "3736",
                    "1501", "1786"}
MINIMUM_AGE_BY_CATEGORY = {"mv_other": DRIVING_AGE}

# Lookback, in years, for the prior offences a grading variant counts. The
# § 3806 DUI lookback is ten years; sections not listed count every prior.
PRIOR_LOOKBACK_YEARS = {"3802": 10}
