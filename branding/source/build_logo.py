"""Regenerate every PaperForge logo SVG from the geometry in this folder.

Run: python branding/source/build_logo.py
Output: branding/logo/ and branding/icons/source/. Needs Python 3 only.
"""
from pathlib import Path

from weld_geometry import d, page_path, sheet_paths
from wordmark import CAP, DESC, wordmark

ROOT = Path(__file__).resolve().parent.parent
INK, PAPER, EMBER, EMBER_DEEP = "#15181C", "#F5F2EC", "#E39A4D", "#B35F14"

# Sheet geometry. All three share the same outer size except SMALL, which snaps to a 16 px grid.
REGULAR = dict(t=44, seam=12, hole_w=104, hole_h=136)
REVERSED = dict(t=42, seam=14, hole_w=108, hole_h=140)  # thinned: light marks on dark look heavier
SMALL = dict(t=48, seam=16, hole_w=96, hole_h=128)
U24 = 256 / 24  # one pixel of a 24 px render
TASKBAR = dict(t=4 * U24, seam=U24, hole_w=10 * U24, hole_h=14 * U24)  # Windows 11 taskbar size at 100 % scale


def symbol_shapes(geo, sheet_colour, page_colour=None, ear=20, scale=1.0, dx=0.0, dy=0.0):
    """Return <path> markup for the symbol. page_colour=None gives the hollow one-colour form."""
    move = lambda pts: [(x * scale + dx, y * scale + dy) for x, y in pts]
    p1, p2 = sheet_paths(**geo)
    shapes = [f'<path fill="{sheet_colour}" d="{d(move(p1))} {d(move(p2))}"/>']
    if page_colour:
        page = page_path(seam=geo["seam"], hole_w=geo["hole_w"], hole_h=geo["hole_h"], ear=ear)
        shapes.append(f'<path fill="{page_colour}" d="{d(move(page))}"/>')
    return shapes


def write_svg(rel, title, w, h, shapes):
    path = ROOT / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    body = "\n".join("  " + s for s in shapes)
    path.write_text(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:g} {h:g}" width="{w:g}" height="{h:g}" '
        f'role="img" aria-labelledby="title">\n  <title id="title">{title}</title>\n{body}\n</svg>\n',
        encoding="utf-8",
    )


def word_shape(x, baseline, scale, colour):
    data, width = wordmark(x, baseline, scale)
    return f'<path fill="{colour}" fill-rule="evenodd" d="{data}"/>', width


# Each style: suffix, sheet geometry, sheet colour, page colour, wordmark colour.
STYLES = [
    ("color", REGULAR, INK, EMBER, INK),
    ("on-dark", REVERSED, PAPER, EMBER, PAPER),
    ("black", REGULAR, "#000000", None, "#000000"),
    ("white", REVERSED, "#FFFFFF", None, "#FFFFFF"),
    ("ember", REGULAR, EMBER_DEEP, None, EMBER_DEEP),
]


def build_symbols():
    for suffix, geo, sheet, page, _ in STYLES:
        write_svg(f"logo/symbol/paperforge-symbol-{suffix}.svg", "PaperForge symbol", 256, 256,
                  symbol_shapes(geo, sheet, page))
    for suffix, sheet, page in [("color", INK, EMBER), ("on-dark", PAPER, EMBER),
                                ("black", "#000000", None), ("white", "#FFFFFF", None)]:
        write_svg(f"logo/symbol-small/paperforge-symbol-small-{suffix}.svg",
                  "PaperForge symbol, small-size cut", 256, 256, symbol_shapes(SMALL, sheet, page, ear=16))


def build_lockups():
    # Measure once. Symbol is 192 x 224 inside its 256 canvas (32 side bearing, 16 top and bottom).
    _, unit_width = wordmark(0, 0, 1)
    pad = 16

    # Horizontal: cap height = 4/7 of symbol height, word centred on the symbol by cap height.
    f = 128 / CAP
    word_x = pad + 192 + 48
    width = word_x + unit_width * f + pad
    baseline = 128 + 64
    for suffix, geo, sheet, page, ink in STYLES:
        word, _ = word_shape(word_x, baseline, f, ink)
        write_svg(f"logo/horizontal/paperforge-horizontal-{suffix}.svg", "PaperForge logo", round(width), 256,
                  symbol_shapes(geo, sheet, page, dx=pad - 32) + [word])

    # Stacked: word is 2.5 times the symbol's width, gap = one band.
    wf = 192 * 2.5 / unit_width
    sw = unit_width * wf + 2 * pad
    gap = 44
    base = pad + 224 + gap + CAP * wf
    sh = base - DESC * wf + pad
    for suffix, geo, sheet, page, ink in STYLES:
        word, _ = word_shape(pad, base, wf, ink)
        write_svg(f"logo/stacked/paperforge-stacked-{suffix}.svg", "PaperForge logo", round(sw), round(sh),
                  symbol_shapes(geo, sheet, page, dx=sw / 2 - 128) + [word])

    # Wordmark only.
    wf = 1.0
    w = unit_width + 2 * pad
    h = CAP - DESC + 2 * pad
    for suffix, _, _, _, ink in STYLES:
        word, _ = word_shape(pad, pad + CAP, wf, ink)
        write_svg(f"logo/wordmark/paperforge-wordmark-{suffix}.svg", "PaperForge wordmark", round(w), round(h), [word])


def tile(size_r=56, colour=INK):
    return f'<rect width="256" height="256" rx="{size_r}" fill="{colour}"/>'


def build_icons():
    # Full drawing on a tile, for 40 px and up. The symbol fills 72 % of the tile.
    s = 0.72
    off = 128 * (1 - s)
    write_svg("icons/source/app-icon.svg", "PaperForge app icon", 256, 256,
              [tile()] + symbol_shapes(REVERSED, PAPER, EMBER, scale=s, dx=off, dy=off))
    # Small-size cut on a tile, for 32 px and below. Drawn at full scale so edges land on the 16 px grid.
    write_svg("icons/source/app-icon-small.svg", "PaperForge app icon, small-size cut", 256, 256,
              [tile(40)] + symbol_shapes(SMALL, PAPER, EMBER, ear=16))
    write_svg("icons/source/app-icon-24.svg", "PaperForge app icon, drawn for 24 px", 256, 256,
              [tile(40)] + symbol_shapes(TASKBAR, PAPER, EMBER, ear=U24 * 2))
    # Maskable: the symbol stays inside the central safe zone and the tile is full-bleed.
    s = 0.6
    off = 128 * (1 - s)
    write_svg("icons/source/app-icon-maskable.svg", "PaperForge maskable icon", 256, 256,
              [f'<rect width="256" height="256" fill="{INK}"/>'] + symbol_shapes(REVERSED, PAPER, EMBER, scale=s, dx=off, dy=off))


if __name__ == "__main__":
    build_symbols()
    build_lockups()
    build_icons()
    print("wrote", sum(1 for _ in ROOT.glob("logo/**/*.svg")) + sum(1 for _ in ROOT.glob("icons/source/*.svg")), "SVG files")
