"""Pack the personal records into flat typed arrays for the viewer to read.

identity.json, dockets.json and holdings.json are 383 MB of text between them —
five times the population — and no browser is going to parse that to show
somebody's driver licence. The same records as typed arrays are a fraction of
the size and decode in one pass, which is the same bargain pack_population.py
makes and for the same reason.

Two things make this packer different from that one.

The first is that it writes six files, not one. A reader looking at firearms
does not need 147,301 civil dockets in memory to do it, so the records are cut
along the lines the viewer browses them:

    identity.bin    names, birth dates, taxpayer ids, immigration, marital,
                    the handsets people carry, the subscriptions that run on
                    them, and who somebody is on each messaging platform
    criminal.bin    every criminal case, its charges, and where people stand now
    civil.bin       divorce, custody, evictions, judgments, bankruptcy
    firearms.bin    guns, licences to carry, PICS checks
    vehicles.bin    the vehicle registry, keyed by VIN, and its auto loans
    holdings.bin    licences, accounts, credit, loans, property, prescriptions

identity.bin is the exception that every page loads, because a docket row is
only worth reading if it can say who the defendant is. It stays small — names
intern down to a few thousand distinct values — so that is cheap.

The second is that the columns are described in the header rather than known
to the reader. pack_population.py writes a fixed set of columns and
lib/population.ts knows all of them by name; that works for one table of nine
fields and would be unbearable for the forty record types here. Instead each
field declares a kind, the header carries the field list, and
packages/kierston-records decodes any table it is handed without knowing what a mortgage is. Adding a
field to a generator means adding a line to a schema below and nothing at all
on the TypeScript side.

Kinds, and how each one spends a null — the binary format has no null, so
every kind reserves a value and the reader turns it back:

    id      u32   a resident id, in the population's own numbering; null is
                  u32 max, which resident 0 makes the only safe sentinel, and
                  which a vehicle owned by an operator rather than a household
                  is the first row to need
    int     i32   money and counts; null is INT_MIN, because 0 is a real bail
    u8/u16  ...   small counts; null is the type's maximum
    year    u16   null is 0
    date    i32   the integer yyyymmdd, not an epoch offset — see to_ordinal
                  for why; null is 0
    bool    u8    0, 1, and 2 for a field this record was never asked
    rate    f32   null is NaN
    money   f64   dollars with cents, null is NaN. f64 and not f32 because
                  f32 carries about seven significant digits and a balance of
                  $440,365.12 has eight — it would come back with its cents
                  rounded off, which is the one thing a money column may not do
    enum    ...   interned per field, narrowed to u8/u16/u32 by how many
                  distinct values there turned out to be; null is 0
    str     u32   interned per field, for things that are nearly all distinct
    list    ...   a CSR of enum values — licence restrictions, firearms bars

`sub` is not a kind but a child table: charges hang off a case, suspensions off
a licence, documents off an identity. The child rows are written in parent
order behind a u32 offset array, so a case's charges are contiguous — the same
trick households use for their members.
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from population.pack_population import Packer, Table  # noqa: E402


from paths import SIM_DATA  # noqa: E402

MAGIC = b"KREC"

NULL_INT = -2147483648
NULL_U8 = 255
NULL_U16 = 65535
NULL_ID = 4294967295

# Widths a kind can be stored at, narrowest first, for interned fields.
ENUM_WIDTHS = (("u8", 256), ("u16", 65536), ("u32", 1 << 32))


def to_ordinal(value):
    """An ISO date as the integer yyyymmdd, or 0.

    Not days since an epoch, which is the obvious choice and the wrong one
    here. dockets.py counts in 30-day months on purpose — see `add_days` there,
    which says so and explains why — and 1,541 of the dates it writes are the
    29th or 30th of February in a year that had neither. Days-since-epoch
    cannot hold those without either rejecting the record or silently moving it
    into March, and the viewer's job is to show what the generator produced,
    not to correct it on the way past.

    yyyymmdd stores any year/month/day the generators can emit, compares in
    calendar order so a column still sorts, and reads back as the same string
    it went in as. What it does not support is arithmetic, which nothing here
    asks of it — an age at offence is a field on the record already.
    """
    if not value:
        return 0
    # accounts.py writes its dates as this integer already, because the layer
    # it feeds compares them and never formats them. Taking the number as it
    # stands is the same fact by a shorter route than rendering it to ISO here
    # only to parse it back on the next line.
    if isinstance(value, int):
        return value
    year, month, day = (int(part) for part in value.split("-"))
    return year * 10000 + month * 100 + day


class ChildOffsets:
    """A bare u32 column: where each parent's child rows start and stop.

    Named `_child` rather than `_offset` because `add_strings` already claims
    that suffix for the string table behind a column of the same name.
    """

    kind = "u32"
    table = None
    offsets = None

    def __init__(self, name, values):
        self.name = name
        self.values = values

    def storage(self):
        return "u32"


class Column:
    """One field of one table, accumulating values as records are read."""

    def __init__(self, name, kind):
        self.name = name
        self.kind = kind
        self.values = []
        self.table = Table() if kind in ("enum", "str", "list") else None
        # `list` writes two arrays: an offset per record and the values behind
        # it. Everything else writes one.
        self.offsets = [0] if kind == "list" else None

    def append(self, value):
        kind = self.kind
        if kind == "list":
            for item in value or ():
                self.values.append(self.table.id(item))
            self.offsets.append(len(self.values))
        elif kind in ("enum", "str"):
            # Coerced because an enum is not always a string in the source. The
            # offence gravity score is the one that matters: it is a number for
            # most offences and a label for the rest — "F-1 (-1)" for inchoate
            # offences, which take the underlying grade less one, and the G/H
            # bands for drugs. offenses.py carries both types deliberately, so
            # the column has to hold both rather than pick one.
            self.values.append(
                self.table.id(None if value is None else str(value)))
        elif kind == "date":
            self.values.append(to_ordinal(value))
        elif kind == "bool":
            self.values.append(2 if value is None else int(bool(value)))
        elif kind == "year":
            self.values.append(0 if value is None else int(value))
        elif kind == "u8":
            self.values.append(NULL_U8 if value is None else int(value))
        elif kind == "u16":
            self.values.append(NULL_U16 if value is None else int(value))
        elif kind in ("rate", "money"):
            self.values.append(float("nan") if value is None else float(value))
        elif kind == "id":
            self.values.append(NULL_ID if value is None else int(value))
        else:  # int
            self.values.append(NULL_INT if value is None else int(value))

    def storage(self):
        """The array kind this column's values are written as."""
        if self.kind in ("enum", "str", "list"):
            size = len(self.table.values)
            for name, limit in ENUM_WIDTHS:
                # `str` fields are nearly all distinct and would only ever pick
                # u32; letting them narrow costs nothing and helps the ones
                # that turn out not to be, like a four-digit card suffix.
                if size < limit:
                    return name
        return {
            "id": "u32", "int": "i32", "date": "i32", "rate": "f32",
            "money": "f64", "bool": "u8", "u8": "u8", "year": "u16",
            "u16": "u16",
        }[self.kind]


