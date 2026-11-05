"""Page numbers, watermarks and placed overlays.

Every position here is expressed in the page's *visual* frame (the page as a viewer shows it,
top-left origin) and converted to PDF insertion coordinates in exactly one place. PyMuPDF insertion
methods take unrotated coordinates, while `Page.rect` describes the rotated, cropped view.
"""

from __future__ import annotations

import base64
import io
import math
from contextlib import contextmanager
from typing import Any, Iterator

import pymupdf
from PIL import Image

from .errors import WorkerError, invalid_request
from .sources import decode_image, load_image

FALLBACK_FONT_NAME = "pfunicode"


@contextmanager
def unrotated(page: pymupdf.Page) -> Iterator[int]:
    """Insert content with /Rotate temporarily cleared.

    PyMuPDF's insertion transform drops the crop box offset on rotated pages. With rotation cleared
    the transform is correct, and coordinates derived from `derotation_matrix` beforehand still
    apply because they are relative to the crop box corner.
    """
    rotation = page.rotation
    if rotation:
        page.set_rotation(0)
    try:
        yield rotation
    finally:
        if rotation:
            page.set_rotation(rotation)


def parse_color(value: str) -> tuple[float, float, float]:
    if len(value) != 7 or value[0] != "#":
        raise invalid_request("Colours must be written as #RRGGBB.")
    try:
        return tuple(int(value[i : i + 2], 16) / 255 for i in (1, 3, 5))  # type: ignore[return-value]
    except ValueError as exc:
        raise invalid_request("Colours must be written as #RRGGBB.") from exc


class FontChoice:
    """Base-14 Helvetica for Latin-1 text, an embedded Unicode fallback for the rest."""

    _fallback: pymupdf.Font | None = None

    def __init__(self, text: str):
        self.embedded = any(ord(ch) > 255 for ch in text)
        if not self.embedded:
            self.name = "helv"
            self.font = None
            return
        if FontChoice._fallback is None:
            FontChoice._fallback = pymupdf.Font("cjk")
        missing = sorted({ch for ch in text if ch.strip() and not FontChoice._fallback.has_glyph(ord(ch))})
        if missing:
            sample = " ".join(missing[:8])
            raise WorkerError(
                "UNSUPPORTED",
                "The built-in font cannot draw these characters: "
                f"{sample}. Latin, Greek, Cyrillic and CJK text are supported; "
                "right-to-left scripts are not.",
            )
        self.name = FALLBACK_FONT_NAME
        self.font = FontChoice._fallback

    def width(self, text: str, size: float) -> float:
        if self.font is None:
            return pymupdf.get_text_length(text, fontname="helv", fontsize=size)
        return self.font.text_length(text, fontsize=size)

    def prepare(self, page: pymupdf.Page) -> None:
        if self.font is not None:
            page.insert_font(fontname=FALLBACK_FONT_NAME, fontbuffer=self.font.buffer)


def draw_text(
    page: pymupdf.Page,
    text: str,
    x: float,
    y: float,
    *,
    size: float,
    color: tuple[float, float, float],
    font: FontChoice,
    opacity: float = 1.0,
    angle: float = 0.0,
    overlay: bool = True,
) -> None:
    """Draw text whose baseline starts at visual (x, y), turned ``angle`` degrees anticlockwise."""
    font.prepare(page)
    origin = pymupdf.Point(x, y) * page.derotation_matrix
    with unrotated(page) as rotation:
        page.insert_text(
            origin,
            text,
            fontsize=size,
            fontname=font.name,
            color=color,
            fill_opacity=opacity,
            stroke_opacity=opacity,
            overlay=overlay,
            morph=(origin, pymupdf.Matrix(rotation + angle)),
        )


def page_number_label(fmt: str, number: int, total: int) -> str:
    if fmt == "n":
        return str(number)
    if fmt == "page_n":
        return f"Page {number}"
    return f"{number} of {total}"


def page_number_map(spec: dict[str, Any], page_count: int) -> tuple[dict[int, int], int]:
    """Map page index to displayed number. ``total`` is the highest number shown."""
    indices = spec.get("pages")
    selected = sorted(set(indices)) if indices is not None else list(range(page_count))
    numbers = {index: spec["start"] + offset for offset, index in enumerate(selected)}
    total = spec["start"] + len(selected) - 1 if selected else 0
    return numbers, total


