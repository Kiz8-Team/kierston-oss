"""Assign ISO 18245 merchant category codes to the commercial POIs.

POIs are already classified into `key=value` type ids by `pois.py`, so an MCC is
a lookup on that type rather than a per-element judgement. The table below
covers every type in pois.json that is a card-accepting merchant; the rest —
parks, benches, loading docks, government buildings — are deliberately absent,
and the report prints them so the gap stays visible.

Written as a report by default: `python mcc.py` prints coverage, `--write`
emits poi_mcc.json keyed by POI index and mcc_by_tag.json keyed by the type id
itself. The pipeline always runs it with `--write`.

The second file exists because the simulation's venue catalogue is not built
from pois.json. `sim/src/activities/discretionary/venues.ts` reads the raw POI export, which still has
the OSM ids and the tags pois.json has dropped, so a POI index is no use to it
— but the tag is the same string in both, and an MCC is a fact about the tag
rather than about the point. Emitting the table rather than transcribing it
into TypeScript keeps one copy of it, and the coverage report below stays the
thing that tells you when it has a hole.

The table is ISO 18245 against OSM tags: neither end of it varies by city, so
it ships with the engine and is the same mapping everywhere.
"""

import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from paths import MCC_BY_TAG, POIS, POI_MCC, SIM_DATA, require  # noqa: E402
from intake.manifest import record  # noqa: E402

