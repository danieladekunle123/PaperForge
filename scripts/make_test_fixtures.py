"""Writes synthetic documents with visible page labels, for end-to-end tests and screenshots.

Usage: python scripts/make_test_fixtures.py <output folder>
"""

import random
import sys
from pathlib import Path

import pymupdf
from PIL import Image, ImageDraw

INK = (0.13, 0.15, 0.19)
ACCENT = (0.76, 0.42, 0.13)
MUTED = (0.42, 0.45, 0.5)
BODY = (
    "Paper is forgiving. It takes every correction and keeps the shape of the argument, "
    "which is why long reports still start as piles of pages on a desk."
)


def report_page(doc, index, total, label, title, size=(595, 842)):
    doc.new_page(width=size[0], height=size[1])
    page = doc[index]
    page.draw_rect(pymupdf.Rect(0, 0, size[0], 8), fill=ACCENT, color=None)
    page.insert_text((56, 72), f"{label}-P{index + 1}", fontsize=22, color=INK, fontname="hebo")
    page.insert_text((56, 94), title, fontsize=12, color=MUTED)
    y = 126.0
    for paragraph in range(5):
        rect = pymupdf.Rect(56, y, size[0] - 56, y + 78)
        page.insert_textbox(rect, BODY + " " + BODY, fontsize=10.5, color=INK, lineheight=1.45)
        y += 92
    page.draw_rect(pymupdf.Rect(56, y + 6, size[0] - 56, y + 136), color=(0.8, 0.82, 0.85), fill=(0.96, 0.96, 0.95))
    x = 80.0
    rng = random.Random(index * 7 + len(label))
    for _ in range(9):
        height = rng.randint(18, 110)
        page.draw_rect(pymupdf.Rect(x, y + 130 - height, x + 30, y + 130), fill=ACCENT, color=None)
        x += 48
    page.insert_text((56, size[1] - 40), f"{title} · page {index + 1} of {total}", fontsize=9, color=MUTED)


def make_report(path, label, title, pages, size=(595, 842)):
    doc = pymupdf.open()
    for index in range(pages):
        report_page(doc, index, pages, label, title, size)
    doc.set_metadata({"title": title, "author": "PaperForge fixtures", "subject": "Synthetic test document"})
    doc.set_toc([[1, f"{title} start", 1], [2, "Details", min(2, pages)]])
    doc.save(path, garbage=3, deflate=True)
    doc.close()


def make_photo(path, size, hue):
    image = Image.new("RGB", size)
    draw = ImageDraw.Draw(image)
    width, height = size
    for y in range(height):
        t = y / height
        draw.line([(0, y), (width, y)], fill=(int(hue[0] * (1 - t) + 30 * t), int(hue[1] * (1 - t) + 40 * t), int(hue[2] * (1 - t) + 70 * t)))
    draw.ellipse([width * 0.62, height * 0.12, width * 0.82, height * 0.12 + width * 0.2], fill=(250, 226, 170))
    points = [(0, height), (width * 0.3, height * 0.55), (width * 0.55, height * 0.8), (width * 0.8, height * 0.48), (width, height * 0.72), (width, height)]
    draw.polygon(points, fill=(32, 44, 58))
    image.save(path, quality=88)


def make_noisy_scan(path):
    """An image-heavy PDF, so compression has something real to work on."""
    rng = random.Random(3)
    image = Image.effect_noise((1700, 2200), 30).convert("RGB")
    draw = ImageDraw.Draw(image)
    for _ in range(90):
        y = rng.randint(100, 2100)
        draw.line([(140, y), (rng.randint(600, 1560), y)], fill=(20, 20, 20), width=5)
    temp = Path(path).with_suffix(".png")
    image.save(temp)
    doc = pymupdf.open()
    doc.new_page(width=612, height=792)
    doc[0].insert_image(doc[0].rect, filename=str(temp))
    doc[0].insert_text((30, 24), "SCAN-P1", fontsize=10)
    doc.save(path, deflate=True)
    doc.close()
    temp.unlink()


def main():
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    make_report(out / "Annual report 2025.pdf", "REPORT", "Annual report 2025", 12)
    make_report(out / "Études résumé 文档.pdf", "BRIEF", "Project brief", 8, size=(612, 792))
    make_photo(out / "harbour photo.jpg", (1600, 1067), (222, 142, 92))
    make_photo(out / "ridge line.jpg", (1000, 1400), (112, 152, 196))
    Image.new("RGBA", (800, 400), (40, 90, 200, 255)).save(out / "blue banner.png")
    make_noisy_scan(out / "scanned contract.pdf")

    mixed = pymupdf.open()
    for index, (size, rotation) in enumerate([((595, 842), 0), ((842, 595), 0), ((300, 500), 90), ((612, 792), 270)]):
        mixed.new_page(width=size[0], height=size[1])
        mixed[index].insert_text((40, 60), f"MIXED-P{index + 1}", fontsize=18, color=INK)
        mixed[index].set_rotation(rotation)
    mixed.save(out / "mixed sizes.pdf")
    mixed.close()

    source = pymupdf.open(out / "Annual report 2025.pdf")
    source.save(out / "locked.pdf", encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="open-sesame", owner_pw="owner-pass", permissions=pymupdf.PDF_PERM_PRINT)
    source.save(out / "locked same password.pdf", encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="same-pass", owner_pw="same-pass")
    source.close()

    # Marked as digitally signed, so the UI's signature warning can be exercised.
    signed = pymupdf.open()
    signed.new_page()
    signed[0].insert_text((72, 72), "SIGNED-P1", fontsize=18)
    widget = pymupdf.Widget()
    widget.field_name = "note"
    widget.field_type = pymupdf.PDF_WIDGET_TYPE_TEXT
    widget.rect = pymupdf.Rect(72, 100, 300, 130)
    signed[0].add_widget(widget)
    signed.xref_set_key(signed.pdf_catalog(), "AcroForm/SigFlags", "3")
    signed.save(out / "signed contract.pdf")
    signed.close()

    (out / "corrupt.pdf").write_bytes(b"%PDF-1.7\nthis is not really a pdf\n")
    (out / "notes.txt").write_text("Plain text is not importable.", encoding="utf-8")


if __name__ == "__main__":
    main()
