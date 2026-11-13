from src.backend.services.concert_record_video_service import clean_concert_record_title


def test_empty_string_returns_empty_string():
    assert clean_concert_record_title("") == ""


def test_none_returns_empty_string():
    assert clean_concert_record_title(None) == ""


def test_whitespace_only_returns_empty_string():
    assert clean_concert_record_title(" \t\n  ") == ""


def test_plain_title_without_marker_is_preserved():
    assert clean_concert_record_title("Spring Concert") == "Spring Concert"


def test_exact_leading_marker_is_removed():
    assert clean_concert_record_title("【福岡奏オーケストラ】第1回記録") == "第1回記録"


def test_surrounding_whitespace_is_stripped():
    assert clean_concert_record_title("  Summer Concert \t") == "Summer Concert"


def test_whitespace_exposed_after_marker_removal_is_stripped():
    assert clean_concert_record_title("  【福岡奏オーケストラ】   Autumn Concert  ") == "Autumn Concert"


def test_marker_followed_by_space_and_surrounding_whitespace_is_stripped():
    assert clean_concert_record_title("【福岡奏オーケストラ】 第1回記録 ") == "第1回記録"


def test_title_body_letter_case_is_preserved():
    assert clean_concert_record_title("  Spring cONCERT  ") == "Spring cONCERT"
    assert clean_concert_record_title("【福岡奏オーケストラ】 WinTer cOncErt") == "WinTer cOncErt"