# type_id -> (mcc, description). Descriptions are the ISO 18245 short names,
# kept alongside the code so the table can be read without a codebook.
MCC = {
    # --- Food & drink ---------------------------------------------------
    "amenity=restaurant":      (5812, "Eating places, restaurants"),
    "amenity=fast_food":       (5814, "Fast food restaurants"),
    "amenity=cafe":            (5814, "Fast food restaurants"),
    "amenity=ice_cream":       (5814, "Fast food restaurants"),
    "amenity=bar":             (5813, "Drinking places, bars, taverns"),
    "amenity=pub":             (5813, "Drinking places, bars, taverns"),
    "amenity=nightclub":       (5813, "Drinking places, bars, taverns"),
    "amenity=hookah_lounge":   (5813, "Drinking places, bars, taverns"),
    "amenity=stripclub":       (5813, "Drinking places, bars, taverns"),

    # --- Retail ---------------------------------------------------------
    "shop=supermarket":        (5411, "Grocery stores, supermarkets"),
    "shop=convenience":        (5499, "Misc. food stores, convenience"),
    "shop=deli":               (5499, "Misc. food stores, convenience"),
    "shop=health_food":        (5499, "Misc. food stores, convenience"),
    "shop=farm":               (5499, "Misc. food stores, convenience"),
    "shop=coffee":             (5499, "Misc. food stores, convenience"),
    "amenity=vending_machine": (5499, "Misc. food stores, convenience"),
    "shop=bakery":             (5462, "Bakeries"),
    "shop=butcher":            (5422, "Freezer and meat provisioners"),
    "shop=seafood":            (5422, "Freezer and meat provisioners"),
    "shop=dairy":              (5451, "Dairy products stores"),
    "shop=alcohol":            (5921, "Package stores, beer, wine, liquor"),
    "shop=beverages":          (5921, "Package stores, beer, wine, liquor"),
    "shop=tobacco":            (5993, "Cigar stores and stands"),
    "shop=e-cigarette":        (5993, "Cigar stores and stands"),

    "shop=car":                (5511, "Car dealers, new and used"),
    "shop=car_parts":          (5533, "Automotive parts and accessories"),
    "shop=tyres":              (5532, "Tire stores"),
    "shop=car_repair":         (7538, "Automotive service shops"),
    "shop=motorcycle_repair":  (7538, "Automotive service shops"),
    "shop=boat":               (5551, "Boat dealers"),
    "shop=caravan":            (5561, "Camper, RV and trailer dealers"),
    "shop=bicycle":            (5940, "Bicycle shops, sales and service"),

    "shop=clothes":            (5651, "Family clothing stores"),
    "shop=shoes":              (5661, "Shoe stores"),
    "shop=tailor":             (5697, "Tailors, alterations"),
    "shop=fabric":             (5949, "Sewing, needlework, piece goods"),
    "shop=sewing":             (5949, "Sewing, needlework, piece goods"),
    "shop=jewelry":            (5944, "Jewelry, watches, silverware"),
    "shop=watches":            (5944, "Jewelry, watches, silverware"),
    "shop=perfumery":          (5977, "Cosmetic stores"),
    "shop=hairdresser_supply": (5977, "Cosmetic stores"),
    "shop=chemist":            (5912, "Drug stores and pharmacies"),

    "shop=furniture":          (5712, "Furniture and home furnishings"),
    "shop=bed":                (5712, "Furniture and home furnishings"),
    "shop=kitchen":            (5712, "Furniture and home furnishings"),
    "shop=carpet":             (5713, "Floor covering stores"),
    "shop=flooring":           (5713, "Floor covering stores"),
    "shop=interior_decoration": (5713, "Floor covering stores"),
    "shop=window_blind":       (5714, "Drapery and upholstery stores"),
    "shop=lighting":           (5719, "Misc. home furnishing specialty"),
    "shop=bathroom_furnishing": (5719, "Misc. home furnishing specialty"),
    "shop=appliance":          (5722, "Household appliance stores"),
    "shop=vacuum_cleaner":     (5722, "Household appliance stores"),
    "shop=electronics":        (5732, "Electronics stores"),
    "shop=computer":           (5732, "Electronics stores"),
    "shop=radiotechnics":      (5732, "Electronics stores"),
    "shop=mobile_phone":       (4812, "Telecom equipment and sales"),
    "shop=music":              (5733, "Music stores, instruments"),
    "shop=video_games":        (5945, "Hobby, toy and game shops"),
    "shop=games":              (5945, "Hobby, toy and game shops"),
    "shop=party":              (5945, "Hobby, toy and game shops"),

    "shop=hardware":           (5251, "Hardware stores"),
    "shop=doityourself":       (5200, "Home supply warehouse stores"),
    "shop=trade":              (5211, "Lumber and building materials"),
    "shop=tiles":              (5211, "Lumber and building materials"),
    "shop=doors":              (5211, "Lumber and building materials"),
    "shop=paint":              (5231, "Glass, paint and wallpaper"),
    "shop=electrical":         (5065, "Electrical parts and equipment"),
    "shop=hvac":               (1711, "Heating, plumbing, air conditioning"),
    "shop=garden_centre":      (5261, "Nurseries, lawn and garden supply"),
    "shop=plant_hire":         (7359, "Equipment rental and leasing"),
    "shop=rental":             (7359, "Equipment rental and leasing"),

    "shop=variety_store":      (5331, "Variety stores"),
    "shop=wholesale":          (5300, "Wholesale clubs"),
    "amenity=marketplace":     (5399, "Misc. general merchandise"),
    "shop=mall":               (5399, "Misc. general merchandise"),
    "shop=second_hand":        (5931, "Used merchandise, secondhand"),
    "shop=antiques":           (5932, "Antique shops"),
    "shop=pawnbroker":         (5933, "Pawn shops"),
    "shop=books":              (5942, "Book stores"),
    "shop=stationery":         (5943, "Stationery, office supplies"),
    "shop=gift":               (5947, "Gift, card, novelty, souvenir"),
    "shop=craft":              (5970, "Artist supply and craft shops"),
    "shop=florist":            (5992, "Florists"),
    "shop=pet":                (5995, "Pet shops, food and supplies"),
    "shop=fishing":            (5941, "Sporting goods stores"),
    "shop=religion":           (5973, "Religious goods stores"),
    "shop=gas":                (5983, "Fuel dealers"),
    "shop=fuel":               (5983, "Fuel dealers"),
    "shop=cannabis":           (5999, "Misc. retail — see note"),
    "shop=erotic":             (5999, "Misc. specialty retail"),
    "shop=collector":          (5999, "Misc. specialty retail"),
    "shop=frame":              (5999, "Misc. specialty retail"),
    "shop=yes":                (5999, "Misc. specialty retail"),

    "shop=laundry":            (7211, "Laundry services"),
    "shop=dry_cleaning":       (7216, "Dry cleaners"),
    "shop=shoe_repair":        (7251, "Shoe repair, shine, hat cleaning"),
    "shop=hairdresser":        (7230, "Beauty and barber shops"),
    "shop=beauty":             (7230, "Beauty and barber shops"),
    "shop=massage":            (7297, "Massage parlors"),
    "shop=tattoo":             (7299, "Misc. personal services"),
    "shop=pet_grooming":       (7299, "Misc. personal services"),
    "shop=locksmith":          (7699, "Repair shops and related"),
    "shop=repair":             (7699, "Repair shops and related"),
    "shop=copyshop":           (7338, "Quick copy and reproduction"),
    "shop=travel_agency":      (4722, "Travel agencies"),
    "shop=ticket":             (7922, "Theatrical producers, ticket agencies"),
    "shop=storage_rental":     (4225, "Public warehousing and storage"),
    "shop=money_lender":       (6051, "Non-financial institutions"),
    "shop=medical_supply":     (5047, "Medical, dental, ophthalmic supplies"),
    "shop=optician":           (8043, "Opticians and eyeglasses"),
    "shop=funeral_directors":  (7261, "Funeral services and crematories"),

    # --- Services & office ----------------------------------------------
    "amenity=bank":            (6012, "Financial institutions, merchandise"),
    "amenity=atm":             (6011, "Financial institutions, cash disbursement"),
    "office=financial":        (6012, "Financial institutions, merchandise"),
    "office=financial_advisor": (6211, "Security brokers and dealers"),
    "amenity=money_transfer":  (4829, "Money transfer"),
    "office=insurance":        (6300, "Insurance sales and underwriting"),
    "office=estate_agent":     (6513, "Real estate agents and managers"),
    "office=property_management": (6513, "Real estate agents and managers"),
    "office=lawyer":           (8111, "Legal services, attorneys"),
    "office=bail_bond_agent":  (9223, "Bail and bond payments"),
    "office=notary":           (7399, "Business services, not elsewhere classified"),
    "office=tax_advisor":      (7276, "Tax preparation services"),
    "office=accountant":       (8931, "Accounting, auditing, bookkeeping"),
    "office=employment_agency": (7361, "Employment agencies, temp help"),
    "office=advertising_agency": (7311, "Advertising services"),
    "office=graphic_design":   (7333, "Commercial photography, art, graphics"),
    "amenity=studio":          (7333, "Commercial photography, art, graphics"),
    "office=architect":        (8911, "Architectural, engineering, surveying"),
    "office=engineer":         (8911, "Architectural, engineering, surveying"),
    "office=it":               (7379, "Computer maintenance and repair"),
    "office=security":         (7393, "Protective and security services"),
    "office=telecommunication": (4814, "Telecommunication services"),
    "office=water_utility":    (4900, "Utilities — electric, gas, water"),
    "office=energy_supplier":  (4900, "Utilities — electric, gas, water"),
    "office=charity":          (8398, "Charitable and social service orgs"),
    "office=adoption_agency":  (8398, "Charitable and social service orgs"),
    "amenity=animal_shelter":  (8398, "Charitable and social service orgs"),
    "office=association":      (8641, "Civic, social, fraternal associations"),
    "office=union":            (8699, "Membership organizations"),
    "office=religion":         (8661, "Religious organizations"),
    "office=company":          (7399, "Business services, not elsewhere classified"),
    "office=yes":              (7399, "Business services, not elsewhere classified"),
    "amenity=car_wash":        (7542, "Car washes"),
    "amenity=car_rental":      (7512, "Automobile rental agency"),
    "amenity=animal_boarding": (742,  "Veterinary services"),
    "amenity=events_venue":    (7999, "Recreation services"),
    "amenity=conference_centre": (7999, "Recreation services"),
    "amenity=exhibition_centre": (7999, "Recreation services"),
    "amenity=dancing_school":  (7911, "Dance halls, studios, schools"),
    "amenity=post_office":     (9402, "Postal services — government only"),

    # --- Health -----------------------------------------------------------
    "amenity=doctors":         (8011, "Doctors and physicians"),
    "amenity=clinic":          (8011, "Doctors and physicians"),
    "amenity=dentist":         (8021, "Dentists and orthodontists"),
    "amenity=hospital":        (8062, "Hospitals"),
    "amenity=pharmacy":        (5912, "Drug stores and pharmacies"),
    "amenity=veterinary":      (742,  "Veterinary services"),

    # --- Education --------------------------------------------------------
    "amenity=school":          (8211, "Elementary and secondary schools"),
    "amenity=college":         (8220, "Colleges, universities"),
    "amenity=university":      (8220, "Colleges, universities"),
    "amenity=childcare":       (8351, "Child care services"),
    "amenity=kindergarten":    (8351, "Child care services"),
    "amenity=music_school":    (8299, "Schools and educational services"),
    "amenity=driving_school":  (8299, "Schools and educational services"),
    "amenity=dojo":            (7997, "Membership clubs, athletic"),

    # --- Lodging ----------------------------------------------------------
    "tourism=hotel":           (7011, "Lodging, hotels, motels, resorts"),
    "tourism=motel":           (7011, "Lodging, hotels, motels, resorts"),

    # --- Leisure that takes payment --------------------------------------
    "amenity=theatre":         (7922, "Theatrical producers, ticket agencies"),
    "amenity=cinema":          (7832, "Motion picture theaters"),
    "amenity=arts_centre":     (7999, "Recreation services"),
    "tourism=museum":          (7991, "Tourist attractions and exhibits"),
    "tourism=gallery":         (5971, "Art dealers and galleries"),
    "leisure=fitness_centre":  (7997, "Membership clubs, athletic"),
    "leisure=sports_centre":   (7997, "Membership clubs, athletic"),
    "leisure=golf_course":     (7992, "Public golf courses"),
    "leisure=bowling_alley":   (7933, "Bowling alleys"),
    "leisure=adult_gaming_centre": (7995, "Betting, casino gaming"),
    "leisure=stadium":         (7941, "Commercial sports, athletic fields"),
    "leisure=track":           (7941, "Commercial sports, athletic fields"),
    "leisure=marina":          (4468, "Marinas, marine service and supplies"),

    # --- Transport --------------------------------------------------------
    "amenity=fuel":            (5541, "Service stations"),
    "amenity=charging_station": (5552, "Electric vehicle charging"),
    "amenity=bus_station":     (4131, "Bus lines"),
    "amenity=taxi":            (4121, "Taxicabs and limousines"),
    "amenity=parking":         (7523, "Parking lots and garages"),
}

