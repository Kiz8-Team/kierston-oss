# State-specific generators

Code that depends on one state's laws, number formats and institutions. Each
state has a folder named by its two-letter code, for example `PA/`. The folder
is chosen by `[state] code` in `kierston/jurisdictions/<profile>/jurisdiction.toml`.

Consumers load a module with `jurisdiction.state_module("<name>")`. The build
stops if the active state has no such module.

Data that a state needs but that is not code (offense table, plate letters,
license series, carry license rules) stays in `kierston/jurisdictions/<profile>/`.

## Adding a state

Copy `PA/` to `<code>/` and rewrite every module. Each module must provide the
names below, with the same signatures and return shapes.

| Module | Names | Used by |
| --- | --- | --- |
| `offenses.py` | `load()`, `stem(section)`, `maximum(offence)`, `felony(offence)`, `prs(priors)` | `criminal_history/dockets.py` |
| `sentencing.py` | `severity(offence)`, `ogs_of(offence)`, `sentence(offence, prior_score, range_shift, rng)` | `criminal_history/dockets.py` |
| `charging.py` | `CHARGE_WEIGHTS`, `RESIDUAL_WEIGHT`, `SITUATIONAL_MIX`, `COMPANIONS`, `DIRECT_FILE_AGE` | `criminal_history/dockets.py` |
| `courts.py` | `DISPOSITIONS`, `SUMMARY_DISPOSITIONS`, `DIVORCE_GROUNDS`, `apply_clean_slate(cases)`, `firearms_prohibition(cases, rng)` | `criminal_history/dockets.py` |
| `formats.py` | `passenger_plate(letters, serial)`, `SEQUENTIAL_PLATE`, `municipal_plate(index)`, `school_bus_plate(index)`, `licence_number(sequence)`, `magisterial_docket(district, sequence, year, kind)`, `common_pleas_docket(judicial_district, sequence, year, kind)`, `series_of(docket)` | `personal_records/registries.py`, `criminal_history/dockets.py` |
| `money.py` | `KEEP_WAGES`, `UNEMPLOYMENT_CADENCE`, `UNEMPLOYMENT_WEEKDAY`, `STUDENT_LOAN_SERVICERS`, `MUNICIPAL_INSURERS`, `FLEET_INSURERS`, `PROPERTY_TAX`, `HOME_INSURER` | `personal_records/banking.py`, `holdings.py`, `vehicles.py`, `recurring_spending.py` |
| `traffic.py` | `POSITION` (tier and bearing of every state code in `traffic/us_plate_rules.json`), `RECURRING_WEIGHTS`, `ONE_OFF_WEIGHTS` | `traffic/external.py`; `ONE_OFF_WEIGHTS` is written to `external_traffic.json` for the day simulator |

## Record schema

Court records use the tier names `magisterial`, `common_pleas`, `juvenile` and
`federal`, and sentences use the kinds `probation`, `county_jail` and
`state_prison`. Fastgate, KDI and KierstonBlue read these names. A state with
different courts maps its own courts onto these tiers.
