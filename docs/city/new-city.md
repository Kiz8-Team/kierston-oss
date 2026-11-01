# Setting up another US city

The engine builds any city that has a city profile, a jurisdiction and a set of
downloaded sources. This page lists what to create, what to download, and where
each file goes. The Kierston city (`kierston`) is the working example for every
file.

In the commands below, `<slug>` is the new city's short name, for example
`reading`. Commands run from the repository root.

## Overview

| Step | Result |
| --- | --- |
| 1. Write the city profile | `kierston/cities/<slug>.toml` |
| 2. Write the city lists | `kierston/cities/<slug>/*.csv` |
| 3. Pick or write a jurisdiction | `kierston/jurisdictions/<profile>/` and `kierston/init/state_specific_generators/<code>/` |
| 4. Download sources | `kierston/sources/<slug>/` |
| 5. Build the city and road graph | a city build |
| 6. Export a day, place cameras, export again | KDAY files with plate reads |

## Folder layout

| Folder | Contents | Tracked in git |
| --- | --- | --- |
| `kierston/cities/<slug>.toml` | City profile | yes |
| `kierston/cities/<slug>/` | City lists (CSV) and `cameras.json` | yes |
| `kierston/jurisdictions/<profile>/jurisdiction.toml` | State rules | yes |
| `kierston/jurisdictions/<profile>/offense_list.csv` | State offense table | no |
| `kierston/sources/<slug>/` | Downloaded sources | no |
| [`kierston/reference/`](../../kierston/reference) | City-independent assets, shared by all cities | no |

`KIERSTON_CITY=<slug>` selects the city for every stage: the build, the
pathfinder, the simulator and KierstonBlue. Set it in the shell for all steps
below.

```bash
export KIERSTON_CITY=<slug>
```

## 1. City profile

Copy [`kierston/cities/kierston.toml`](../../kierston/cities/kierston.toml) to `kierston/cities/<slug>.toml` and edit
it. Every key is required.

| Key | Meaning |
| --- | --- |
| `[city] name` | Display name |
| `[city] slug` | Same as the file name and `KIERSTON_CITY` |
| `[extent] center` | `[lat, lon]` of the area center |
| `[extent] radius_m` | Radius of the area in meters. Kierston uses 5000 |
| `[microdata] dataset` | ACS PUMS dataset, e.g. `acs5` |
| `[microdata] vintage` | ACS year, e.g. `2023` |
| `[microdata] state` | State FIPS code as a string, e.g. `"42"` |
| `[microdata] puma` | List of PUMA codes that cover the area |
| `[jurisdiction] profile` | Folder name in [`kierston/jurisdictions/`](../../kierston/jurisdictions) |
| `[locale] time_zone` | IANA time zone |
| `[locale] reference_date` | The simulation's current date (TOML date) |
| `[locale] centre` | Downtown point for the rent model |
| `[locale] postal_city` | City name used in addresses |
| `[locale] county` | County name, used for sheriff, recorder, treasurer and jail |
| `[locale] judicial_district`, `federal_division` | Court docket number prefixes |
| `[locale] carry_licence_prefix`, `carry_licence_series_start` | Carry license numbering |
| `[locale] area_codes` | Area codes in use |
| `[[locale.area_code_eras]]` | `before` (year) and `shares` (one per area code) |
| `[housing] min_sample`, `flats_default`, `flats_per_tall_level` | Dwelling-count fitting. Keep the Kierston values unless the local OSM data is unusual |

Find PUMA codes with the Census Bureau's PUMA reference maps for the state.
Choose PUMAs that cover the extent.

## 2. City lists

Create `kierston/cities/<slug>/` with these files. Use [`kierston/cities/kierston/`](../../kierston/cities/kierston)
as the template. All files are required. Row order matters: weighted draws
read rows in file order.