# Types that are real places but never a card acceptor. Listed explicitly so
# the report can separate "not a merchant" from "table has a hole".
NON_MERCHANT = {
    "amenity=place_of_worship", "amenity=social_facility", "amenity=social_centre",
    "amenity=community_centre", "amenity=library", "amenity=library_dropoff",
    "office=government", "amenity=townhall", "amenity=courthouse", "amenity=police",
    "amenity=fire_station", "amenity=prison", "amenity=grave_yard",
    "amenity=polling_station", "amenity=post_depot", "amenity=give_box",
    "amenity=compressed_air", "amenity=fountain", "amenity=stage",
    "amenity=parking_space", "amenity=parking_entrance", "amenity=bicycle_parking",
    "tourism=artwork", "tourism=information", "tourism=viewpoint", "tourism=yes",
    "historic=memorial", "historic=building", "historic=district", "historic=stone",
    "historic=monument", "historic=yes", "historic=factory",
    "leisure=pitch", "leisure=park", "leisure=playground", "leisure=garden",
    "leisure=dog_park", "leisure=nature_reserve", "leisure=fitness_station",
    "leisure=bandstand", "leisure=swimming_pool", "leisure=slipway",
    "leisure=schoolyard", "leisure=picnic_table", "leisure=bleachers",
    "leisure=outdoor_seating",
    "shop=vacant", "amenity=disused", "amenity=loading_dock", "amenity=elevator",
    "amenity=security_booth", "amenity=dressing_room",
}


