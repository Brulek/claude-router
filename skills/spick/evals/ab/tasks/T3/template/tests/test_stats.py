import pytest
from textstat.stats import median, mean

def test_median_odd():
    assert median([5, 1, 3]) == 3

def test_median_even():
    assert median([1, 2, 3, 4]) == 2.5

def test_median_empty():
    with pytest.raises(ValueError):
        median([])

def test_mean():
    assert mean([1, 2, 3]) == 2
