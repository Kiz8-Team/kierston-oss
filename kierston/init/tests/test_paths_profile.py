import importlib
import os

import pytest

import paths
import profile as city_profile


def test_roots_hang_off_the_kierston_directory():
    assert paths.KIERSTON.name == "kierston"
    if "KIERSTON_SIM_DATA_DIR" not in os.environ:
        assert paths.SIM_DATA == paths.KIERSTON / "sim_data"
    assert paths.SIM_OUTPUTS == paths.KIERSTON / "sim_outputs"
    assert paths.PROFILE == paths.CITIES / f"{paths.CITY}.toml"
    assert paths.PUMS == paths.SOURCES / "pums.json"


def test_city_is_chosen_by_environment(monkeypatch):
    monkeypatch.setenv("KIERSTON_CITY", "elsewhere")
    try:
        reloaded = importlib.reload(paths)
        assert reloaded.CITY == "elsewhere"
        assert reloaded.SOURCES == reloaded.KIERSTON / "sources" / "elsewhere"
        assert reloaded.PROFILE.name == "elsewhere.toml"
        assert reloaded.CAMERAS == reloaded.CITIES / "elsewhere" / "cameras.json"
    finally:
        monkeypatch.undo()
        importlib.reload(paths)
    assert paths.CITY == os.environ.get("KIERSTON_CITY", "kierston")


def test_jurisdiction_assets_resolve_under_their_bundle():
    assert paths.jurisdiction("us-pa", "offense_list.csv") == paths.JURISDICTIONS / "us-pa" / "offense_list.csv"


def test_require_names_the_missing_file_and_the_fix(tmp_path):
    present = tmp_path / "here.json"
    present.write_text("{}")
    assert paths.require(present, "unused") == present
    with pytest.raises(SystemExit) as raised:
        paths.require(tmp_path / "absent.json", "run the intake stage")
    assert "absent.json" in str(raised.value)
    assert "run the intake stage" in str(raised.value)


@pytest.mark.skipif(os.environ.get("KIERSTON_CITY", "kierston") != "kierston", reason="checks the shipped profile")
def test_kierston_profile_loads():
    loaded = city_profile.load()
    assert loaded.name == "Kierston"
    assert loaded.slug == "kierston"
    assert loaded.extent.center == (40.602989, -75.472188)
    assert loaded.extent.radius_m == 5000
    assert loaded.microdata.dataset == "acs5"
    assert loaded.microdata.puma == ("02803",)
    assert loaded.jurisdiction == "us-pa"
    assert loaded.housing.min_sample > 0


def test_sim_data_follows_the_override(monkeypatch, tmp_path):
    monkeypatch.setenv("KIERSTON_SIM_DATA_DIR", str(tmp_path / "scratch"))
    try:
        reloaded = importlib.reload(paths)
        assert reloaded.SIM_DATA == (tmp_path / "scratch").resolve()
        assert reloaded.POIS == reloaded.SIM_DATA / "pois.json"
        assert reloaded.PLATE_RULES == reloaded.SIM_DATA / "plate_rules.json"
    finally:
        monkeypatch.undo()
        importlib.reload(paths)


@pytest.mark.skipif(os.environ.get("KIERSTON_CITY", "kierston") != "kierston", reason="checks the shipped profile")
def test_kierston_locale_loads():
    import datetime
    locale = city_profile.load().locale
    assert locale.time_zone == "America/New_York"
    assert locale.reference_date == datetime.date(2026, 7, 1)
    assert locale.area_codes == ("610", "484", "835")
    assert locale.area_code_eras[0] == (1999, (1.0, 0.0, 0.0))
    assert all(len(shares) == len(locale.area_codes) for _, shares in locale.area_code_eras)


@pytest.mark.skipif(os.environ.get("KIERSTON_CITY", "kierston") != "kierston", reason="checks the shipped profile")
def test_jurisdiction_and_city_lists_load():
    import city_data
    import jurisdiction
    law = jurisdiction.load()
    assert law.state.pobp == "042"
    assert law.citation("18", "6109") == "18 Pa.C.S. § 6109"
    assert law.plates.front is False
    assert abs(sum(v.share for v in law.plates.visitors) - 1) < 1e-9
    landline, wireless = city_data.exchanges(city_profile.load().locale.area_codes)
    assert landline["835"] == ("200", "201", "202", "203")
    assert len(wireless["484"]) == 36
    assert city_data.banks()[0] == ("Wells Fargo Bank, N.A.", "031", 150)
    assert city_data.magisterial_districts()[0] == ("31-2-01", 0.20)
    assert city_data.number("12") == 12 and isinstance(city_data.number("12"), int)
    assert city_data.number("62.0") == 62.0 and city_data.number("") is None
