# Third-party data attribution

Kierston is a synthetic city, but it is built from real public data. No resident,
household, vehicle, account or record in it is a real one; the sources below
supply the distributions, the geography and the reference tables the generator
draws on. This file lists each source, what it is used for, where it enters the
pipeline, and the terms it is used under.

None of the organisations named here endorse, certify or are affiliated with
this project.

## Redistributed in this repository

These sources are present, in whole or as extracts, inside
`kierston/init-inputs.tar.zst`, and the published `sim_data` and KDAY archives
are derived from them.

| Source | Publisher | Used for | Enters at | Terms |
| --- | --- | --- | --- | --- |
| American Community Survey 2019–2023 5-Year Public Use Microdata Sample, PUMA 42-02803 | U.S. Census Bureau | The household and person records the population is cloned from, and the housing-cost fields behind rent, mortgages and utilities | `acquire/fetch_pums.py` → `sources/<city>/pums.json`, `pums_codebook.json` | U.S. government work, public domain. Retrieved through the Census Data API |
| OpenStreetMap — buildings, points of interest, road topology | OpenStreetMap contributors | Dwelling stock, venues, workplaces, schools, the road graph and the address index | Overpass exports and `acquire/download_topology.py` (OSMnx) → `sources/<city>/buildings_geom.json`, `pois_export.json`, `topology.graphml` | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/). © OpenStreetMap contributors, <https://www.openstreetmap.org/copyright> |
| Nominatim reverse geocoding | OpenStreetMap Foundation | Street addresses for POIs the local index cannot answer | `acquire/geocode_pois.py` → `sources/<city>/geocode_cache.json`; `pathfinder/src/geocode.ts` | Results are OpenStreetMap data under ODbL 1.0; used within the [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/) |
| Antenna Structure Registration (ASR) database, weekly complete dump | Federal Communications Commission | Real antenna structures — coordinate, height, type, owner — that the cellular network is sited on | `reference/build/build_asr_towers.py` → `sources/<city>/asr_towers.json` | U.S. government work, public domain. <https://data.fcc.gov/download/pub/uls/complete/r_tower.zip> |
| OpenCelliD bulk cell dumps (MCC 310 and 313) | Unwired Labs | Observed eNodeB/gNodeB id ranges, tracking area codes, sectors per site and deployed radio technologies. Never used for tower positions | `reference/build/build_opencellid.py` → `sources/<city>/opencellid_local.json` | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). <https://opencellid.org> |
| TAC database (`tac_full.csv`) | MoazEb/tac-database, itself cross-referenced from Osmocom tacdb and public IMEI lookups | The real GSMA Type Allocation Codes on every handset's IMEI | `reference/build/build_tac_table.py` → `reference/tac_table.json` | MIT. <https://github.com/MoazEb/tac-database> |
| 2022 National Household Travel Survey, public-use vehicle file (`vehv2pub.csv`) | Federal Highway Administration, U.S. Department of Transportation | Which vehicles households own by income bracket — make, body type, age, leased or owned | `reference/build/build_vehicle_market.py` → `reference/vehicle_market.json` | U.S. government work, public domain. <https://nhts.ornl.gov> |
| Fuel economy data (`vehicles.csv`) | U.S. Environmental Protection Agency and U.S. Department of Energy, fueleconomy.gov | The catalogue of models each make actually sold, by model year and size class | `reference/build/build_vehicle_market.py` → `reference/vehicle_market.json` | U.S. government work, public domain. <https://www.fueleconomy.gov/feg/download.shtml> |
| CPS Occupation Classification (2018 Census occupation codes with SOC equivalents) | U.S. Census Bureau | Mapping PUMS `OCCP` codes to occupations and SOC groups | `reference/occp_mapping.json` | U.S. government work, public domain. <https://www2.census.gov/programs-surveys/cps/methodology/Occupation%20Codes.pdf> |
| Offence listing — statutory grade, Offence Gravity Score, Prior Offence Group | Pennsylvania Commission on Sentencing | The catalogue of chargeable offences behind the court dockets | `jurisdictions/us-pa/offense_list.csv` | Public record of the Commonwealth of Pennsylvania. <https://pcs.la.psu.edu> |

## Used for calibration only

These are read at development time, or cited for a published figure. None of
their data is redistributed here; only fitted parameters or quoted aggregates
appear in the code.

| Source | Publisher | Used for | Where |
| --- | --- | --- | --- |
| Consumer Expenditure Surveys, 2024 Diary public-use microdata | U.S. Bureau of Labor Statistics | Basket sizes and ticket distributions for venue spending | `sim/src/economy/spend.ts` |
| Survey and Diary of Consumer Payment Choice, 2025 findings | Federal Reserve Financial Services / Federal Reserve Bank of Atlanta | Payments per person per month, cash share, bill and remote-payment counts | `init/personal_records/banking.py`, `recurring_spending.py`, `sim/src/economy/bills.ts` |
| Social Media Fact Sheet and related platform-use surveys | Pew Research Center | Messaging-platform reach and age gradients | `init/personal_records/accounts.py` |
| Global Automotive Color Popularity Report, North America | Axalta | Vehicle colour shares by body type | `reference/build/build_vehicle_market.py` |
| ISO 18245 merchant category codes | International Organization for Standardization | The MCC assigned to each commercial POI type; codes and short names only | `init/intake/mcc.py` |
| GSMA SGP.02 (eUICC identifier scheme) | GSMA | The EID check-digit computation | `init/personal_records/devices.py` |

The hand-authored tables — `reference/names.json`, `init/traffic/us_plate_rules.json`
and the supplementary drug, DUI and summary offences in
`init/state_specific_generators/PA/offenses.py` — are this project's own estimates and are
not derived from a dataset. [`NOTICES.md`](NOTICES.md) records which numbers are
measured and which are judgement.

## Required notices

**U.S. Census Bureau.** This product uses the Census Bureau Data API but is not
endorsed or certified by the Census Bureau.

**OpenStreetMap.** Map data © OpenStreetMap contributors, available under the
Open Database License. The `sources/<city>/` OSM extracts, and the `sim_data/`
files that carry OSM contents forward (`buildings.json`, `dwellings.json`,
`pois.json`, `car_graph.bin`, `workplaces.json`, `schools.json`, `orgs.json`),
are a derivative database under ODbL 1.0: if you redistribute them, keep this
attribution and offer them under the same licence. The rest of `sim_data/` and
the KDAY, KSTATE and KDIF files are not; [`LICENSE`](LICENSE) draws the line
file by file. The KierstonBlue map view
also loads raster tiles from `tile.openstreetmap.org` and credits them on the
map.

**OpenCelliD.** `sources/<city>/opencellid_local.json` is adapted from the
OpenCelliD database, © Unwired Labs, licensed CC BY-SA 4.0. The extract is
filtered to a radius around the city and reduced to identifier allocations and
per-site summaries; redistribution of it must carry the same licence.

**NHTS.** Federal Highway Administration. (2022). *2022 NextGen National
Household Travel Survey Core Data*. U.S. Department of Transportation,
Washington, DC. Available online: <https://nhts.ornl.gov>.

**TAC database.** Used under the MIT licence; the copyright and permission
notice are in the upstream repository at
<https://github.com/MoazEb/tac-database>.

## Software used to acquire the data

`acquire/` depends on [OSMnx](https://github.com/gboeing/osmnx) (MIT) to download
the road topology. If you use that path in published work, its author asks that
you cite: Boeing, G. (2025). Modeling and Analyzing Urban Networks and Amenities
with OSMnx. *Geographical Analysis*.
