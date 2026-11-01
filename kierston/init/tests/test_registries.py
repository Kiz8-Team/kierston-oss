import registries
from registries import keyed


def test_keyed_streams_are_reproducible_and_independent():
    assert keyed(7, 42, "ssn").random() == keyed(7, 42, "ssn").random()
    assert keyed(7, 42, "ssn").random() != keyed(7, 42, "phone").random()
    assert keyed(7, 42, "ssn").random() != keyed(7, 43, "ssn").random()


def test_vin_check_digit():
    # A published example VIN whose check character is X.
    assert registries.vin_check("1M8GDM9AXKP042788") == "X"
    assert registries.vin_check("11111111111111111") == "1"


def test_generated_vins_validate():
    rng = keyed(1, "vin-test")
    for year in (1995, 2008, 2024):
        vin = registries.vin(year, rng)
        assert len(vin) == 17
        assert vin[8] == registries.vin_check(vin)
        assert not set(vin) & set("IOQ")


def test_plates_format_their_series_position():
    assert registries.plate(0) == "AAA-0000"
    assert registries.plate(10_000 + 42) == "AAB-0042"
    letters = registries.plate(registries.plate_block("LAA") * 10_000 + 7)
    assert letters == "LAA-0007"
    assert registries.municipal_plate(12) == "MG-00012"


def test_personalized_plates():
    assert registries.personalized_plate(" go  bird ") == "GO BIRD"  # spaces collapsed, upper-cased
    assert registries.personalized_plate(" eagles ") == "EAGLES"
    assert registries.personalized_plate("ABC1234") is None  # reads as a sequential plate
    assert registries.personalized_plate("TOOLONGX") is None
    assert registries.personalized_plate("A_B") is None


def test_docket_formats():
    assert registries.magisterial_docket("31-2-01", 123, 2026) == "MJ-31201-CR-0000123-2026"
    assert registries.common_pleas_docket(1234, 2026, "CV") == "CP-39-CV-0001234-2026"
    assert registries.federal_docket(123, 2026) == "5:26-cr-00123"
