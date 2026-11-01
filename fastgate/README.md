# Fastgate

Fastgate is a CLI-only importer. It does not expose an HTTP server or browser
interface.

Its job is to turn simulation products into what separate record holders would
actually keep. The simulation knows who everybody is; a bank, a carrier or a
court knows only its own customers, under its own copy of their identity, and
an event log knows only identifiers. Fastgate enforces that split at import
time, so nothing downstream (KDI, the agents) can see past it.

Fastgate has four input families across two stores:

- **Dynamic records** come from each packed KDAY file and live in ClickHouse.
  These are the ALPR, network, SMS, call and bank records people produce during
  a simulated day.
- **Static records** come from the KREC sections in `sim_init.bin` and live in
  PostgreSQL. They include identities and documents, devices and carrier plans,
  criminal and civil dockets, firearms, vehicle registrations and loans,
  licences, bank accounts and cards, property, study credentials,
  prescriptions, military records, and the other packed holdings.
- **ALPR camera inventory** comes from `cities/<city>/cameras.json` and lives in
  PostgreSQL independently of the 26 provider tables. It contains fixed-camera
  IDs, mount coordinates and available human-readable location details.
- **Cell site inventory** comes from `sim_data/towers.json` and lives in
  PostgreSQL, also outside the 26 provider tables. It is the sectors and the
  masts they hang off, and it is what a CGI on a carrier record joins out to.

Simulation truth and internal KDAY relationships have no destination columns
in the dynamic store. The camera and cell-site registries embedded in a KDAY
are still used only to resolve IDs during a daily import. Static registries are
loaded independently from `sim_init.bin`. KREC resident IDs are import-time
joins only and are never written to PostgreSQL.

Set both database connections in the project-level `.env.local` (at the repository
root, not in `fastgate/`). Every tool in the project reads that one file:

```dotenv
CLICKHOUSE_URL=http://127.0.0.1:8123
CLICKHOUSE_DATABASE=city_data
CLICKHOUSE_USER=default
CLICKHOUSE_PASSWORD=
POSTGRES_URL=postgres://postgres@127.0.0.1:5432/city_data
POSTGRES_SCHEMA=fastgate_static
```

```sh
# Dependencies come from `bun install` at the repository root.

# Import the static city records, then import daily records.
bun run ingest:static -- ../kierston/sim_data/sim_init.bin
bun run ingest:dynamic -- ../kierston/sim_outputs/day_2026-07-28.bin
bun run ingest:scenario -- ../kierston/sim_outputs/scenario_coffee_42.kdiff
bun run annotate:scenario -- ../kierston/sim_outputs/day_2026-08-23.bin \
  ../kierston/sim_outputs/scenario_coffee_42.kdiff   # older KDIFs without rows
bun run revert:scenario -- 2026-08-23
bun run list:scenarios          # JSON: every date with a scenario applied
bun run ingest:cameras -- ../kierston/cities/kierston/cameras.json
bun run ingest:cells -- ../kierston/sim_data/towers.json

# Update only named tables. Comma-separated and repeated --table flags are supported.
bun run ingest:static -- ../kierston/sim_data/sim_init.bin \
  --tables bank_accounts,bank_credit_cards --mode overwrite
bun run ingest:dynamic -- ../kierston/sim_outputs/day_2026-07-28.bin \
  --table alpr_reads --table bank_transactions --mode append

```

A normal full import of the same source twice is a no-op. A different KDAY for
a date already present is rejected
instead of silently combining versions. A different static source is loaded
transactionally and is made active only after all of its records are present,
so readers never see a partially refreshed registry. CLI imports display live
progress.

### Reverting a scenario

Applying a KDIF rewrites only the rows it changes, and it records what it did in
`scenario_journal`: the full contents of every base row it removed, and the ID
of every scenario row it added. `revert:scenario <date>` replays that journal
backwards, deleting the added IDs and re-inserting the stored base rows, then
clears the day's `active_scenarios` marker. It reads neither the KDAY nor the
KDIF, so a revert works with the source files gone, and swapping one scenario
for another is a revert followed by an ordinary apply.

A scenario applied by an earlier version of fastgate has no journal. Reverting
one is refused rather than half-done; re-import its base KDAY instead.

### Selective updates

The static and dynamic import commands accept `--tables <name,...>` (or repeated `--table <name>`)
and `--mode overwrite|append`. Supplying a mode without tables applies it to
every table present in that input. An explicit table selection with no mode
defaults to `overwrite`.

- `overwrite` removes all existing rows from only the selected tables before
  writing their rows from the input. PostgreSQL does this transactionally;
  ClickHouse applies it one selected table at a time.
- `append` preserves existing rows and adds the input rows. PostgreSQL rebases
  `_record_index` values above each table's current maximum and also rebases
  selected parent/child references. ClickHouse keeps stable record IDs and uses
  its normal `ReplacingMergeTree` behavior for duplicate IDs.

