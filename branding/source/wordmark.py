"""Custom-drawn "PaperForge" lettering as exact outlines (no font involved).

Font units are y-up with the baseline at 0: x-height 100, cap height 140, descender -50.
Each letter is one set of non-overlapping contours, so it renders correctly with fill-rule="evenodd".
"""
from math import sqrt

XH, CAP, DESC = 100, 140, -50
STEM, CAP_STEM = 22, 24
R, RI_X, RI_Y = 52, 30, 31           # bowl: outer circle, inner ellipse (horizontals slightly thinner)
CX, CY = 52, 50                      # bowl centre
JOIN = sqrt(R**2 - (CX - STEM) ** 2)  # where the outer circle crosses a stem edge


class Pen:
    """Writes SVG path data, mapping font units to output coordinates."""

    def __init__(self, ox, baseline, scale):
        self.ox, self.base, self.s, self.out = ox, baseline, scale, []

    def _p(self, x, y):
        return f"{round(self.ox + x * self.s, 2):g} {round(self.base - y * self.s, 2):g}"

    def M(self, x, y):
        self.out.append("M" + self._p(x, y))
        return self

    def L(self, x, y):
        self.out.append("L" + self._p(x, y))
        return self

    def A(self, rx, ry, large, sweep, x, y):
        self.out.append(
            f"A{round(rx * self.s, 2):g} {round(ry * self.s, 2):g} 0 {large} {sweep} " + self._p(x, y)
        )
        return self

    def Z(self):
        self.out.append("Z")
        return self


def _bowl_hole(p):
    p.M(CX, CY + RI_Y).A(RI_X, RI_Y, 1, 0, CX, CY - RI_Y).A(RI_X, RI_Y, 1, 0, CX, CY + RI_Y).Z()


def letter_o(p):
    p.M(CX, CY + R).A(R, R, 1, 1, CX, CY - R).A(R, R, 1, 1, CX, CY + R).Z()
    _bowl_hole(p)
    return 104


def letter_a(p):
    x = 2 * CX - STEM
    p.M(104, XH).L(104, 0).L(x, 0).L(x, CY - JOIN).A(R, R, 1, 1, x, CY + JOIN).L(x, XH).Z()
    _bowl_hole(p)
    return 104


def letter_p(p):
    p.M(0, XH).L(STEM, XH).L(STEM, CY + JOIN).A(R, R, 1, 1, STEM, CY - JOIN).L(STEM, DESC).L(0, DESC).Z()
    _bowl_hole(p)
    return 104


def letter_g(p):
    x = 2 * CX - STEM
    tail_cx, tail_cy, tail_r, tail_ri = 60, -6, 44, 22
    tip = 12
    p.M(104, XH).L(104, tail_cy).A(tail_r, tail_r, 0, 1, tail_cx, tail_cy - tail_r)
    p.L(tip + STEM, tail_cy - tail_r).L(tip, tail_cy - tail_ri).L(tail_cx, tail_cy - tail_ri)
    p.A(tail_ri, tail_ri, 0, 0, x, tail_cy).L(x, CY - JOIN).A(R, R, 1, 1, x, CY + JOIN).L(x, XH).Z()
    _bowl_hole(p)
    return 104


def letter_e(p):
    bar_top, bar_bot = 58, 40
    c = 89.2  # terminal cut lies on x + y = c, the same 45-degree direction as the symbol's cuts
    # outer circle / cut intersection, lower right
    a, b = CX, CY
    q = c - a - b
    disc = sqrt(2 * R**2 - q**2)
    ox_ = a + (q + disc) / 2
    oy_ = c - ox_
    # inner ellipse / cut intersection (solve parametrically)
    A_ = RI_Y**2 + RI_X**2
    B_ = -2 * q * RI_X**2
    C_ = RI_X**2 * q**2 - (RI_X * RI_Y) ** 2
    dx = (-B_ + sqrt(B_**2 - 4 * A_ * C_)) / (2 * A_)
    ix_, iy_ = a + dx, c - (a + dx)
    xb = CX + sqrt(R**2 - (CY - bar_bot) ** 2)
    xi_bot = CX - RI_X * sqrt(1 - ((CY - bar_bot) / RI_Y) ** 2)
    p.M(ox_, oy_).A(R, R, 1, 1, xb, bar_bot).L(xi_bot, bar_bot)
    p.A(RI_X, RI_Y, 0, 0, ix_, iy_).Z()
    half = RI_X * sqrt(1 - ((bar_top - CY) / RI_Y) ** 2)
    p.M(CX - half, bar_top).A(RI_X, RI_Y, 0, 1, CX + half, bar_top).Z()
    return 104


def letter_r(p):
    end = 66
    y_o = CY + sqrt(R**2 - (end - CX) ** 2)
    y_i = CY + RI_Y * sqrt(1 - ((end - CX) / RI_X) ** 2)
    p.M(0, 0).L(0, XH).L(STEM, XH).L(STEM, CY + JOIN).A(R, R, 0, 1, end, y_o).L(end, y_i)
    p.A(RI_X, RI_Y, 0, 0, STEM, CY).L(STEM, 0).Z()
    return end


def letter_P(p):
    x1, r, ri = 46, 42, 21
    top, bot = CAP, CAP - 2 * r
    p.M(0, 0).L(0, top).L(x1, top).A(r, r, 0, 1, x1, bot).L(CAP_STEM, bot).L(CAP_STEM, 0).Z()
    p.M(CAP_STEM, top - ri).L(x1, top - ri).A(ri, ri, 0, 1, x1, bot + ri).L(CAP_STEM, bot + ri).Z()
    return x1 + r


def letter_F(p):
    arm, top_end, mid_end = 20, 72, 56
    mid_top = 78
    p.M(0, 0).L(0, CAP).L(top_end, CAP).L(top_end + arm, CAP - arm).L(CAP_STEM, CAP - arm)
    p.L(CAP_STEM, mid_top).L(mid_end, mid_top).L(mid_end + arm, mid_top - arm).L(CAP_STEM, mid_top - arm)
    p.L(CAP_STEM, 0).Z()
    return top_end + arm


# (letter function, gap to the next letter): optical spacing, set by eye against renders.
LETTERS = [
    (letter_P, 9), (letter_a, 17), (letter_p, 7), (letter_e, 12), (letter_r, 13),
    (letter_F, -8), (letter_o, 12), (letter_r, 7), (letter_g, 12), (letter_e, 0),
]


def wordmark(x, baseline, scale):
    """Return (path data, width in output units) for the word, starting at x on the given baseline."""
    parts, cursor = [], 0.0
    for fn, gap in LETTERS:
        pen = Pen(x + cursor * scale, baseline, scale)
        cursor += fn(pen) + gap
        parts.append(" ".join(pen.out))
    return " ".join(parts), cursor * scale
