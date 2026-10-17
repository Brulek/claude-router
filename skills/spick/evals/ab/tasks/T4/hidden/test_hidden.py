import random
from collections import OrderedDict
from lru import LRU

def test_hidden_random_vs_reference():
    rnd = random.Random(7)
    for cap in (1, 2, 3, 5):
        c = LRU(cap)
        ref = OrderedDict()
        for _ in range(3000):
            k = rnd.randint(0, 9)
            if rnd.random() < 0.5:
                v = rnd.randint(0, 99)
                c.put(k, v)
                if k in ref:
                    ref[k] = v
                    ref.move_to_end(k)
                else:
                    if len(ref) >= cap:
                        ref.popitem(last=False)
                    ref[k] = v
            else:
                got = c.get(k)
                exp = None
                if k in ref:
                    exp = ref[k]
                    ref.move_to_end(k)
                assert got == exp