def _field(name, column):
    """How one field is described in the header, for a reader that has no schema."""
    spec = {"name": name, "kind": column.kind, "column": column.name}
    if column.kind == "list":
        # A list needs both halves of its CSR named, since the reader cannot
        # infer that the values live behind an offset array.
        spec["offsets"] = f"{column.name}_index"
    return spec


class RecordFile:
    """One .bin: a set of tables, their columns, and the string tables behind them."""

    def __init__(self, dataset, source, meta):
        self.dataset = dataset
        self.source = source
        self.meta = meta
        self.tables = []

    def add(self, name, records, schema, children=()):
        """Pack `records` as a table, recursing into any child tables.

        `children` is a sequence of (field, child name, child schema): the
        field holding a list of sub-records, and how to pack one.
        """
        columns = [Column(f"{name}_{field}", kind) for field, kind in schema.items()]
        fields = list(schema)
        child_rows = {child: [] for _, child, _ in children}
        child_offsets = {child: [0] for _, child, _ in children}

        for row, record in enumerate(records):
            for field, column in zip(fields, columns):
                column.append(record.get(field))
            # A child row carries the resident its parent belongs to. It could
            # be reached through the parent's offsets instead — and the dossier
            # does exactly that — but a charge and a document are also worth
            # browsing as tables in their own right, and a table of 184,099
            # charges that cannot say who was charged is not much use. Four
            # bytes a row buys that. Where the parent has no person column its
            # row index *is* the resident, which is how identity is packed.
            person = record.get("person", row)
            for source_field, child, _ in children:
                rows_out = record.get(source_field) or ()
                for kid in rows_out:
                    kid["person"] = person
                child_rows[child].extend(rows_out)
                child_offsets[child].append(len(child_rows[child]))

        spec = {
            "name": name,
            "rows": len(records),
            "fields": [
                _field(field, column) for field, column in zip(fields, columns)
            ],
            "children": [],
        }
        self.tables.append((spec, columns))

        for source_field, child, child_schema in children:
            offsets = f"{name}_{source_field}_child"
            spec["children"].append(
                {"name": source_field, "table": child, "offsets": offsets})
            # The offset array is the parent's, so it goes on the parent's
            # column list — `columns` — not on whatever the recursion appends.
            columns.append(ChildOffsets(offsets, child_offsets[child]))
            self.add(child, child_rows[child], child_schema)

    def write(self, path):
        packer = Packer(MAGIC)
        for spec, columns in self.tables:
            for column in columns:
                packer.add(column.name, column.storage(), column.values)
                if column.offsets is not None:
                    packer.add(f"{column.name}_index", "u32", column.offsets)
                if column.table is not None:
                    packer.add_strings(column.name, column.table.values[1:])
        return packer.write(path, {
            "dataset": self.dataset,
            "source": self.source,
            "builtAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            **self.meta,
            "tables": [spec for spec, _ in self.tables],
        })


