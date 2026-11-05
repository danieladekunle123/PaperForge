"""Small declarative validator for job parameters.

The TypeScript side validates with Zod before anything reaches the worker. The worker validates
again because stdin is a trust boundary of its own. A shared fixture set keeps both in agreement.
"""

from __future__ import annotations

from typing import Any

from .errors import invalid_request


class Opt:
    def __init__(self, spec: Any):
        self.spec = spec


class Enum:
    def __init__(self, *values: Any):
        self.values = values


class Num:
    def __init__(self, min: float | None = None, max: float | None = None, integer: bool = False):
        self.min, self.max, self.integer = min, max, integer


class Str:
    def __init__(self, min_len: int = 0, max_len: int = 10_000_000):
        self.min_len, self.max_len = min_len, max_len


class ListOf:
    def __init__(self, item: Any, min_len: int = 0, max_len: int = 200_000):
        self.item, self.min_len, self.max_len = item, min_len, max_len


class OneOf:
    """Tagged union selected by the value of ``tag``."""

    def __init__(self, tag: str, variants: dict[str, dict[str, Any]]):
        self.tag, self.variants = tag, variants


def check(value: Any, spec: Any, where: str = "params") -> None:
    if isinstance(spec, dict):
        if not isinstance(value, dict):
            raise invalid_request(f"{where} must be an object.")
        for key in value:
            if key not in spec:
                raise invalid_request(f"{where}.{key} is not a recognised field.")
        for key, sub in spec.items():
            if isinstance(sub, Opt):
                if key in value and value[key] is not None:
                    check(value[key], sub.spec, f"{where}.{key}")
            elif key not in value:
                raise invalid_request(f"{where}.{key} is required.")
            else:
                check(value[key], sub, f"{where}.{key}")
    elif isinstance(spec, OneOf):
        if not isinstance(value, dict) or value.get(spec.tag) not in spec.variants:
            raise invalid_request(f"{where}.{spec.tag} has an unsupported value.")
        check(value, spec.variants[value[spec.tag]], where)
    elif isinstance(spec, Enum):
        if value not in spec.values:
            raise invalid_request(f"{where} has an unsupported value.")
    elif isinstance(spec, Num):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise invalid_request(f"{where} must be a number.")
        if spec.integer and int(value) != value:
            raise invalid_request(f"{where} must be a whole number.")
        if spec.min is not None and value < spec.min:
            raise invalid_request(f"{where} must be at least {spec.min}.")
        if spec.max is not None and value > spec.max:
            raise invalid_request(f"{where} must be at most {spec.max}.")
    elif isinstance(spec, Str):
        if not isinstance(value, str):
            raise invalid_request(f"{where} must be text.")
        if not spec.min_len <= len(value) <= spec.max_len:
            raise invalid_request(f"{where} has an invalid length.")
    elif isinstance(spec, ListOf):
        if not isinstance(value, list):
            raise invalid_request(f"{where} must be a list.")
        if not spec.min_len <= len(value) <= spec.max_len:
            raise invalid_request(f"{where} has an invalid number of items.")
        for index, item in enumerate(value):
            check(item, spec.item, f"{where}[{index}]")
    elif spec is bool:
        if not isinstance(value, bool):
            raise invalid_request(f"{where} must be true or false.")
    else:  # pragma: no cover - programming error in a schema definition
        raise TypeError(f"Unknown spec {spec!r}")


PAGE_INDEX = Num(min=0, integer=True)
PAGE_LIST = ListOf(PAGE_INDEX, min_len=1)
SOURCE = {"id": Str(min_len=1, max_len=128), "path": Str(min_len=1), "password": Opt(Str(max_len=1024))}
OUTPUT = {"path": Str(min_len=1), "overwrite": Enum("error", "replace", "rename")}
ROTATION = Enum(0, 90, 180, 270)
COLOR = Str(min_len=7, max_len=7)

PAGE_NUMBERS = {
    "position": Enum(
        "top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"
    ),
    "start": Num(min=0, max=1_000_000, integer=True),
    "fontSize": Num(min=4, max=96),
    "color": COLOR,
    "format": Enum("n", "page_n", "n_of_total"),
    "marginPt": Opt(Num(min=0, max=200)),
    "pages": Opt(ListOf(PAGE_INDEX)),
}

WATERMARK = {
    "text": Str(min_len=1, max_len=500),
    "fontSize": Num(min=4, max=400),
    "color": COLOR,
    "opacity": Num(min=0.01, max=1),
    "rotation": Num(min=-360, max=360),
    "position": Enum(
        "center", "top-left", "top-center", "top-right", "middle-left", "middle-right",
        "bottom-left", "bottom-center", "bottom-right",
    ),
    "layer": Enum("foreground", "background"),
    "pages": Opt(ListOf(PAGE_INDEX)),
}

OVERLAY = OneOf(
    "kind",
    {
        "image": {
            "kind": Enum("image"),
            "pageIndex": PAGE_INDEX,
            "x": Num(min=-1, max=2),
            "y": Num(min=-1, max=2),
            "w": Num(min=0.001, max=3),
            "h": Num(min=0.001, max=3),
            "pngBase64": Opt(Str(min_len=1, max_len=40_000_000)),
            "imageSourceId": Opt(Str(min_len=1, max_len=128)),
            "knockoutWhite": Opt(bool),
        },
        "text": {
            "kind": Enum("text"),
            "pageIndex": PAGE_INDEX,
            "x": Num(min=-1, max=2),
            "y": Num(min=-1, max=2),
            "text": Str(min_len=1, max_len=5000),
            "fontSize": Num(min=4, max=200),
            "color": COLOR,
        },
    },
)

