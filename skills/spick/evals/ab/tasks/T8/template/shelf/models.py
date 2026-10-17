from dataclasses import dataclass


@dataclass
class Item:
    name: str
    qty: int
    price: float

    def value(self):
        return self.qty * self.price