# ---- Schemas ----------------------------------------------------------------

IDENTITY = {
    "first_name": "enum", "middle_name": "enum", "surname": "enum",
    "surname_paternal": "enum", "surname_maternal": "enum",
    # The line they were born into, as against the name they go by. Enum like
    # the rest, and nearly free: it draws on the same surname vocabulary.
    "line_paternal": "enum", "line_maternal": "enum",
    "naming_group": "enum", "birth_date": "date",
    "taxpayer_id_kind": "enum", "taxpayer_id": "str", "taxpayer_id_issued": "year",
    "citizenship": "enum", "birthplace": "enum", "birth_region": "enum",
    "entry_year": "year", "naturalized_year": "year",
    "legal_status": "enum", "legal_status_source": "enum",
    "status_basis": "enum",
    "mobile": "str", "landline": "str",
    # The identity registry is the resident's whole administrative identity,
    # not merely the names generated by identity.py. These are joined from the
    # other initialization products at pack time so Fastgate gets one
    # self-contained provider row. SSN is nullable and is not used to filter
    # or physically key the registry.
    "mother_full_name": "str", "father_full_name": "str",
    "parent_full_names": "list",
    "mailing_address": "str",
    "employment_status": "u8",
    "workplace_id": "str", "workplace_name": "enum",
    "workplace_address": "str",
    "veteran_status": "bool",
    # marital is a nested object in the JSON and is flattened on the way in —
    # it is five scalars, not a record anyone browses on its own.
    "marital_status": "enum", "marital_times_married": "u8",
    "marital_married_year": "year",
}

# Handsets and subscriptions, packed as two child tables of identity rather
# than as a block of columns on the person row. Today every phone owner has
# exactly one of each and a flat `device_imei`, `device_carrier`, … would fit —
# which is precisely the trap. Both one-per-person rules are simplifications
# devices.py says out loud it expects to lose: a work phone beside a personal
# one, a dual-SIM handset carrying two numbers, a SIM moved into a different
# body. A child table absorbs each of those as a row, the way a case absorbs a
# second charge; fixed columns would absorb them as a format break, and a
# format break here means every consumer of identity.bin.
#
# Two tables rather than one because they are two objects with two lifetimes,
# and because that is the shape a call detail record joins on: a CDR carries an
# IMSI and an IMEI, and those resolve in different tables that meet through
# `subscription.handset`. Both hang off the person rather than off each other,
# so the dossier reaches them the same way it reaches documents, and neither
# has to be walked to find the other.
DEVICE = {
    "person": "id", "user": "id", "primary": "bool",
    "imei": "str", "tac": "enum",
    "platform": "enum", "make": "enum", "model": "enum",
    "model_released": "year", "tier": "enum", "os_version": "enum",
    "acquired": "date", "condition": "enum",
    # The SIM slot and the soldered chip's id are hardware, so they stay on the
    # hardware. The ICCID is not: it belongs to the profile, which moves.
    "sim_type": "enum", "eid": "str",
}

# `user` and `account_holder` are both `id` and are both meant: the person
# carrying the line and the person whose name is on the account, which are
# different people for one line in six and for 94% of minors. `handset` is the
# IMEI of the phone the SIM currently sits in — a reference, which is what
# makes one handset able to hold two of these.
SUBSCRIPTION = {
    "person": "id", "user": "id", "primary": "bool",
    "msisdn": "str", "imsi": "str", "iccid": "str", "ported_in": "bool",
    "carrier": "enum", "host_network": "enum", "mvno": "bool",
    "plan_type": "enum",
    "account_holder": "id", "account_holder_relation": "enum",
    "handset": "str",
}

