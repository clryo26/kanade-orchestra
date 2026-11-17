import pytest

from src.backend.services.timetable_payload_helpers import duration_minutes_between


@pytest.mark.parametrize('clock', ['00:00', '10:00', '9:05', '23:59'])
def test_same_start_and_end_returns_zero(clock):
    assert duration_minutes_between(clock, clock) == 0


@pytest.mark.parametrize(
    ('start', 'end', 'expected'),
    [
        ('10:00', '11:30', 90),
        ('09:00', '09:01', 1),
        ('00:00', '12:00', 720),
    ],
)
def test_ordinary_difference_within_one_day(start, end, expected):
    assert duration_minutes_between(start, end) == expected


@pytest.mark.parametrize(
    ('start', 'end', 'expected'),
    [
        ('9:05', '10:00', 55),
        ('9:05', '9:05', 0),
        ('8:30', '9:45', 75),
        ('10:00', '9:05', 1385),
    ],
)
def test_one_digit_hour_is_accepted(start, end, expected):
    assert duration_minutes_between(start, end) == expected


@pytest.mark.parametrize(
    ('start', 'end', 'expected'),
    [
        ('23:30', '00:15', 45),
        ('11:00', '10:00', 1380),
        ('10:01', '10:00', 1439),
    ],
)
def test_end_before_start_is_treated_as_next_day(start, end, expected):
    assert duration_minutes_between(start, end) == expected


def test_midnight_to_last_minute_is_maximum():
    assert duration_minutes_between('00:00', '23:59') == 1439


@pytest.mark.parametrize(
    ('start', 'end'),
    [
        ('xx', '10:00'),
        ('10:00', 'xx'),
        ('xx', 'yy'),
        ('25:00', '10:00'),
        ('10:00', '10:60'),
        ('99:99', '99:99'),
    ],
)
def test_invalid_start_or_end_returns_none(start, end):
    assert duration_minutes_between(start, end) is None


@pytest.mark.parametrize(
    ('start', 'end'),
    [
        ('', '10:00'),
        ('10:00', ''),
        ('', ''),
    ],
)
def test_empty_string_returns_none(start, end):
    assert duration_minutes_between(start, end) is None


@pytest.mark.parametrize(
    ('start', 'end'),
    [
        (None, '10:00'),
        ('10:00', None),
        (None, None),
    ],
)
def test_none_returns_none(start, end):
    assert duration_minutes_between(start, end) is None


@pytest.mark.parametrize(
    ('start', 'end', 'expected'),
    [
        (' 10:00 ', '11:30', 90),
        ('10:00', ' 11:30 ', 90),
        ('  9:05  ', '  9:35  ', 30),
    ],
)
def test_surrounding_whitespace_is_ignored(start, end, expected):
    assert duration_minutes_between(start, end) == expected


@pytest.mark.parametrize(
    ('start', 'end'),
    [
        ('10:00', '10:00'),
        ('10:00', '11:30'),
        ('9:05', '10:00'),
        ('23:30', '00:15'),
        ('11:00', '10:00'),
        ('00:00', '23:59'),
        ('xx', '10:00'),
        ('', ''),
        (None, None),
    ],
)
def test_result_is_none_or_integer_within_one_day(start, end):
    result = duration_minutes_between(start, end)
    assert result is None or (isinstance(result, int) and not isinstance(result, bool) and 0 <= result <= 1439)
