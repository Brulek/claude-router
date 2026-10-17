from lru import LRU

def test_put_existing_refreshes_recency():
    c = LRU(2)
    c.put('a', 1); c.put('b', 2); c.put('a', 10); c.put('c', 3)
    assert c.get('b') is None
    assert c.get('a') == 10
    assert c.get('c') == 3

def test_get_refreshes_recency():
    c = LRU(2)
    c.put('a', 1); c.put('b', 2); c.get('a'); c.put('c', 3)
    assert c.get('b') is None
    assert c.get('a') == 1
