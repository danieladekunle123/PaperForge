"""Synthetic fixtures. Every PDF page carries a visible label so ordering can be checked from text."""

from __future__ import annotations

import io
import os
import random
import sys
from pathlib import Path

import pymupdf
import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from paperforge_worker.job import JobContext  # noqa: E402


def make_labelled(path: Path, label: str, pages: int, size=(595, 842)) -> Path:
    doc = pymupdf.open()
    for i in range(pages):
        doc.new_page(width=size[0], height=size[1])
        doc[i].insert_text((72, 72), f"{label}-P{i + 1}", fontsize=24)
    doc.save(path)
    doc.close()
    return path


def make_png(path: Path, size=(200, 100), color=(40, 90, 200, 255)) -> Path:
    Image.new("RGBA", size, color).save(path, "PNG")
    return path


def make_jpeg(path: Path, size=(300, 200), color=(200, 40, 40), exif_orientation: int | None = None) -> Path:
    image = Image.new("RGB", size, color)
    exif = Image.Exif()
    if exif_orientation:
        exif[0x0112] = exif_orientation
    image.save(path, "JPEG", exif=exif.tobytes(), quality=90)
    return path


def make_noise_image(size=(1200, 1200), alpha_left=False) -> bytes:
    rng = random.Random(7)
    img = Image.effect_noise(size, 80).convert("RGB")
    pixels = img.load()
    for y in range(0, size[1], 4):
        for x in range(0, size[0], 4):
            pixels[x, y] = (rng.randrange(256), rng.randrange(256), rng.randrange(256))
    if alpha_left:
        rgba = img.convert("RGBA")
        rgba.paste((0, 0, 0, 0), (0, 0, size[0] // 2, size[1]))
        img = rgba
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


@pytest.fixture
def ctx():
    return JobContext("testjob")


@pytest.fixture(scope="session")
def fx(tmp_path_factory) -> dict[str, Path]:
    root = tmp_path_factory.mktemp("fixtures")
    files: dict[str, Path] = {}
    files["a"] = make_labelled(root / "doc a.pdf", "A", 5)
    files["b"] = make_labelled(root / "doc-b.pdf", "B", 8, size=(612, 792))
    files["unicode"] = make_labelled(root / "résumé 文档 — final.pdf", "U", 2)
    files["png"] = make_png(root / "picture.png")
    files["jpg"] = make_jpeg(root / "photo.jpg")
    files["jpg_exif"] = make_jpeg(root / "rotated-exif.jpg", size=(300, 200), exif_orientation=6)

    # Mixed page sizes and rotation.
    doc = pymupdf.open()
    specs = [((595, 842), 0), ((842, 595), 0), ((300, 500), 90), ((400, 400), 180), ((612, 792), 270)]
    for i, (size, rotation) in enumerate(specs):
        doc.new_page(width=size[0], height=size[1])
        doc[i].insert_text((40, 60), f"MIX-P{i + 1}", fontsize=18)
        doc[i].set_rotation(rotation)
    files["mixed"] = root / "mixed.pdf"
    doc.save(files["mixed"])
    doc.close()

    # Crop box that differs from the media box.
    doc = pymupdf.open()
    doc.new_page(width=500, height=500)
    doc[0].insert_text((110, 130), "CROP-P1", fontsize=18)
    doc[0].set_cropbox(pymupdf.Rect(100, 100, 400, 300))
    files["crop"] = root / "crop.pdf"
    doc.save(files["crop"])
    doc.close()

    # Text, a live link, an internal link, bookmarks, annotation.
    doc = pymupdf.open()
    for i in range(4):
        doc.new_page(width=595, height=842)
        doc[i].insert_text((72, 72), f"RICH-P{i + 1}", fontsize=18)
    doc[0].insert_link(
        {"kind": pymupdf.LINK_URI, "from": pymupdf.Rect(72, 50, 300, 80), "uri": "https://example.com/doc"}
    )
    doc[0].insert_link(
        {"kind": pymupdf.LINK_GOTO, "from": pymupdf.Rect(72, 100, 300, 130), "page": 2, "to": pymupdf.Point(0, 0)}
    )
    doc[3].insert_link(
        {"kind": pymupdf.LINK_GOTO, "from": pymupdf.Rect(72, 100, 300, 130), "page": 1, "to": pymupdf.Point(0, 0)}
    )
    doc[1].add_text_annot((100, 200), "note")
    doc.set_toc([[1, "Intro", 1], [2, "Details", 2], [1, "Annex", 3], [2, "Annex detail", 4]])
    doc.embfile_add("data.txt", b"attachment payload", filename="data.txt", ufilename="data.txt")
    doc.set_metadata({"title": "Rich Title", "author": "Test Author", "subject": "Subj", "keywords": "k1, k2"})
    files["rich"] = root / "rich.pdf"
    doc.save(files["rich"])
    doc.close()

    # A form with a value.
    doc = pymupdf.open()
    doc.new_page(width=400, height=400)
    widget = pymupdf.Widget()
    widget.field_name = "name"
    widget.field_type = pymupdf.PDF_WIDGET_TYPE_TEXT
    widget.rect = pymupdf.Rect(20, 20, 300, 50)
    widget.field_value = "FORMVALUE"
    doc[0].add_widget(widget)
    files["form"] = root / "form.pdf"
    doc.save(files["form"])
    doc.close()

    # Text page, image-only page.
    doc = pymupdf.open()
    doc.new_page()
    doc[0].insert_text((72, 72), "Héllo wörld Unicode text", fontsize=14)
    doc.new_page()
    doc[1].insert_image(pymupdf.Rect(50, 50, 250, 250), stream=(root / "picture.png").read_bytes())
    doc.new_page()
    files["mixed_text"] = root / "text and image.pdf"
    doc.save(files["mixed_text"])
    doc.close()

    # Heavy image document for compression.
    doc = pymupdf.open()
    doc.new_page(width=400, height=400)
    doc[0].insert_text((20, 30), "HEAVY text remains selectable", fontsize=12)
    doc[0].insert_image(pymupdf.Rect(0, 50, 350, 400), stream=make_noise_image())
    files["heavy"] = root / "heavy.pdf"
    doc.save(files["heavy"], deflate=True)
    doc.close()

    # Heavy image with alpha over a red background: transparency must survive recompression.
    doc = pymupdf.open()
    doc.new_page(width=400, height=400)
    doc[0].draw_rect(doc[0].rect, fill=(1, 0, 0), color=None)
    doc[0].insert_image(pymupdf.Rect(0, 0, 400, 400), stream=make_noise_image((1000, 1000), alpha_left=True))
    files["alpha"] = root / "alpha.pdf"
    doc.save(files["alpha"], deflate=True)
    doc.close()

    # Already compact: text only.
    doc = pymupdf.open()
    doc.new_page(width=200, height=200)
    doc[0].insert_text((10, 30), "tiny")
    files["tiny"] = root / "tiny.pdf"
    doc.save(files["tiny"], garbage=4, deflate=True, use_objstms=1)
    doc.close()

    # Encrypted variants.
    source = pymupdf.open(files["a"])
    files["enc_user"] = root / "encrypted.pdf"
    source.save(
        files["enc_user"],
        encryption=pymupdf.PDF_ENCRYPT_AES_256,
        user_pw="open-me",
        owner_pw="owner-secret",
        permissions=pymupdf.PDF_PERM_PRINT,
    )
    files["enc_same"] = root / "encrypted-same.pdf"
    source.save(files["enc_same"], encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="both", owner_pw="both")
    files["enc_owner_only"] = root / "restricted.pdf"
    source.save(
        files["enc_owner_only"],
        encryption=pymupdf.PDF_ENCRYPT_AES_256,
        user_pw="",
        owner_pw="owner-secret",
        permissions=pymupdf.PDF_PERM_PRINT,
    )
    source.close()

    # Malformed inputs.
    files["garbage"] = root / "garbage.pdf"
    files["garbage"].write_bytes(b"this is not a pdf file at all")
    files["empty_pdf"] = root / "empty.pdf"
    files["empty_pdf"].write_bytes(b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\n")
    files["truncated_png"] = root / "broken.png"
    files["truncated_png"].write_bytes((root / "picture.png").read_bytes()[:30])
    return files


def src(path: Path, source_id: str = "s", password: str | None = None) -> dict:
    ref = {"id": source_id, "path": str(path)}
    if password:
        ref["password"] = password
    return ref


def page_labels(path: Path, password: str | None = None) -> list[str]:
    with pymupdf.open(path) as doc:
        if password:
            doc.authenticate(password)
        return [page.get_text("text").strip().split("\n")[0] if page.get_text("text").strip() else "" for page in doc]


def ink_bbox(page: pymupdf.Page, threshold: int = 200):
    """Bounding box, in visual page points, of everything darker than the threshold."""
    pix = page.get_pixmap(dpi=72, alpha=False)
    image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    return Image.eval(image.convert("L"), lambda v: 255 if v < threshold else 0).getbbox()


def temp_files(folder: Path) -> list[str]:
    return [name for name in os.listdir(folder) if name.startswith(".paperforge-")]