| File | Columns | One row |
| --- | --- | --- |
| `exchanges.csv` | `npa,nxx,service` | Phone exchange; `service` is `landline` or `wireless`. Every `npa` must be in `area_codes` |
| `magisterial_districts.csv` | `district,weight` | Lower court district and its share of cases |
| `banks.csv` | `name,routing_prefix,weight` | Local bank |
| `gun_dealers.csv` | `name,ffl` | Licensed firearms dealer |
| `colleges.csv` | `name,level,weight` | College; `level` is `associate` or `bachelor` |
| `graduate_schools.csv` | `name` | Graduate school |
| `high_schools.csv` | `name` | High school named on credentials |
| `mortgage_lenders.csv` | `name` | Mortgage lender |
| `pharmacies.csv` | `name,weight` | Pharmacy |
| `billers.csv` | `role,name,weight,price` | Recurring payee. One row each for `electricity`, `gas`, `water`, `trash`, `school_district`, `second_mortgage`. At least one row each for `heating_oil`, `internet`, `television`, `gym`, `charity`, `storage`, `news` |
| `school_transport.csv` | `id_offset,name,kind,legal_form,sectors` | School district and bus contractor; `sectors` separated by `;` |
| `taxi_operators.csv` | `id_offset,name,kind,legal_form,site,fallback_lat,fallback_lon,fallback_floor` | Cab company. `site` is an OSM id from this city's buildings, e.g. `way/799510247` |
| `payers.csv` | `sector,name` | Wage payer per employer sector, `benefit:*` rows, and one `fallback` row |
| `cab_companies.csv` | `name` | Payee name on taxi fares |

`cameras.json` is generated in step 6.

## 3. Jurisdiction

A city in Pennsylvania uses `us-pa` as is. A city in another state needs a new
folder `kierston/jurisdictions/us-<state>/`.

| File | Contents |
| --- | --- |
| `jurisdiction.toml` | Copy `us-pa/jurisdiction.toml` and edit every section |
| `offense_list.csv` | Offense table with columns `Title,Section,Description,Statutory Class,OGS,POG,Mandatory/ Enhancements`. The first line is skipped |

`jurisdiction.toml` sections:

| Section | Sets |
| --- | --- |
| `[state]` | `code`, `name`, `fips` |
| `[statutes]` | `cite`, citation format using `{title}` and `{section}` |
| `[corrections]` | `state_prison` |
| `[licensing]` | Driver's license issuer, number series, renewal cycle; `[licensing.suspension_months]` |
| `[plates]` | Plate letters, block dating, front plate rule, special series, registration fee |
| `[[plates.visitors]]` | Out-of-state plate mix: `jurisdiction`, `share`, `pattern` |
| `[firearms]` | Carry license statute, age, term; background check agency; record-of-sale form |

