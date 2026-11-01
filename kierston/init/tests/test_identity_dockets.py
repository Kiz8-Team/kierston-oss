import dockets
import identity
from registries import keyed


def test_survey_shift_moves_reported_years_to_the_reference_year():
    assert identity.survey_shift("2019HU0000001") == identity.registries.REFERENCE_YEAR - 2019
    assert identity.survey_shift(2023000123) == identity.registries.REFERENCE_YEAR - 2023


def test_birth_dates_match_the_age_and_quarter():
    year, month, day = identity.TODAY
    rng = keyed(3, "birth")
    for age in (0, 17, 45, 90):
        for quarter in (1, 2, 3, 4):
            born = identity.birth_date(age, quarter, rng)
            born_year, born_month, born_day = (int(part) for part in born.split("-"))
            assert (quarter - 1) * 3 < born_month <= quarter * 3
            had_birthday = (born_month, born_day) <= (month, day)
            assert year - born_year - (0 if had_birthday else 1) == age
            assert identity.year_of(born) == born_year


def test_docket_dates_roll_over_on_thirty_day_months():
    assert dockets.add_days("2020-12-25", 10) == "2021-01-05"
    assert dockets.add_days("2021-03-01", 0) == "2021-03-01"
    # add_days is plain arithmetic; a date past the snapshot is the caller's
    # to cap or to treat as pending.
    assert dockets.in_future(dockets.add_days(dockets.TODAY_ISO, 1))
    assert dockets.not_after_today("9999-01-01") == dockets.TODAY_ISO


def test_docket_dates_in_the_current_year_stay_before_the_reference_date():
    rng = keyed(5, "dates")
    for _ in range(200):
        date = dockets.date_in(dockets.TODAY, rng)
        assert date <= dockets.TODAY_ISO
        assert 1 <= int(date[8:10]) <= 28


def test_series_of_splits_each_docket_format():
    assert dockets.formats.series_of("MJ-31201-CR-0000123-2026") == (("MJ", "31201", "CR", None, "2026"), 123, 7)
    assert dockets.formats.series_of("CP-39-CR-0001234-2026") == (("CP", "39", "CR", None, "2026"), 1234, 7)
    assert dockets.formats.series_of("5:26-cr-00123") == (("5:26", "cr", None), 123, 5)
