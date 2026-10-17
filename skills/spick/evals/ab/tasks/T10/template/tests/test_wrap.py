from textwrap2.wrap import wrap, display_width

def test_ascii():
    assert wrap("the quick brown fox", 9) == ["the quick", "brown fox"]

def test_wide_chars_count_two_cells():
    assert display_width("中文") == 4
    assert wrap("中文 abc", 5) == ["中文", "abc"]

def test_long_wide_word_is_broken_at_cells():
    assert wrap("一二三四五", 4) == ["一二", "三四", "五"]