For the dynamic ClickHouse tables, `overwrite` removes only the KDAY's own day:
rows stamped with that `observation_date`, and unstamped rows from before the
column existed whose clock column falls on that local date. Other days stay.

Explicit ClickHouse updates bypass the day-level `ingested_days` no-op check.
An overwrite of every dynamic table moves the day's marker to the new file's
digest; any other explicit update leaves the marker as it was, so a partial
repair is not recorded as a complete day import.

A dynamic `--tables`/`--mode` import is refused while a scenario is active for
that date. Revert the scenario first, or pass `--force-with-scenario`. A forced
overwrite of every dynamic table also clears the scenario marker and journal;
a forced partial import leaves them, and the day is then a mix.

Unknown or source-missing table names are rejected before any selected
PostgreSQL table is changed.

### Scenario deltas

A KDIF carries, next to its byte patches, the ClickHouse rows the scenario
changes: for each of the six provider tables, the base rows it removes (kept in
full, so a revert can restore them) and the rows it adds. The scenario writer
in `kierston_scenarios` works them out once, at create time, by hashing the raw
column words each provider row depends on and pairing the two multisets, so
neither day is ever materialized. `annotate:scenario` writes the same section
into a KDIF made before it existed; it needs the exact base KDAY once.

`ingest:scenario` takes only the KDIF. It reads no KDAY: it requires that the
delta's base digest is already marked as completely imported, then journals,
deletes and inserts the rows the delta names. Rows whose provider content did
not change are never touched and keep their existing ClickHouse IDs. Calls and
their handovers travel together so a handover change cannot leave an orphaned
child record. The rows are bound to a time zone; an apply under a different
city time zone (`CITY_TIME_ZONE`, else `time_zone` in `sim_data/city.json`) is
refused.

The delta's `scenarioId` (a digest of its byte-level content, stable across
annotation) is recorded in `active_scenarios`, making a retry of the same KDIF
safe and a completed repeat a no-op. Fastgate rejects a different scenario for
the same date while one is active; alternative KDIFs are branches from the
base, not patches to stack on top of each other.

### ALPR camera inventory

`ingest:cameras` loads the tracked city camera inventory into PostgreSQL table
`alpr_cameras`. It records each camera ID, physical mount latitude/longitude,
postal address when the siting source has one (otherwise the watched road),
owner, role, direction, road and traffic context. Use `--mode overwrite` to
replace only this table or `--mode append` to add previously unseen camera IDs
without modifying existing rows. Overwrite is the default.

The importer creates `alpr_cameras` and its indexes when absent. It uses its own
transaction and advisory lock; neither camera ingestion nor later `sim_init.bin`
imports create, truncate, drop or otherwise change any unrelated table.

### Cell site inventory

`ingest:cells` loads the city tower inventory into PostgreSQL tables
`carrier_structures` and `carrier_cell_sites`. Towers are fixed infrastructure
and belong with the other static records: the tables load from a cold database
without a day, and a daily import never touches them.

`carrier_structures` is one row per mast or rooftop — its coordinates, kind,
height, owner, and its FCC registration number where the structure came from
the ASR rather than being modelled. `carrier_cell_sites` is one row per sector,
keyed on CGI: operator, MCC/MNC, radio, band, role, tracking area, PCI,
coordinates, and the azimuth, beamwidth, downtilt, height, EIRP and range that
say which way the sector faces and how far it carries. A sector references its
structure, so a CGI resolves to a bearing from a known mast rather than to a
bare point. The city runs about 2,700 sectors across 87 structures.

Use `--mode overwrite` to replace the inventory or `--mode append` to add
previously unseen structures and CGIs without modifying existing rows.
Overwrite is the default. `--tables` narrows the load to one of the two tables.

The importer creates both tables and their indexes when absent. It uses its own
transaction and advisory lock; neither cell ingestion nor later `sim_init.bin`
imports create, truncate, drop or otherwise change any unrelated table.

## Static PostgreSQL model

Static data is deliberately denormalized by provider. Every table has ordinary
typed PostgreSQL columns, not a generic JSONB payload. Each provider gets its
own copy of the identity attributes it would know. A bank table carries customer
or borrower name, date of birth and SSN; a court table carries its own party or
defendant name and date of birth; carrier accounts carry separate subscriber
and account-holder copies. There is no cross-provider person key.

`_record_index` is the table-local operational key. Parent/child rows use only
local provider references such as `case_record_index` or
`license_record_index`. Static tables contain no source-digest columns or
import-control tables; a new import transactionally replaces all 26 tables.
The independently loaded `alpr_cameras`, `carrier_structures` and
`carrier_cell_sites` inventories are outside that 26-table snapshot and are
therefore preserved by normal static imports.

Provider tables:

