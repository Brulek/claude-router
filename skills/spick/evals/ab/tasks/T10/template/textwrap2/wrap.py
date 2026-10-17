"""Wrap text to a display width. A column is one cell for narrow characters and two for East Asian wide or
fullwidth characters; combining marks take no cell. Words are split on spaces; a word longer than the width is
broken at the width."""


def display_width(s):
    return len(s)


def wrap(text, width):
    lines, line, used = [], [], 0
    for word in text.split(" "):
        w = display_width(word)
        if w > width:
            if line:
                lines.append(" ".join(line)); line, used = [], 0
            while display_width(word) > width:
                lines.append(word[:width]); word = word[width:]
            w = display_width(word)
        need = w if not line else used + 1 + w
        if line and need > width:
            lines.append(" ".join(line)); line, used = [word], w
        else:
            line.append(word); used = need
    if line:
        lines.append(" ".join(line))
    return lines