# The platform identities, a third child table for the same reason: a person
# holds between one and seven of them, the count moves when a platform is
# added, and every one of them is read off the person rather than browsed on
# its own. `line` is the MSISDN the account hangs off rather than a reference
# to the subscription row — accounts.py writes the number, and the number is
# what a correspondent has.
ACCOUNT = {
    "person": "id",
    "channel": "enum", "handle": "str", "display_name": "str",
    "line": "str", "created": "date",
}

DOCUMENT = {
    "person": "id",
    "document": "enum", "number": "str", "issued": "year", "expires": "year",
    "issuer": "enum", "form": "enum", "status": "enum", "country": "enum",
    "category": "enum", "basis": "enum",
    # Printed on a green card beside its issue date: the year permanent
    # residence began, which a renewal does not move and naturalisation counts
    # from.
    "resident_since": "year",
}

CRIMINAL_CASE = {
    "person": "id", "arrest_date": "date", "offence_year": "year",
    "age_at_offence": "u8", "juvenile": "bool", "lead_charge": "enum",
    "felony_charged": "bool", "court": "enum", "filed": "date", "docket": "str",
    "disposition": "enum", "public": "bool", "counts_for_prs": "bool",
    "disposed": "date", "sealed": "bool", "district": "enum",
    "convicted": "bool", "magisterial_docket": "str", "prior_record_score": "u8",
    "detained_pretrial": "bool", "bail": "int", "pled_down": "bool",
    "convicted_of": "enum", "conviction_grade": "enum",
    "felony_convicted": "bool", "pog": "enum", "fine": "int", "expunged": "bool",
    # The sentence is flattened under a prefix because the case already has a
    # `fine` of its own — a magisterial fine is not a sentence's fine.
    "sentence_kind": "enum", "sentence_probation_months": "u16",
    "sentence_fine": "int", "sentence_minimum_months": "u16",
    "sentence_maximum_months": "u16", "sentence_rrri_months": "u16",
    "sentence_start": "date", "sentence_negotiated": "bool",
    "sentence_life_without_parole": "bool",
}

CHARGE = {
    "person": "id",
    "cite": "enum", "section": "enum", "description": "enum", "grade": "enum",
    "ogs": "enum", "category": "enum", "counts": "u8",
}

STATUS = {
    "incarcerated": "bool", "supervision": "enum", "facility": "enum",
    "release_year": "year", "offending_class": "enum",
    "firearms_prohibited": "list",
}

CIVIL_CASE = {
    "person": "id", "kind": "enum", "court": "enum", "filed": "date",
    "docket": "str", "role": "enum", "public": "bool", "outcome": "enum",
    "disposed": "date", "marriage_number": "u8", "amount": "int",
    "grounds": "enum", "monthly": "int", "order_months": "u16", "chapter": "u8",
}

FIREARM = {
    "person": "id", "type": "enum", "description": "enum", "acquired": "year",
    "serial": "str", "transfer": "enum", "record_of_sale": "str",
    "pics_approval": "str", "dealer": "enum", "ffl": "enum",
}

LICENCE_TO_CARRY = {
    "person": "id", "number": "str", "issuer": "enum", "issued": "date",
    "expires": "year", "statute": "enum", "status": "enum",
}

PICS_CHECK = {
    "person": "id", "date": "date", "approval": "str", "result": "enum",
    "reason": "enum", "dealer": "enum", "ffl": "enum", "issuer": "enum",
}

# The vehicle registry. `vin` is the primary key and comes first for it; the
# owner is a field, which is the inversion that makes a plate or VIN lookup
# possible without walking every resident. See init/personal_records/vehicles.py.
VEHICLE = {
    "vin": "str", "plate": "str", "plate_type": "enum",
    # Organization owners resolve through fleet.json; only person owners join
    # to identity. Entity-owned vehicles never carry a household.
    "owner": "id", "owner_type": "enum", "household": "id",
    "make": "enum", "model": "enum", "body": "enum", "colour": "enum",
    "bus_type": "enum", "seats": "u8",
    "model_year": "year", "registered": "year", "registration_expires": "date",
    "price_new": "int", "value": "int", "commercial_use": "bool",
    "service_class": "enum",
    "issuer": "enum", "title_status": "enum", "title_number": "str",
    "insurer": "enum", "policy": "str",
}

# Driver licences and photo ids are the same record with the same fields — one
# of them just cannot be driven on — so they pack as one table with `holding`
# telling them apart, and the viewer filters rather than joining.
LICENCE = {
    "person": "id", "holding": "enum", "number": "str", "issuer": "enum",
    "issued": "date", "expires": "date", "first_issued": "year",
    "real_id": "bool", "class": "enum", "status": "enum",
    "restrictions": "list",
}

SUSPENSION = {
    "person": "id",
    "from": "date", "months": "u16", "reason": "enum", "docket": "str",
}