METADATA = {
    "mode": Enum("edit", "strip"),
    "title": Opt(Str(max_len=4000)),
    "author": Opt(Str(max_len=4000)),
    "subject": Opt(Str(max_len=4000)),
    "keywords": Opt(Str(max_len=4000)),
}

OUTPUT_PAGE = OneOf(
    "kind",
    {
        "pdf": {
            "kind": Enum("pdf"),
            "sourceId": Str(min_len=1),
            "pageIndex": PAGE_INDEX,
            "rotation": ROTATION,
        },
        "image": {"kind": Enum("image"), "sourceId": Str(min_len=1), "rotation": ROTATION},
        "blank": {"kind": Enum("blank"), "rotation": ROTATION},
    },
)

PAGE_SIZE = Enum("A4", "Letter")

ASSEMBLE_OPTIONS = {
    "pageSizing": Enum("preserve", "fit"),
    "fitSize": PAGE_SIZE,
    "blankSize": PAGE_SIZE,
    "imageFit": Enum("contain", "cover"),
    "keepAttachments": Opt(bool),
    "pageNumbers": Opt(PAGE_NUMBERS),
    "metadata": Opt(METADATA),
}

IMAGE_LAYOUT = {
    "pageSize": Enum("A4", "Letter", "image"),
    "orientation": Enum("auto", "portrait", "landscape"),
    "marginPt": Num(min=0, max=200),
    "fit": Enum("contain", "cover"),
}

SOURCES = ListOf(SOURCE, min_len=1, max_len=2000)
PAGES = ListOf(OUTPUT_PAGE, min_len=1)

PREVIEW_SIZE = Num(min=64, max=2400, integer=True)

APPLY_FIELDS = {
    "source": SOURCE,
    "imageSources": Opt(ListOf(SOURCE)),
    "pageNumbers": Opt(PAGE_NUMBERS),
    "watermark": Opt(WATERMARK),
    "overlays": Opt(ListOf(OVERLAY, max_len=2000)),
    "metadata": Opt(METADATA),
}

PERMISSIONS = {
    "print": bool,
    "printHighQuality": bool,
    "modify": bool,
    "copy": bool,
    "annotate": bool,
    "fillForms": bool,
    "assemble": bool,
}

OP_SPECS: dict[str, dict[str, Any]] = {
    "probe": {"source": {**SOURCE, "kind": Enum("pdf", "image")}},
    "assemble": {
        "sources": ListOf(SOURCE),
        "pages": PAGES,
        "options": ASSEMBLE_OPTIONS,
        "output": OUTPUT,
    },
    "preview_assemble": {
        "sources": ListOf(SOURCE),
        "pages": PAGES,
        "options": ASSEMBLE_OPTIONS,
        "previewIndex": PAGE_INDEX,
        "maxSize": PREVIEW_SIZE,
    },
    "split": {
        "source": SOURCE,
        "groups": ListOf(
            {"name": Str(min_len=1, max_len=255), "pages": PAGE_LIST}, min_len=1, max_len=100_000
        ),
        "folder": OUTPUT,
    },
    "compress": {
        "source": SOURCE,
        "mode": Enum("lossless", "balanced", "strong", "rasterize"),
        "output": OUTPUT,
    },
    "pdf_to_images": {
        "source": SOURCE,
        "pages": PAGE_LIST,
        "format": Enum("png", "jpg"),
        "dpi": Num(min=36, max=1200, integer=True),
        "jpegQuality": Opt(Num(min=1, max=100, integer=True)),
        "baseName": Str(min_len=1, max_len=200),
        "folder": OUTPUT,
    },
    "images_to_pdf": {
        "sources": ListOf(SOURCE, min_len=1),
        "images": ListOf(Str(min_len=1), min_len=1),
        "layout": IMAGE_LAYOUT,
        "output": OUTPUT,
    },
    "preview_images": {
        "sources": ListOf(SOURCE, min_len=1),
        "images": ListOf(Str(min_len=1), min_len=1),
        "layout": IMAGE_LAYOUT,
        "previewIndex": PAGE_INDEX,
        "maxSize": PREVIEW_SIZE,
    },
    "apply": {**APPLY_FIELDS, "output": OUTPUT},
    "preview_apply": {**APPLY_FIELDS, "previewIndex": PAGE_INDEX, "maxSize": PREVIEW_SIZE},
    "protect": {
        "source": SOURCE,
        "userPassword": Opt(Str(min_len=1, max_len=1024)),
        "ownerPassword": Opt(Str(min_len=1, max_len=1024)),
        "permissions": Opt(PERMISSIONS),
        "output": OUTPUT,
    },
    "unprotect": {"source": SOURCE, "output": OUTPUT},
    "extract_text": {"source": SOURCE, "pages": PAGE_LIST},
    "save_text": {"text": Str(), "output": OUTPUT},
}
