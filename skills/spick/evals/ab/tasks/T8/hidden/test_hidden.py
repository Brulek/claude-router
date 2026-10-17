from shelf.models import Item
from shelf.report import format_item, format_report
from shelf.store import Store


def test_default_tags_not_shared():
    a = Item("a", 1, 1.0)
    b = Item("b", 1, 1.0)
    a.tags.append("x")
    assert b.tags == []


def test_add_item_copies_the_list():
    s = Store()
    src = ["b", "a"]
    item = s.add_item("pen", 1, 1.0, tags=src)
    src.append("c")
    assert item.tags == ["b", "a"]


def test_add_item_tags_none_and_positional_still_work():
    s = Store()
    item = s.add_item("pen", 2, 3.0, None)
    assert item.tags == []
    assert s.add_item("ink", 1, 1.0).tags == []


def test_unknown_tag_gives_empty_list():
    s = Store()
    s.add_item("pen", 1, 1.0, tags=["office"])
    assert s.items_with_tag("nope") == []
    assert s.items_with_tag("Office") == []


def test_tag_match_is_exact_not_substring():
    s = Store()
    s.add_item("pen", 1, 1.0, tags=["office"])
    s.add_item("mug", 1, 1.0, tags=["off"])
    assert [i.name for i in s.items_with_tag("off")] == ["mug"]


def test_report_lines_with_and_without_tags():
    s = Store()
    s.add_item("pen", 3, 1.5, tags=["z", "a"])
    s.add_item("ink", 1, 10)
    assert format_report(s) == "ink: 1 x 10.00\npen: 3 x 1.50 [a,z]\ntotal: 14.50"


def test_format_item_with_empty_tags_has_no_brackets():
    assert format_item(Item("ink", 1, 10, tags=[])) == "ink: 1 x 10.00"


def test_item_still_positional_three_args():
    item = Item("pen", 3, 1.5)
    assert item.value() == 4.5