# Deposit accounts, and the cash row that rides with them. `balance` and the
# other `money` fields below are dollars with cents, packed as f64 — see the
# note at the top of banking.py. The mortgage and student loan tables are whole
# dollars in `int` columns and are deliberately left that way: nothing debits
# them, so they never need a fraction.
#
# `spendable`, `debitable` and `spend_rank` are what the payments API routes
# on. A purpose string would need every caller to know the vocabulary; flags
# let it filter. Savings is spendable=False, so nothing can put a grocery shop
# through it however the routing is written.
BANK_ACCOUNT = {
    "person": "id", "institution": "enum", "routing": "enum", "number": "str",
    "type": "enum", "purpose": "enum", "opened": "year", "neobank": "bool",
    "balance": "money", "spendable": "bool", "debitable": "bool",
    "receives_deposits": "bool", "spend_rank": "u8",
}

# What a person is paid, when it lands, and where. `anchor` is a real dated
# payday — the last one on or before the reference date — because a frequency
# on its own cannot place "every other Friday" on a calendar.
INCOME_STREAM = {
    "person": "id", "source": "enum", "employer": "enum", "frequency": "enum",
    "payday": "enum", "anchor": "date", "interval_days": "u16",
    "method": "enum", "account": "str", "gross_annual": "money",
    "gross_per_period": "money", "net_per_period": "money",
}

CREDIT_CARD = {
    "person": "id", "issuer": "enum", "last_four": "enum", "network": "enum",
    "opened": "year", "expires": "date", "limit": "money",
    "balance": "money",
}

DEBIT_CARD = {
    "person": "id", "account": "str", "issuer": "enum", "network": "enum",
    "last_four": "enum", "issued": "year", "expires": "date",
    "contactless": "bool",
}

# How readily somebody reaches for cash or for credit. These are records rather
# than draws made at payment time because the API holds no seed and no state:
# a person who pays cash at the bar does it every week, and that is a fact
# about them, not a coin flip at the till.
PAYMENT_PROFILE = {
    "person": "id", "cash_preference": "rate", "credit_preference": "rate",
    "contactless": "bool",
}

MORTGAGE = {
    "person": "id", "parcel": "str", "lender": "enum", "originated": "date",
    "term_months": "u16", "principal": "int", "monthly_payment": "int",
    "escrow_includes_insurance": "bool", "rate": "rate", "balance": "int",
    "mortgage_book": "int", "mortgage_page": "int",
}

REAL_PROPERTY = {
    "person": "id", "address": "str", "parcel": "str", "deed_book": "int",
    "deed_page": "int", "recorded": "date", "issuer": "enum",
    "assessed_value": "int", "year_built": "year",
    "year_built_or_earlier": "bool", "purchase_price": "int",
}

AUTO_LOAN = {
    "person": "id", "vin": "str", "originated": "year", "term_months": "u16",
    "principal": "int", "rate": "rate", "balance": "int",
}

STUDENT_LOAN = {
    "person": "id", "servicer": "enum", "federal": "bool", "originated": "year",
    "principal": "int", "balance": "int", "status": "enum",
}

CREDENTIAL = {
    "person": "id", "credential": "enum", "institution": "enum",
    "awarded": "year", "field": "enum", "second_field": "enum", "title": "enum",
}

PRESCRIPTION = {
    "person": "id", "drug": "enum", "drug_class": "enum", "schedule": "enum",
    "pdmp_reported": "bool", "written": "date", "days_supply": "u16",
    "refills": "u8", "pharmacy": "enum", "prescriber": "enum",
}

MILITARY_SERVICE = {
    "person": "id", "branch": "enum", "entered": "year", "separated": "year",
    "component": "enum", "conflict": "enum", "discharge": "enum",
    "document": "enum",
}

# Which holding kinds go in which file, and under what table name.
# A bill is a rule and not an event, so the columns are the rule: what it is,
# who bills it, how much, how often, on which day, and how it is paid. The
# runtime asks one question of a row — is this due today — and everything it
# needs to answer that is here.
#
# `payer`/`alt_payer`/`split` are the household table's alone, and they are the
# whole reason there are two tables: a household charge is the dwelling's and
# is picked up by whichever adult is paying it that month, while a personal one
# follows the person. `for_person` is attribution rather than payment — a
# student loan is one person's debt paid out of whoever's account.
RECURRING_COMMON = {
    "kind": "enum", "biller": "enum", "mcc": "int", "amount": "money",
    "frequency": "enum", "due_day": "u8", "anchor_month": "u8",
    "seasonal": "enum", "variance": "rate", "method": "enum",
    "source": "enum", "until": "date",
}

