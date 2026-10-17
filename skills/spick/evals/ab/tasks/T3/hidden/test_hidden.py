from textstat.stats import median

def test_hidden_even_six():
    assert median([7, 1, 2, 8, 3, 9]) == 5

def test_hidden_two():
    assert median([1, 2]) == 1.5

def test_hidden_negative():
    assert median([-3, -1]) == -2
