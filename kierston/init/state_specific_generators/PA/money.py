"""Pennsylvania money: withholding, benefit schedules and state payees.

Read by personal_records/banking.py, holdings.py, vehicles.py and
recurring_spending.py through jurisdiction.state_module().
"""

# Share of gross that reaches the account, by gross. Covers FICA at 7.65%, the
# federal effective rate, Pennsylvania's flat 3.07% and the reference city's 1%
# earned income tax. Effective, not marginal — this is what lands, not what the last
# dollar is taxed at.
KEEP_WAGES = ((15_000, 0.90), (30_000, 0.855), (60_000, 0.80),
              (100_000, 0.755), (200_000, 0.70), (10 ** 9, 0.64))

# Pennsylvania unemployment compensation is claimed fortnightly and paid a
# couple of days after the claim, which puts it midweek.
UNEMPLOYMENT_CADENCE = "biweekly"
UNEMPLOYMENT_WEEKDAY = "wednesday"

STUDENT_LOAN_SERVICERS = (
    "MOHELA", "Nelnet", "Aidvantage", "EdFinancial",
    "Pennsylvania Higher Education Assistance Agency")

# Municipalities self-insure their fleets through a pool rather than buying
# retail cover, and in Pennsylvania that pool is the boroughs' own.
MUNICIPAL_INSURERS = (
    ("Pennsylvania Municipal Insurance Trust", 70),
    ("Travelers Casualty and Surety Company", 18),
    ("Selective Insurance Company of America", 12),
)
FLEET_INSURERS = (
    ("Pennsylvania School Boards Association Insurance Trust", 60),
    ("Utica National Insurance Group", 20),
    ("Old Republic Insurance Company", 12),
    ("Philadelphia Indemnity Insurance Company", 8),
)

# Pennsylvania bills a property twice from two authorities: county and
# municipal in the spring, school district in the summer, and the school
# district's is much the larger of the two. (authority, share, month)
PROPERTY_TAX = (("county", 0.32, 3), ("school_district", 0.68, 8))

HOME_INSURER = "Erie Insurance Exchange"