HOUSEHOLD_CHARGE = {
    "household": "id", **RECURRING_COMMON,
    "payer": "id", "alt_payer": "id", "split": "enum", "split_share": "rate",
    "for_person": "id",
    # Card payments only: which card, and what share of its live balance.
    "card": "str", "share_of_balance": "rate",
}

# `for_person` is on this table too, and for the one charge that needs it: a
# phone bill sits on the account holder because that is whose account it comes
# out of, and names the line's user here because that is who the money is for.
# Null on everything else, which is a personal charge's normal case.
PERSONAL_CHARGE = {"person": "id", "for_person": "id", **RECURRING_COMMON}


HOLDING_FILES = {
    "firearms": [
        ("firearm", "firearm", FIREARM),
        ("licence_to_carry", "licence_to_carry", LICENCE_TO_CARRY),
        ("pics_check", "pics_check", PICS_CHECK),
    ],
    "holdings": [
        (("driver_licence", "photo_id"), "licence", LICENCE),
        ("bank_account", "bank_account", BANK_ACCOUNT),
        ("income_stream", "income_stream", INCOME_STREAM),
        ("credit_card", "credit_card", CREDIT_CARD),
        ("debit_card", "debit_card", DEBIT_CARD),
        ("payment_profile", "payment_profile", PAYMENT_PROFILE),
        ("mortgage", "mortgage", MORTGAGE),
        ("real_property", "real_property", REAL_PROPERTY),
        ("student_loan", "student_loan", STUDENT_LOAN),
        ("credential", "credential", CREDENTIAL),
        ("prescription", "prescription", PRESCRIPTION),
        ("military_service", "military_service", MILITARY_SERVICE),
    ],
}


# ---- Building each file -----------------------------------------------------

def report(label, path, size, source_bytes, tables):
    print(f"\n{label}  ->  {path.name} ({size / 1e6:.1f} MB)")
    for spec, _ in tables:
        print(f"    {spec['name']:<18} {spec['rows']:>9,} rows"
              f"  {len(spec['fields'])} fields")
    if source_bytes:
        print(f"    {source_bytes / 1e6:.0f} MB as JSON — {source_bytes / size:.0f}× smaller")