| Provider | Table | Contents |
| --- | --- | --- |
| Identity registry | `identity_registry_people` | Every person, including non-SSN identities; legal name and DOB, nullable derived `ssn`, original tax-ID kind/value, citizenship and legal status, phones, parent full names, mailing/living address, employment and occupation, workplace, education/enrollment, school, veteran and marital status. |
| Identity registry | `identity_registry_documents` | Passport and immigration/government-document numbers, issue/expiry/status, and copied holder name/DOB. |
| Carrier | `carrier_devices` | IMEI/EID, make/model, radio/SIM hardware and device attributes only; no name, DOB, SSN, or identity-registry link. |
| Carrier | `carrier_accounts` | MSISDN, IMSI, ICCID, carrier, plan/account status, and independent subscriber and account-holder identity copies. |
| Online platforms | `platform_accounts` | Channel/platform handles and line association with copied account-owner name/DOB. |
| Criminal courts | `criminal_court_cases` | Criminal docket, court, dates, disposition, bail, conviction and sentence with copied defendant name/DOB. |
| Criminal courts | `criminal_court_charges` | Charge/citation/section, grade, disposition and sentence with copied defendant name/DOB and a local case reference. |
| Corrections | `corrections_statuses` | Incarceration, facility, supervision/release and firearm-prohibition status with copied subject name/DOB. |
| Civil courts | `civil_court_cases` | Divorce, custody, eviction, judgment and bankruptcy docket details with copied party name/DOB. |
| State police | `state_police_firearms` | Firearm serial/make/model/calibre, sale/transfer and approval data with copied purchaser name/DOB/SSN. |
| State police | `state_police_carry_licenses` | Carry-license number, issuer, dates and status with copied licensee name/DOB/SSN. |
| State police | `state_police_background_checks` | Firearm background-check date, reason, outcome and approval with copied applicant name/DOB/SSN. |
| Department of Transportation | `dot_vehicle_registrations` | VIN, title, registration, plate, vehicle attributes and insurance with copied registered-owner name/DOB/SSN where personally owned. |
| Department of Transportation | `dot_driver_licenses` | Driver-license/photo-ID number, class, dates, status and restrictions with copied licensee name/DOB/SSN. |
| Department of Transportation | `dot_license_suspensions` | Suspension dates, reason and docket with copied licensee name/DOB/SSN and a local license reference. |
| Banks | `bank_accounts` | Institution, routing/account number, type, balances and controls with copied customer name/DOB/SSN. |
| Banks | `bank_income_streams` | Payroll/recurring-deposit source, cadence and account routing with copied customer name/DOB/SSN. |
| Banks | `bank_credit_cards` | Issuer/network/last four, limit, balance and status with copied cardholder name/DOB/SSN. |
| Banks | `bank_debit_cards` | Issuer/network/last four and linked account with copied cardholder name/DOB/SSN. |
| Banks | `bank_mortgages` | Parcel, principal/balance, rate, term, payment and recording references with copied borrower name/DOB/SSN. |
| Banks | `bank_auto_loans` | VIN, lender, principal/balance, rate and term with copied borrower name/DOB/SSN. |
| Banks | `bank_student_loans` | Servicer, principal/balance, payment and status with copied borrower name/DOB/SSN. |
| County recorder | `county_recorder_properties` | Parcel, deed, address, assessment and purchase data with copied owner name. |
| Education providers | `education_credentials` | Institution, credential/degree, field and award year with copied student name/DOB. |
| Pharmacies / PDMP | `pharmacy_prescriptions` | Drug, prescriber, pharmacy, written/fill dates, quantity/refills/day supply and controlled-substance reporting with copied patient name/DOB. |
| Military records | `military_service_records` | Branch/component, service dates, conflict and discharge with copied service-member name/DOB/SSN. |

For example:

```sql
SELECT customer_first_name, customer_last_name, customer_date_of_birth,
       customer_ssn, institution, routing, number, balance
FROM fastgate_static.bank_accounts;
```

Dynamic ClickHouse tables do not use provider prefixes. They remain
`alpr_reads`, `network_events`, `sms_records`, `call_records`,
`call_handovers`, and `bank_transactions`.
They carry identifiers, never identity. A carrier record holds the IMSI and the
IMEI at each end, an ALPR read holds the plate, a transaction holds the account
number and card last four. Names, dates of birth and SSNs live in the PostgreSQL
provider tables and are reached by joining on those identifiers — which is the
work a consumer of this data is supposed to do, and what a real provider's own
event logs make you do. A CGI resolves the same way, through
`carrier_cell_sites`.

Carrier records carry a serving cell at each end: the originator's at
submission or setup, and the answering party's over the same window. A real
operator writes those as separate originating and terminating records; these
tables carry one row per exchange, so both belong on it.

Dynamic ClickHouse tables use `ReplacingMergeTree` so interrupted imports can safely be retried.
Queries that must immediately collapse retry duplicates should use `FINAL`;
background merges remove them later. PostgreSQL serializes static activation
with a database advisory lock, including across multiple Fastgate processes.
Run only one Fastgate CLI import at a time for a ClickHouse database.