def load():
    require(POIS, "run intake/pois.py first")
    data = json.loads(POIS.read_text())
    types = {}
    for group in data["groups"]:
        for entry in group["types"]:
            types[entry["i"]] = (entry["id"], group["id"])
    return data, types


def main() -> None:
    data, types = load()

    assigned = Counter()
    by_code = Counter()
    unmapped = Counter()
    skipped = 0
    records = {}

    for index, point in enumerate(data["points"]):
        type_id, group_id = types[point[3]]
        hit = MCC.get(type_id)
        if hit:
            assigned[type_id] += 1
            by_code[hit] += 1
            records[index] = hit[0]
        elif type_id in NON_MERCHANT or group_id in ("furniture", "fixture", "private"):
            skipped += 1
        else:
            unmapped[type_id] += 1

    total = len(data["points"])
    merchant_total = sum(assigned.values()) + sum(unmapped.values())
    print(f"{total} POIs, {skipped} non-merchant, {merchant_total} candidate merchants")
    print(f"assigned {sum(assigned.values())} "
          f"({sum(assigned.values()) / merchant_total:.1%} of candidates), "
          f"{len(by_code)} distinct MCCs")

    if unmapped:
        print(f"\nunmapped ({sum(unmapped.values())} points, {len(unmapped)} types):")
        for type_id, count in unmapped.most_common():
            print(f"  {type_id:40s} {count}")

    print("\ntop codes:")
    for (code, label), count in by_code.most_common(20):
        print(f"  {code:>4}  {label:45s} {count}")

    if "--write" in sys.argv:
        SIM_DATA.mkdir(exist_ok=True)
        POI_MCC.write_text(json.dumps({
            "source": POIS.name,
            "count": len(records),
            "codes": {str(k): v for k, v in records.items()},
        }))
        print(f"\nwrote {POI_MCC} ({len(records)} points)")

        # The whole table, not only the tags this extract happens to contain:
        # a re-export that adds a jeweller should not need this script rerun
        # before the sim can price a visit to one.
        MCC_BY_TAG.write_text(json.dumps({
            "source": "intake/mcc.py",
            "count": len(MCC),
            "tags": {tag: code for tag, (code, _) in sorted(MCC.items())},
            "labels": {str(code): label for code, label in sorted(MCC.values())},
            "non_merchant": sorted(NON_MERCHANT),
        }, indent=1))
        print(f"wrote {MCC_BY_TAG} ({len(MCC)} tags)")

        record("mcc", inputs=[POIS], outputs=[POI_MCC, MCC_BY_TAG])


if __name__ == "__main__":
    main()