def pack_identity():
    source = SIM_DATA / "identity.json"
    data = json.loads(source.read_text())

    # devices.json is a second file keyed on the same person ids, and it packs
    # in here rather than into a file of its own because neither a handset nor
    # a subscription is browsed on its own — both are read off a person, the
    # same way a document is. Joining them in at pack time keeps identity.bin
    # the one file that answers "who is this and how do you reach them".
    handheld = json.loads((SIM_DATA / "devices.json").read_text())
    devices = handheld["devices"]
    subscriptions = handheld["subscriptions"]
    # accounts.json joins in the same way and for the same reason: who somebody
    # is on each platform is part of how they are reached, and it is only ever
    # read off a person. The city-level shape of the layer — reach against the
    # published adoption shares — is answered from accounts.json directly and
    # does not need packing.
    accounts = json.loads((SIM_DATA / "accounts.json").read_text())["account_records"]

    population = json.loads((SIM_DATA / "population.json").read_text())
    employment = json.loads((SIM_DATA / "employment.json").read_text())
    kinship = json.loads((SIM_DATA / "kinship.json").read_text())
    workplaces = json.loads((SIM_DATA / "workplaces.json").read_text())
    dwellings = json.loads((SIM_DATA / "dwellings.json").read_text())
    holdings = json.loads((SIM_DATA / "holdings.json").read_text())

    people = {
        int(person["id"]): person
        for person in population["person_records"] + population["quarters_records"]
    }
    households = {int(row["id"]): row for row in population["household_records"]}
    homes = {row["id"]: row for row in dwellings["dwellings"]}
    jobs = {}
    for assignment in employment["assignments"]:
        person = int(assignment["person"])
        if person not in jobs or assignment.get("class") == "primary":
            jobs[person] = assignment
    sites = {
        row.get("key") or row.get("id"): row
        for row in employment.get("facilities", []) + workplaces.get("site_records", [])
        if row.get("key") or row.get("id")
    }
    parents = {int(person): rows for person, rows in kinship["parents"].items()}
    absent = data.get("absent_parents") or {}
    veterans = {
        int(person)
        for person, records_ in holdings["records"].items()
        if any(record.get("holding") == "military_service" for record in records_)
    }

    def full_name(record):
        if not record:
            return None
        parts = (record.get("first_name"), record.get("middle_name"),
                 record.get("surname"))
        return " ".join(part for part in parts if part) or None

    def named_parent(parent):
        key = str(parent["id"])
        return full_name(data["identities"].get(key) or absent.get(key))

    rows, documents, handsets, lines, handles = [], [], [], [], []
    for person_id, person in data["identities"].items():
        resident = people[int(person_id)]
        job = jobs.get(int(person_id))
        site = sites.get(job.get("site")) if job and job.get("site") else None
        household = households.get(resident.get("household"))
        dwelling_id = (household.get("dwelling") if household
                       else resident.get("dwelling"))
        home = homes.get(dwelling_id)
        parent_rows = parents.get(int(person_id), [])
        parent_names = [name for name in map(named_parent, parent_rows) if name]
        mother = next((named_parent(row) for row in parent_rows
                       if row.get("role") == "mother"), None)
        father = next((named_parent(row) for row in parent_rows
                       if row.get("role") == "father"), None)
        marital = person.get("marital") or {}
        row = {key: person.get(key) for key in IDENTITY if not key.startswith("marital_")}
        row.update({
            "mother_full_name": mother,
            "father_full_name": father,
            "parent_full_names": list(dict.fromkeys(parent_names)),
            "mailing_address": home.get("address") if home else None,
            "employment_status": resident.get("employment"),
            "workplace_id": (job or {}).get("site"),
            "workplace_name": site.get("name") if site else None,
            "workplace_address": site.get("address") if site else None,
            "veteran_status": int(person_id) in veterans,
        })
        for field in ("status", "times_married", "married_year"):
            row[f"marital_{field}"] = marital.get(field)
        row["documents"] = person.get("documents") or []
        # The identity table has no person column — its row index *is* the
        # resident — so the device list has to be looked up by that same id
        # rather than by position in a dict that only holds phone owners.
        row["devices"] = devices.get(person_id) or []
        row["subscriptions"] = subscriptions.get(person_id) or []
        row["accounts"] = accounts.get(person_id) or []
        rows.append(row)
        documents.extend(row["documents"])
        handsets.extend(row["devices"])
        lines.extend(row["subscriptions"])
        handles.extend(row["accounts"])

    out = RecordFile("identity", source.name, {
        "seed": data["seed"],
        "referenceYear": data["reference_year"],
        "today": data.get("today"),
        "persons": data["persons"],
        "surveyed": data.get("surveyed", []),
        "modelled": data.get("modelled", []),
        "counts": {"identities": len(rows), "documents": len(documents),
                   "devices": len(handsets), "subscriptions": len(lines),
                   "accounts": len(handles)},
    })
    out.add("identity", rows, IDENTITY,
            [("documents", "document", DOCUMENT),
             ("devices", "device", DEVICE),
             ("subscriptions", "subscription", SUBSCRIPTION),
             ("accounts", "account", ACCOUNT)])
    path = SIM_DATA / "identity.bin"
    report("identity.json", path, out.write(path), source.stat().st_size, out.tables)


def pack_dockets():
    source = SIM_DATA / "dockets.json"
    data = json.loads(source.read_text())

    cases = []
    for case in data["criminal"]:
        row = dict(case)
        sentence = row.pop("sentence", None) or {}
        for field in ("kind", "probation_months", "fine", "minimum_months",
                      "maximum_months", "rrri_months", "start", "negotiated",
                      "life_without_parole"):
            row[f"sentence_{field}"] = sentence.get(field)
        cases.append(row)

    meta = {
        "seed": data["seed"],
        "referenceYear": data["reference_year"],
        "surveyed": data.get("surveyed", []),
        "modelled": data.get("modelled", []),
    }

    criminal = RecordFile("criminal", source.name, {
        **meta,
        "counts": {
            "cases": len(cases),
            "charges": sum(len(c["charges"]) for c in cases),
            "persons": len(data["status"]),
        },
    })
    criminal.add("case", cases, CRIMINAL_CASE, [("charges", "charge", CHARGE)])
    # Where every resident stands today — supervision, prohibitions, and the
    # offending class the generator drew them from. Indexed by resident id, so
    # it carries no person column of its own.
    criminal.add("status", list(data["status"].values()), STATUS)
    path = SIM_DATA / "criminal.bin"
    report("dockets.json (criminal)", path, criminal.write(path), None, criminal.tables)

    civil = RecordFile("civil", source.name, {
        **meta, "counts": {"cases": len(data["civil"])},
    })
    civil.add("case", data["civil"], CIVIL_CASE)
    path = SIM_DATA / "civil.bin"
    report("dockets.json (civil)", path, civil.write(path), None, civil.tables)


