import accounts
import devices
import dockets
import init_sim


def test_custody_withdraws_numbers_idempotently_and_restores_them_on_release():
    person = {"id": 1, "incarcerated": True}
    population = {"person_records": [person], "quarters_records": []}
    identities = {"1": {"mobile": "+16105550101", "landline": "+16105550102"},
                  "2": {"mobile": "+16105550103"}}
    dockets.apply_phone_custody(population, identities)
    dockets.apply_phone_custody(population, identities)
    assert identities["1"]["mobile"] is None
    assert identities["1"]["landline"] is None
    assert identities["2"]["mobile"] == "+16105550103"
    person["incarcerated"] = False
    dockets.apply_phone_custody(population, identities)
    assert identities["1"] == {"mobile": "+16105550101", "landline": "+16105550102"}


def test_incarcerated_people_receive_no_devices_even_with_a_stale_mobile_number():
    population = {"person_records": [{"id": 1, "age": 30, "incarcerated": True}],
                  "quarters_records": [{"id": 2, "age": 30, "incarcerated": True}],
                  "household_records": []}
    identities = {"1": {"mobile": "+16105550101"}, "2": {"mobile": "+16105550102"}}
    assert devices.build(population, identities, {"parents": {}}, 7) == ({}, {})
    assert accounts.load_people(population, {"identities": identities}) == {}
    # Old device files cannot reintroduce a carrier account either.
    assert not accounts.build_accounts({}, {1: {"msisdn": "+16105550101"}}, {}, 7)


def test_phone_stages_run_after_custody_and_before_packing():
    names = [stage.name for stage in init_sim.STAGES]
    assert names.index("ties") < names.index("dockets")
    assert names.index("dockets") < names.index("devices") < names.index("accounts")
    assert names.index("accounts") < names.index("pack_records")