def add_page_number(page: pymupdf.Page, spec: dict[str, Any], number: int, total: int) -> None:
    text = page_number_label(spec["format"], number, total)
    size = spec["fontSize"]
    font = FontChoice(text)
    width = font.width(text, size)
    rect = page.rect
    margin = spec.get("marginPt", 24)
    vertical, horizontal = spec["position"].split("-")
    if horizontal == "left":
        x = margin
    elif horizontal == "right":
        x = rect.width - margin - width
    else:
        x = (rect.width - width) / 2
    y = margin + size * 0.8 if vertical == "top" else rect.height - margin
    draw_text(page, text, x, y, size=size, color=parse_color(spec["color"]), font=font)


def add_watermark(page: pymupdf.Page, spec: dict[str, Any]) -> None:
    text = spec["text"]
    size = spec["fontSize"]
    angle = spec["rotation"]
    font = FontChoice(text)
    width = font.width(text, size)
    theta = math.radians(angle)
    cos_t, sin_t = math.cos(theta), math.sin(theta)
    half_w = abs(width / 2 * cos_t) + abs(size / 2 * sin_t)
    half_h = abs(width / 2 * sin_t) + abs(size / 2 * cos_t)
    rect = page.rect
    margin = 24.0
    position = spec["position"]
    if position == "center":
        vertical, horizontal = "middle", "center"
    else:
        vertical, horizontal = position.split("-")
    cx = {
        "left": margin + half_w,
        "center": rect.width / 2,
        "right": rect.width - margin - half_w,
    }[horizontal]
    cy = {
        "top": margin + half_h,
        "middle": rect.height / 2,
        "bottom": rect.height - margin - half_h,
    }[vertical]
    # Step back half the text length along its direction, then down to the baseline.
    x = cx - width / 2 * cos_t + 0.3 * size * sin_t
    y = cy + width / 2 * sin_t + 0.3 * size * cos_t
    draw_text(
        page,
        text,
        x,
        y,
        size=size,
        color=parse_color(spec["color"]),
        font=font,
        opacity=spec["opacity"],
        angle=angle,
        overlay=spec["layer"] == "foreground",
    )


def visual_rect_to_unrotated(page: pymupdf.Page, rect: pymupdf.Rect) -> pymupdf.Rect:
    converted = rect * page.derotation_matrix
    converted.normalize()
    return converted


def _knockout_white(data: bytes) -> bytes:
    """Make near-white pixels transparent, with a soft edge, for scanned signatures on paper."""
    with Image.open(io.BytesIO(data)) as img:
        rgba = img.convert("RGBA")
    alpha_source = rgba.convert("L").point(lambda v: 255 if v < 170 else max(0, 255 - (v - 170) * 3))
    existing = rgba.getchannel("A")
    combined = Image.composite(alpha_source, Image.new("L", rgba.size, 0), existing)
    rgba.putalpha(combined)
    buf = io.BytesIO()
    rgba.save(buf, "PNG")
    return buf.getvalue()


def add_overlay(page: pymupdf.Page, overlay: dict[str, Any], image_paths: dict[str, str]) -> None:
    rect = page.rect
    if overlay["kind"] == "image":
        target = pymupdf.Rect(
            overlay["x"] * rect.width,
            overlay["y"] * rect.height,
            (overlay["x"] + overlay["w"]) * rect.width,
            (overlay["y"] + overlay["h"]) * rect.height,
        )
        data = _overlay_image_bytes(overlay, image_paths)
        if overlay.get("knockoutWhite"):
            data = _knockout_white(data)
        converted = visual_rect_to_unrotated(page, target)
        with unrotated(page) as rotation:
            page.insert_image(converted, stream=data, rotate=rotation, keep_proportion=False)
        return
    size = overlay["fontSize"]
    color = parse_color(overlay["color"])
    # Matches where the on-screen editor draws the first baseline: Arial at line-height 1.25.
    baseline = overlay["y"] * rect.height + size * 0.97
    for line in overlay["text"].split("\n"):
        if line.strip():
            draw_text(
                page,
                line,
                overlay["x"] * rect.width,
                baseline,
                size=size,
                color=color,
                font=FontChoice(line),
            )
        baseline += size * 1.25


def _overlay_image_bytes(overlay: dict[str, Any], image_paths: dict[str, str]) -> bytes:
    if overlay.get("pngBase64"):
        try:
            raw = base64.b64decode(overlay["pngBase64"], validate=True)
        except ValueError as exc:
            raise invalid_request("The signature image data is not valid.") from exc
        return decode_image(raw, "signature").data
    source_id = overlay.get("imageSourceId")
    if source_id not in image_paths:
        raise invalid_request("An overlay refers to an image that was not provided.")
    return load_image(image_paths[source_id]).data


def needs_font_subset(*texts: str) -> bool:
    return any(ord(ch) > 255 for text in texts for ch in text)
