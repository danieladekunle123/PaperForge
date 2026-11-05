"""The document assembly engine. Merge, split, extract and images-to-PDF all build on this module."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

import pymupdf

from . import sources as src_mod
from . import stamps
from .errors import WorkerError, invalid_request

PAGE_SIZES = {"A4": (595.28, 841.89), "Letter": (612.0, 792.0)}


@dataclass
class ExpectedPage:
    width: float
    height: float
    rotation: int


@dataclass
class BuildResult:
    doc: pymupdf.Document
    expected: list[ExpectedPage]
    warnings: list[str] = field(default_factory=list)


class SourcePool:
    """Opens each source once for the life of a job, and closes all of them at the end."""

    def __init__(self, sources: list[dict[str, Any]]):
        self.refs = {s["id"]: s for s in sources}
        self._open: dict[str, pymupdf.Document] = {}
        self._baked: dict[str, pymupdf.Document] = {}
        self._images: dict[str, src_mod.LoadedImage] = {}
        self._forms: dict[str, bool] = {}

    def __enter__(self) -> SourcePool:
        return self

    def __exit__(self, *_exc: object) -> None:
        for doc in [*self._open.values(), *self._baked.values()]:
            doc.close()
        self._open.clear()
        self._baked.clear()
        self._images.clear()

    def ref(self, source_id: str) -> dict[str, Any]:
        if source_id not in self.refs:
            raise invalid_request("A page refers to a source file that was not provided.")
        return self.refs[source_id]

    def pdf(self, source_id: str) -> pymupdf.Document:
        if source_id not in self._open:
            ref = self.ref(source_id)
            doc = src_mod.open_pdf(ref["path"], ref.get("password"))
            src_mod.require_permission(
                doc, ref["path"], pymupdf.PDF_PERM_ASSEMBLE, pymupdf.PDF_PERM_MODIFY
            )
            self._open[source_id] = doc
        return self._open[source_id]

    def has_forms(self, source_id: str) -> bool:
        if source_id not in self._forms:
            self._forms[source_id] = bool(self.pdf(source_id).is_form_pdf)
        return self._forms[source_id]

    def baked(self, source_id: str) -> pymupdf.Document:
        """A private copy with annotations and form values flattened, for scaled placement."""
        if source_id not in self._baked:
            ref = self.ref(source_id)
            doc = src_mod.open_pdf(ref["path"], ref.get("password"))
            doc.bake(annots=True, widgets=True)
            self._baked[source_id] = doc
        return self._baked[source_id]

    def image(self, source_id: str) -> src_mod.LoadedImage:
        if source_id not in self._images:
            self._images[source_id] = src_mod.load_image(self.ref(source_id)["path"])
        return self._images[source_id]


def _oriented(size: tuple[float, float], landscape: bool) -> tuple[float, float]:
    short, long = min(size), max(size)
    return (long, short) if landscape else (short, long)


def _contain_rect(box: pymupdf.Rect, w: float, h: float) -> pymupdf.Rect:
    scale = min(box.width / w, box.height / h)
    dw, dh = w * scale, h * scale
    x0 = box.x0 + (box.width - dw) / 2
    y0 = box.y0 + (box.height - dh) / 2
    return pymupdf.Rect(x0, y0, x0 + dw, y0 + dh)


def add_image_page(out: pymupdf.Document, image: src_mod.LoadedImage, layout: dict[str, Any]) -> None:
    margin = layout.get("marginPt", 0)
    if layout["pageSize"] == "image":
        dpi = image.dpi or (96.0, 96.0)
        width = image.width * 72 / dpi[0] + 2 * margin
        height = image.height * 72 / dpi[1] + 2 * margin
    else:
        orientation = layout.get("orientation", "auto")
        landscape = (
            image.width > image.height if orientation == "auto" else orientation == "landscape"
        )
        width, height = _oriented(PAGE_SIZES[layout["pageSize"]], landscape)
    out.new_page(width=width, height=height)
    page = out[out.page_count - 1]
    box = pymupdf.Rect(margin, margin, width - margin, height - margin)
    if box.is_empty or box.width <= 1 or box.height <= 1:
        raise WorkerError("INVALID_REQUEST", "The margins leave no room for the image on the page.")
    if layout["fit"] == "cover" and layout["pageSize"] != "image":
        data = src_mod.crop_cover(image, box.width / box.height)
        page.insert_image(box, stream=data, keep_proportion=False)
    else:
        page.insert_image(
            _contain_rect(box, image.width, image.height), stream=image.data, keep_proportion=False
        )


def _insert_pdf_page(
    out: pymupdf.Document,
    pool: SourcePool,
    item: dict[str, Any],
    options: dict[str, Any],
) -> None:
    doc = pool.pdf(item["sourceId"])
    index = item["pageIndex"]
    if index >= doc.page_count:
        raise invalid_request("A page refers to a page number outside its source document.")
    if options["pageSizing"] == "preserve":
        # Copies the page object, so text, vectors, annotations and form fields stay live.
        # Links are recreated afterwards because single-page copies lose internal targets.
        # widgets=True makes every call scan all source pages, which is quadratic over a long
        # document, so it is only requested when the source really has form fields.
        out.insert_pdf(
            doc, from_page=index, to_page=index, links=False, annots=True, widgets=pool.has_forms(item["sourceId"]), final=0
        )
        return
    source_page = doc[index]
    visual = source_page.rect
    rotation = source_page.rotation
    visual_w, visual_h = _oriented(PAGE_SIZES[options["fitSize"]], visual.width > visual.height)
    # show_pdf_page mishandles rotated sources, so place the unrotated content on an unrotated
    # target and give the target the same /Rotate. The private flattened copy is free to change.
    width, height = (visual_h, visual_w) if rotation in (90, 270) else (visual_w, visual_h)
    flattened = pool.baked(item["sourceId"])
    if flattened[index].rotation:
        flattened[index].set_rotation(0)
    out.new_page(width=width, height=height)
    page = out[out.page_count - 1]
    page.show_pdf_page(pymupdf.Rect(0, 0, width, height), flattened, index)
    page.set_rotation(rotation)


def _recreate_links(
    out: pymupdf.Document,
    pool: SourcePool,
    pages: list[dict[str, Any]],
    options: dict[str, Any],
    first_output: dict[tuple[str, int], int],
    warnings: list[str],
) -> None:
    dropped_internal = 0
    dropped_external_files = 0
    fit = options["pageSizing"] == "fit"
    for out_index, item in enumerate(pages):
        if item["kind"] != "pdf":
            continue
        source_page = pool.pdf(item["sourceId"])[item["pageIndex"]]
        links = source_page.get_links()
        if not links:
            continue
        page = out[out_index]
        if fit:
            scale = min(
                page.rect.width / source_page.rect.width, page.rect.height / source_page.rect.height
            )
            off_x = (page.rect.width - source_page.rect.width * scale) / 2
            off_y = (page.rect.height - source_page.rect.height * scale) / 2
        for link in links:
            kind = link["kind"]
            visual = pymupdf.Rect(link["from"])
            if fit:
                visual = pymupdf.Rect(
                    off_x + visual.x0 * scale,
                    off_y + visual.y0 * scale,
                    off_x + visual.x1 * scale,
                    off_y + visual.y1 * scale,
                )
            # get_links reports the visual frame, insert_link expects the unrotated frame.
            area = stamps.visual_rect_to_unrotated(page, visual)
            if kind == pymupdf.LINK_URI and link.get("uri"):
                with stamps.unrotated(page):
                    page.insert_link({"kind": pymupdf.LINK_URI, "from": area, "uri": link["uri"]})
            elif kind in (pymupdf.LINK_GOTO, pymupdf.LINK_NAMED) and link.get("page", -1) >= 0:
                target = first_output.get((item["sourceId"], link["page"]))
                if target is None:
                    dropped_internal += 1
                    continue
                entry = {"kind": pymupdf.LINK_GOTO, "from": area, "page": target}
                if not fit and link.get("to") is not None:
                    entry["to"] = link["to"]
                    entry["zoom"] = link.get("zoom", 0)
                else:
                    entry["to"] = pymupdf.Point(0, 0)
                with stamps.unrotated(page):
                    page.insert_link(entry)
            else:
                dropped_external_files += 1
    if dropped_internal:
        warnings.append(
            f"{dropped_internal} internal link(s) were removed because their target page "
            "is not in the output."
        )
    if dropped_external_files:
        warnings.append(
            f"{dropped_external_files} link(s) that open other files or run actions were removed."
        )


def _rebuild_toc(
    out: pymupdf.Document,
    pool: SourcePool,
    pages: list[dict[str, Any]],
    first_output: dict[tuple[str, int], int],
    warnings: list[str],
) -> None:
    entries: list[tuple[int, int, int, str]] = []
    dropped = 0
    seen: set[str] = set()
    for sequence, item in enumerate(pages):
        if item["kind"] != "pdf" or item["sourceId"] in seen:
            continue
        seen.add(item["sourceId"])
        for order, (level, title, page_no) in enumerate(pool.pdf(item["sourceId"]).get_toc(simple=True)):
            target = first_output.get((item["sourceId"], page_no - 1))
            if target is None:
                dropped += 1
                continue
            entries.append((target, sequence, order, f"{level}\0{title}"))
    if not entries:
        return
    entries.sort(key=lambda e: e[:3])
    toc: list[list[Any]] = []
    previous_level = 0
    for target, _seq, _order, packed in entries:
        level_text, title = packed.split("\0", 1)
        level = min(int(level_text), previous_level + 1)
        toc.append([level, title, target + 1])
        previous_level = level
    out.set_toc(toc)
    if dropped:
        warnings.append(f"{dropped} bookmark(s) were removed because their page is not in the output.")


def _copy_attachments(
    out: pymupdf.Document, pool: SourcePool, pages: list[dict[str, Any]]
) -> int:
    used: set[str] = set()
    copied = 0
    for source_id in dict.fromkeys(p["sourceId"] for p in pages if p["kind"] == "pdf"):
        doc = pool.pdf(source_id)
        for name in doc.embfile_names():
            info = doc.embfile_info(name)
            unique = name
            suffix = 1
            while unique in used:
                unique = f"{name} ({suffix})"
                suffix += 1
            used.add(unique)
            out.embfile_add(
                unique,
                doc.embfile_get(name),
                filename=info.get("filename"),
                ufilename=info.get("ufilename"),
                desc=info.get("description"),
            )
            copied += 1
    return copied


def apply_metadata(doc: pymupdf.Document, spec: dict[str, Any]) -> None:
    if spec["mode"] == "strip":
        doc.set_metadata({})
        doc.del_xml_metadata()
        return
    current = dict(doc.metadata or {})
    for key in ("title", "author", "subject", "keywords"):
        if key in spec and spec[key] is not None:
            current[key] = spec[key]
    current.pop("encryption", None)
    current.pop("format", None)
    doc.set_metadata(current)


def build_document(
    pool: SourcePool,
    pages: list[dict[str, Any]],
    options: dict[str, Any],
    *,
    on_page: Callable[[int, int], None] = lambda _d, _t: None,
    include_extras: bool = True,
    numbering_offset: tuple[int, int] | None = None,
) -> BuildResult:
    """Build the output document in memory. Sources are read and never changed.

    ``numbering_offset`` lets a preview render one page with its numbering in the full document:
    (index of this page in the full output, page count of the full output).
    """
    out = pymupdf.open()
    warnings: list[str] = []
    try:
        total = len(pages)
        first_output: dict[tuple[str, int], int] = {}
        image_layout = {
            "pageSize": options["fitSize"] if options["pageSizing"] == "fit" else options["blankSize"],
            "orientation": "auto",
            "marginPt": 0,
            "fit": options["imageFit"],
        }
        for index, item in enumerate(pages):
            kind = item["kind"]
            if kind == "pdf":
                _insert_pdf_page(out, pool, item, options)
                first_output.setdefault((item["sourceId"], item["pageIndex"]), index)
            elif kind == "image":
                add_image_page(out, pool.image(item["sourceId"]), image_layout)
            else:
                size_name = options["fitSize"] if options["pageSizing"] == "fit" else options["blankSize"]
                width, height = PAGE_SIZES[size_name]
                out.new_page(width=width, height=height)
            on_page(index + 1, total)

        if include_extras:
            _recreate_links(out, pool, pages, options, first_output, warnings)
            _rebuild_toc(out, pool, pages, first_output, warnings)
            if options.get("keepAttachments", True):
                _copy_attachments(out, pool, pages)

        expected: list[ExpectedPage] = []
        for index, item in enumerate(pages):
            page = out[index]
            extra = item.get("rotation", 0)
            if extra:
                page.set_rotation((page.rotation + extra) % 360)
            rect = page.rect
            expected.append(ExpectedPage(rect.width, rect.height, page.rotation))

        numbers = options.get("pageNumbers")
        if numbers:
            if numbering_offset is not None:
                page_map, last = stamps.page_number_map(numbers, numbering_offset[1])
                number = page_map.get(numbering_offset[0])
                if number is not None:
                    stamps.add_page_number(out[0], numbers, number, last)
            else:
                page_map, last = stamps.page_number_map(numbers, total)
                for index, number in page_map.items():
                    if index >= total:
                        raise invalid_request("Page numbering refers to a page outside the output.")
                    stamps.add_page_number(out[index], numbers, number, last)

        if options.get("metadata"):
            apply_metadata(out, options["metadata"])
        return BuildResult(out, expected, warnings)
    except Exception:
        out.close()
        raise
