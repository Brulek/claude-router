import pytest

from shelf.models import Item
from shelf.report import format_item, format_report
from shelf.store import Store


def test_value():
    assert Item("pen", 3, 1.5).value() == 4.5


def test_duplicate_rejected():
    s = Store()
    s.add_item("pen", 1, 1.0)
    with pytest.raises(ValueError):
        s.add_item("pen", 2, 1.0)


def test_report_without_tags():
    s = Store()
    s.add_item("pen", 3, 1.5)
    s.add_item("ink", 1, 10)
    assert format_report(s) == "ink: 1 x 10.00\npen: 3 x 1.50\ntotal: 14.50"


def test_tags_stored_and_reported():
    s = Store()
    s.add_item("pen", 3, 1.5, tags=["office", "blue"])
    assert s.all_items()[0].tags == ["office", "blue"]
    assert format_item(s.all_items()[0]) == "pen: 3 x 1.50 [blue,office]"


def test_items_with_tag():
    s = Store()
    s.add_item("pen", 3, 1.5, tags=["office"])
    s.add_item("desk", 1, 99, tags=["office", "wood"])
    s.add_item("ink", 1, 10)
    assert [i.name for i in s.items_with_tag("office")] == ["desk", "pen"]
