"""Parametric geometry for the PaperForge "Weld" symbol. All coordinates are on a 256 x 256 canvas."""

def sheet_paths(t=44, seam=12, hole_w=104, hole_h=136, cx=128, cy=128):
    """Return the two interlocked sheets. The pair has exact 180-degree rotational symmetry about (cx, cy)."""
    x0 = cx - hole_w / 2 - t
    y0 = cy - hole_h / 2 - t
    hx0, hy0 = x0 + t, y0 + t
    hx1, hy1 = hx0 + hole_w, hy0 + hole_h
    x1 = hx1 + t
    y1 = hy1 + t
    # The second sheet's arm is cut along y = x + c through its inner corner; the first sheet's arm is cut
    # parallel to it, offset so the perpendicular width of the slit equals the seam.
    offset = seam * 2 ** 0.5
    tip_at_inner = hx1 - offset          # x where sheet 1's cut meets the hole's top edge
    tip_at_outer = tip_at_inner - t      # x where sheet 1's cut meets the outer top edge
    p1 = [(x0, y0), (tip_at_outer, y0), (tip_at_inner, hy0), (hx0, hy0), (hx0, hy1), (x0, hy1 - t)]
    rot = lambda p: (2 * cx - p[0], 2 * cy - p[1])
    p2 = [rot(p) for p in p1]
    return p1, p2


def page_path(seam=12, hole_w=104, hole_h=136, ear=20, cx=128, cy=128):
    """Return the weld page, inset from the hole by one seam, with a 45-degree dog-ear at top right."""
    x0, x1 = cx - hole_w / 2 + seam, cx + hole_w / 2 - seam
    y0, y1 = cy - hole_h / 2 + seam, cy + hole_h / 2 - seam
    if ear:
        return [(x0, y0), (x1 - ear, y0), (x1, y0 + ear), (x1, y1), (x0, y1)]
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def fmt(v):
    return f"{round(v, 2):g}"


def d(points):
    return "M" + " L".join(f"{fmt(x)} {fmt(y)}" for x, y in points) + " Z"
