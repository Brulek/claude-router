from textwrap2.wrap import wrap, display_width

def test_combining_marks_take_no_cell():
    assert display_width("é") == 1
    assert wrap("café au lait", 7) == ["café au", "lait"]

def test_fullwidth_latin_is_wide():
    assert display_width("Ａｂ") == 4
    assert wrap("Ａｂ cd", 4) == ["Ａｂ", "cd"]

def test_mixed_break_inside_wide_word():
    assert wrap("ab一二三", 5) == ["ab一", "二三"]

def test_ascii_unchanged():
    assert wrap("a bb ccc", 3) == ["a", "bb", "ccc"]
