def median(xs):
    if not xs:
        raise ValueError("empty")
    s = sorted(xs)
    return s[len(s) // 2]


def mean(xs):
    if not xs:
        raise ValueError("empty")
    return sum(xs) / len(xs)