A state also needs code in
[`kierston/init/state_specific_generators/<code>/`](../../kierston/init/state_specific_generators),
where `<code>` is `[state] code` from `jurisdiction.toml`. See
[State-specific code](#state-specific-code).

## 4. Sources

Install the extra Python packages for the download scripts once:

```bash
kierston/.venv/bin/python -m pip install -r kierston/requirements-acquire.txt
```

All scripts read the extent and PUMAs from the city profile. Output goes to
`kierston/sources/<slug>/`.

| File | Source | How to get it | Required |
| --- | --- | --- | --- |
| `pums.json`, `pums_codebook.json` | Census Bureau ACS PUMS API | `fetch_pums.py` | yes |
| `topology.graphml` | OpenStreetMap roads and paths | `download_topology.py` | yes |
| `buildings_geom.json` | OpenStreetMap buildings, Overpass API | Overpass query below | yes |
| `pois_export.json` | OpenStreetMap places, Overpass API | Overpass query below | yes |
| `asr_towers.json` | FCC Antenna Structure Registration | `build_asr_towers.py` | yes |
| `opencellid_local.json` | OpenCelliD cell dumps | `build_opencellid.py` | yes |
| `geocode_cache.json` | Nominatim reverse geocoding | `geocode_pois.py` | no |

### Census microdata

Get a free API key from the Census Bureau (api.census.gov/data/key_signup.html).

```bash
CENSUS_API_KEY=<key> kierston/.venv/bin/python kierston/acquire/fetch_pums.py
```

`--no-replicates` skips the 160 replicate weight columns. The key can also go
in `kierston/.census_key`.

### Road network

```bash
kierston/.venv/bin/python kierston/acquire/download_topology.py
```

Downloads every OSM way with a `highway` tag within the radius. No key.

### Buildings

Overpass query. Replace the radius and center with the profile values. The
output must use `out body geom` so ways carry their footprint.

```
[out:json][timeout:900];
nwr["building"](around:5000,40.602989,-75.472188);
out body geom;
```

```bash
curl -s --data-urlencode data@buildings.overpassql https://overpass-api.de/api/interpreter -o kierston/sources/<slug>/buildings_geom.json
```

### Places

The output must use `out center` so ways and relations carry a center point.

```
[out:json][timeout:600];
(
  nwr["amenity"](around:5000,40.602989,-75.472188);
  nwr["shop"](around:5000,40.602989,-75.472188);
  nwr["leisure"](around:5000,40.602989,-75.472188);
  nwr["office"](around:5000,40.602989,-75.472188);
  nwr["tourism"](around:5000,40.602989,-75.472188);
  nwr["historic"](around:5000,40.602989,-75.472188);
);
out body center;
```

```bash
curl -s --data-urlencode data@pois.overpassql https://overpass-api.de/api/interpreter -o kierston/sources/<slug>/pois_export.json
```

### Cell towers

```bash
kierston/.venv/bin/python kierston/reference/build/build_asr_towers.py
```

Downloads the FCC weekly ASR dump (no key) and keeps structures within the
radius plus 3 km.

```bash
kierston/.venv/bin/python kierston/reference/build/build_opencellid.py --token <token> --cache <dir>
```

Needs a free OpenCelliD token (`--token` or `OPENCELLID_TOKEN`). OpenCelliD
allows a few downloads per day. `--cache` keeps the downloaded files so a
second run does not download them again. The default MCCs are 310, 311, 312,
313 and 316.

### Place addresses (optional)

```bash
kierston/.venv/bin/python kierston/acquire/geocode_pois.py
```

Adds addresses to places that have no `addr:*` tags. Nominatim allows one
request per second, so a few thousand places take over an hour. The script
resumes from its cache after a stop. Without this file those places have no
address.

## 5. Build

```bash
bun run city-init --out kierston/builds/<slug>
```

This builds the city and its road graph into the folder.

Without `--out` the build replaces `kierston/sim_data/`. Start with
`--households 1000` to check the inputs, then build the full city. See
[Building a city](building.md).

## 6. Days and cameras

The plate-reader cameras are placed from the traffic of an exported day, so
the first day has no plate reads.

| Step | Command |
| --- | --- |
| Export a first day into `kierston/sim_outputs/` | `bun run day --city kierston/builds/<slug> --export-day --date 2026-09-01 --output-dir kierston/sim_outputs` |
| Place the cameras | `KIERSTON_SIM_DATA_DIR=kierston/builds/<slug> kierston/.venv/bin/python kierston/init/surveillance/cameras.py --date 2026-09-01` |
| Export days for use | `bun run day --city kierston/builds/<slug> --export-day --date 2026-09-01` |

`cameras.py` reads the day from `kierston/sim_outputs/` only, which is why the
first export uses `--output-dir`. Use a date that has no other city's day file
in that folder. `cameras.py` also needs the build's road graph and
`pois.json`, and writes `kierston/cities/<slug>/cameras.json`. The camera file
refers to road graph edges, so rerun it whenever the road graph changes.

To load the new city into the record stores, use its files in the
[Fastgate commands](../data/stores.md#load-data):
`builds/<slug>/sim_init.bin`, `cities/<slug>/cameras.json`,
`builds/<slug>/towers.json` and the exported days.

## Reference assets

[`kierston/reference/`](../../kierston/reference) is shared by all cities and comes from the input bundle.

| File | Use for another city |
| --- | --- |
| `names.json` | As is |
| `occp_mapping.json` | As is |
| `tac_table.json` | As is |
| `vehicle_market.json` | Weighted toward the Middle Atlantic census division. For a city in another division, edit `MID_ATLANTIC` in [`kierston/reference/build/build_vehicle_market.py`](../../kierston/reference/build/build_vehicle_market.py) and rebuild it from `kierston/reference/raw/` |

## State-specific code

Code that depends on one state's laws and formats is in
[`kierston/init/state_specific_generators/<code>/`](../../kierston/init/state_specific_generators).
The build loads the folder that matches `[state] code` in `jurisdiction.toml`
and stops if it is missing. A city in Pennsylvania uses `PA/` as is. For
another state, copy `PA/` to the new code and rewrite each module. The names
each module must provide are listed in
[`state_specific_generators/README.md`](../../kierston/init/state_specific_generators/README.md).

| Module | Pennsylvania content |
| --- | --- |
| [`offenses.py`](../../kierston/init/state_specific_generators/PA/offenses.py) | Offense catalog from `offense_list.csv`, statute ranges, maximum sentences, drug and DUI supplements |
| [`sentencing.py`](../../kierston/init/state_specific_generators/PA/sentencing.py) | OGS and PRS guideline matrix, county jail and state prison line, RRRI |
| [`charging.py`](../../kierston/init/state_specific_generators/PA/charging.py) | Charge weights by statute, companion charges, direct-file age |
| [`courts.py`](../../kierston/init/state_specific_generators/PA/courts.py) | Disposition shares, divorce grounds, Clean Slate sealing, § 6105 firearm bans |
| [`formats.py`](../../kierston/init/state_specific_generators/PA/formats.py) | Plate, docket and driver's license number formats |
| [`money.py`](../../kierston/init/state_specific_generators/PA/money.py) | Income tax withholding, unemployment schedule, property tax split, state insurers and loan servicers |
| [`traffic.py`](../../kierston/init/state_specific_generators/PA/traffic.py) | Out-of-state visitor weights, and each state's tier and direction as seen from PA |

The criminal code in `PA/` follows Pennsylvania's grading (F-1 to M-3, OGS,
POG). Court records use the tier names `magisterial`, `common_pleas`,
`juvenile` and `federal`, which the record stores and KierstonBlue read. A
state with different courts maps its courts onto these tiers.

## Other Pennsylvania and Kierston values

These are outside `state_specific_generators/` because they belong to the
Kierston city rather than to the state. A new city builds with them, but its
records carry these names and calibrations until they are changed.

| Area | Location | Value |
| --- | --- | --- |
| Carrier shares | [`kierston/init/personal_records/devices.py`](../../kierston/init/personal_records/devices.py) | Market shares for eastern Pennsylvania |
| City-named payees | [`kierston/init/personal_records/fleet.py`](../../kierston/init/personal_records/fleet.py), [`kierston/init/personal_records/recurring_spending.py`](../../kierston/init/personal_records/recurring_spending.py), [`kierston/init/surveillance/cameras.py`](../../kierston/init/surveillance/cameras.py), [`kierston/sim/src/economy/spend.ts`](../../kierston/sim/src/economy/spend.ts) | "Kierston Police Department", "Kierston Parking Authority" and similar |
| Size calibration | [`kierston/init/work/init_work.py`](../../kierston/init/work/init_work.py), [`kierston/init/surveillance/cameras.py`](../../kierston/init/surveillance/cameras.py), [`kierston/init/personal_records/recurring_spending.py`](../../kierston/init/personal_records/recurring_spending.py) | Staff counts, camera budget (74), rent model constants |
| Utility seasonality | [`kierston/init/personal_records/recurring_spending.py`](../../kierston/init/personal_records/recurring_spending.py) | Eastern Pennsylvania heating and cooling curve |
| Model-visible text | [`kierston_bench/model_visible_text.ts`](../../kierston_bench/model_visible_text.ts), [`kierston_bench/kdi/src/catalog.ts`](../../kierston_bench/kdi/src/catalog.ts) | "Allentown", "PennDOT", court labels, `(610)` placeholder |

[`kierston/init/tests/test_paths_profile.py`](../../kierston/init/tests/test_paths_profile.py) checks Kierston values and fails
under another profile.

## Input bundle

[`kierston/init-inputs.tar.zst`](../../kierston/init-inputs.tar.zst) holds the Kierston sources, the reference
assets and `us-pa/offense_list.csv`. To share a new city's sources the same
way, pack them with paths relative to [`kierston/`](../../kierston):

```bash
tar --zstd -cf <slug>-inputs.tar.zst -C kierston sources/<slug> jurisdictions/<profile>/offense_list.csv
```