def pack_holdings():
    source = SIM_DATA / "holdings.json"
    data = json.loads(source.read_text())

    # One pass over the records, bucketed by holding kind, with the person id
    # folded in — holdings.json keys people by id and repeats no id inside the
    # record, but a flat table needs one on every row.
    buckets = {}
    for person, records in data["records"].items():
        person = int(person)
        for record in records:
            buckets.setdefault(record["holding"], []).append({**record, "person": person})

    for dataset, tables in HOLDING_FILES.items():
        out = RecordFile(dataset, source.name, {
            "seed": data["seed"],
            "referenceYear": data["reference_year"],
            "persons": data["persons"],
            "surveyed": data.get("surveyed", []),
            "modelled": data.get("modelled", []),
            "counts": {},
        })
        for kinds, name, schema in tables:
            rows = []
            for kind in (kinds if isinstance(kinds, tuple) else (kinds,)):
                rows.extend(buckets.get(kind, []))
            out.meta["counts"][name] = len(rows)
            children = [("suspensions", "suspension", SUSPENSION)] if name == "licence" else []
            out.add(name, rows, schema, children)
        path = SIM_DATA / f"{dataset}.bin"
        report(f"holdings.json ({dataset})", path, out.write(path), None, out.tables)

    unpacked = set(buckets) - {
        kind
        for tables in HOLDING_FILES.values()
        for kinds, _, _ in tables
        for kind in (kinds if isinstance(kinds, tuple) else (kinds,))
    }
    if unpacked:
        raise SystemExit(f"holding kinds with no target table: {sorted(unpacked)}")


def pack_vehicles():
    """vehicles.json -> vehicles.bin, the registry and the loans secured on it.

    Unlike the other packers this one does not bucket by a `holding` field,
    because vehicles.json is not a per-person record file — it is keyed by VIN,
    and the owner is a column. The dict is flattened to rows in key order so the
    table lands sorted by VIN, which is what lets the viewer binary-search it
    instead of scanning.
    """
    source = SIM_DATA / "vehicles.json"
    data = json.loads(source.read_text())

    vehicles = [data["vehicles"][vin] for vin in sorted(data["vehicles"])]
    loans = [data["auto_loans"][vin] for vin in sorted(data["auto_loans"])]

    out = RecordFile("vehicles", source.name, {
        "seed": data["seed"],
        "referenceYear": data["reference_year"],
        "persons": data["persons"],
        "surveyed": data.get("surveyed", []),
        "modelled": data.get("modelled", []),
        "counts": {"vehicle": len(vehicles), "auto_loan": len(loans)},
        # The reader needs to know which column is the key to search on.
        "primaryKey": {"vehicle": "vin", "auto_loan": "vin"},
    })
    out.add("vehicle", vehicles, VEHICLE)
    out.add("auto_loan", loans, AUTO_LOAN)
    path = SIM_DATA / "vehicles.bin"
    report("vehicles.json", path, out.write(path), source.stat().st_size,
           out.tables)


def pack_recurring():
    """recurring_spending.json -> recurring_spending.bin, the city's bills.

    Two tables and no children. The seasonal curves ride in the header rather
    than being copied into the runtime: they are twelve floats each, they have
    to agree exactly with the amounts they scale, and a second definition of
    them in TypeScript is a second definition that can drift.
    """
    source = SIM_DATA / "recurring_spending.json"
    data = json.loads(source.read_text())

    out = RecordFile("recurring_spending", source.name, {
        "seed": data["seed"],
        "referenceYear": data["reference_year"],
        "persons": data["persons"],
        "households": data["households"],
        "seasonal": data["seasonal"],
        "surveyed": data.get("surveyed", []),
        "modelled": data.get("modelled", []),
        "counts": {"household_charge": len(data["household"]),
                   "personal_charge": len(data["person"])},
    })
    out.add("household_charge", data["household"], HOUSEHOLD_CHARGE)
    out.add("personal_charge", data["person"], PERSONAL_CHARGE)
    path = SIM_DATA / "recurring_spending.bin"
    report("recurring_spending.json", path, out.write(path),
           source.stat().st_size, out.tables)


def main() -> None:
    for name in ("identity.json", "devices.json", "accounts.json", "dockets.json",
                 "holdings.json", "vehicles.json", "recurring_spending.json",
                 "population.json", "employment.json", "enrollment.json",
                 "kinship.json", "workplaces.json", "schools.json",
                 "dwellings.json"):
        if not (SIM_DATA / name).exists():
            raise SystemExit(
                f"{name} is missing — run the personal-records stages first")
    pack_identity()
    pack_dockets()
    pack_holdings()
    pack_vehicles()
    pack_recurring()


if __name__ == "__main__":
    main()
