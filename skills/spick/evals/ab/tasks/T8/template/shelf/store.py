from .models import Item


class Store:
    def __init__(self):
        self._items = {}

    def add_item(self, name, qty, price):
        if name in self._items:
            raise ValueError(f"duplicate item: {name}")
        item = Item(name, qty, price)
        self._items[name] = item
        return item

    def all_items(self):
        return sorted(self._items.values(), key=lambda i: i.name)

    def total_value(self):
        return sum(i.value() for i in self._items.values())
