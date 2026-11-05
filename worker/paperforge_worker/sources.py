"""Opening, authenticating and analysing source documents."""

from __future__ import annotations

import io
import os
from dataclasses import dataclass
from typing import Any

import pymupdf
from PIL import Image, ImageOps, UnidentifiedImageError

from .errors import WorkerError, from_os_error
from .fsutil import file_size, native_path

ALL_PERMISSIONS = -4
MAX_IMAGE_PIXELS = 400_000_000
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS

PERMISSION_LABELS = {
    pymupdf.PDF_PERM_ASSEMBLE: "reassembling pages",
    pymupdf.PDF_PERM_MODIFY: "modifying content",
    pymupdf.PDF_PERM_COPY: "copying content",
    pymupdf.PDF_PERM_ANNOTATE: "adding annotations",
}


def open_pdf(path: str, password: str | None = None) -> pymupdf.Document:
    """Open and authenticate a PDF. Never logs or stores the password."""
    target = native_path(path)
    if not os.path.isfile(target):
        raise WorkerError(
            "FILE_NOT_FOUND",
            f"“{os.path.basename(path)}” could not be found. It may have been moved or deleted.",
        )
    try:
        doc = pymupdf.open(target, filetype="pdf")
    except OSError as exc:
        if isinstance(exc, pymupdf.FileDataError):
            raise _malformed(path) from exc
        raise from_os_error(exc, "source file") from exc
    except Exception as exc:
        raise _malformed(path) from exc

    # Read this exactly once, before authenticating: in PyMuPDF 2.1 reading `needs_pass` after an
    # owner login re-authenticates with an empty password and silently drops the owner's rights.
    needs_password = bool(doc.needs_pass)
    doc.pf_needs_password = needs_password
    if needs_password:
        if not password:
            doc.close()
            raise WorkerError(
                "PASSWORD_REQUIRED",
                f"“{os.path.basename(path)}” is password protected.",
            )
        if not doc.authenticate(password):
            doc.close()
            raise WorkerError(
                "WRONG_PASSWORD",
                f"That password does not open “{os.path.basename(path)}”.",
            )
    elif password and doc.metadata.get("encryption"):
        # An owner password lifts restrictions on files that open without a password.
        if not doc.authenticate(password):
            doc.close()
            raise WorkerError(
                "WRONG_PASSWORD",
                f"That is not the owner password of “{os.path.basename(path)}”.",
            )

    if doc.page_count == 0:
        doc.close()
        raise _malformed(path, "It contains no readable pages.")
    return doc


def _malformed(path: str, extra: str = "") -> WorkerError:
    suffix = f" {extra}" if extra else " The file may be corrupt or not actually a PDF."
    return WorkerError("INVALID_FILE", f"“{os.path.basename(path)}” could not be read.{suffix}")


def has_full_access(doc: pymupdf.Document) -> bool:
    return doc.permissions == ALL_PERMISSIONS


def require_permission(doc: pymupdf.Document, path: str, *any_of: int) -> None:
    """Honour the document's permission flags. An owner password lifts the restriction."""
    if has_full_access(doc):
        return
    if any(doc.permissions & flag for flag in any_of):
        return
    action = PERMISSION_LABELS.get(any_of[0], "this operation")
    raise WorkerError(
        "PERMISSION_DENIED",
        f"The permissions set on “{os.path.basename(path)}” do not allow {action}. "
        "If you own this document, re-open it with its owner password.",
    )


@dataclass
class LoadedImage:
    data: bytes
    width: int
    height: int
    dpi: tuple[float, float] | None
    has_alpha: bool
    reencoded: bool


def load_image(path: str) -> LoadedImage:
    """Read a JPG or PNG. JPEG/PNG bytes pass through untouched whenever that is correct."""
    target = native_path(path)
    try:
        with open(target, "rb") as handle:
            raw = handle.read()
    except OSError as exc:
        raise from_os_error(exc, "image file") from exc
    return decode_image(raw, os.path.basename(path))


def decode_image(raw: bytes, name: str) -> LoadedImage:
    try:
        with Image.open(io.BytesIO(raw)) as img:
            if img.format not in ("JPEG", "PNG"):
                raise WorkerError("INVALID_FILE", f"“{name}” is not a supported image type (JPG or PNG).")
            img.load()
            orientation = img.getexif().get(0x0112, 1)
            dpi = _dpi(img.info.get("dpi"))
            has_alpha = img.mode in ("RGBA", "LA", "PA") or (
                img.mode == "P" and "transparency" in img.info
            )
            # MuPDF treats Adobe CMYK JPEGs inconsistently and ignores EXIF orientation.
            needs_rewrite = orientation != 1 or img.mode in ("CMYK", "I;16", "I", "F")
            width, height = img.size
            if not needs_rewrite:
                return LoadedImage(raw, width, height, dpi, has_alpha, False)
            transposed = ImageOps.exif_transpose(img)
            buf = io.BytesIO()
            if has_alpha or img.format == "PNG":
                if transposed.mode in ("I;16", "I", "F"):
                    transposed = transposed.convert("L")
                transposed.save(buf, "PNG")
            else:
                transposed.convert("RGB").save(buf, "JPEG", quality=95, subsampling=0)
            return LoadedImage(buf.getvalue(), *transposed.size, dpi, has_alpha, True)
    except WorkerError:
        raise
    except Image.DecompressionBombError as exc:
        raise WorkerError("INVALID_FILE", f"“{name}” is too large to process safely.") from exc
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError) as exc:
        raise WorkerError("INVALID_FILE", f"“{name}” could not be read as an image.") from exc


def _dpi(value: Any) -> tuple[float, float] | None:
    try:
        x, y = float(value[0]), float(value[1])
    except (TypeError, ValueError, IndexError):
        return None
    return (x, y) if x > 1 and y > 1 else None


def crop_cover(image: LoadedImage, target_aspect: float) -> bytes:
    """Crop to the target aspect ratio around the centre. Used only for cover mode."""
    with Image.open(io.BytesIO(image.data)) as img:
        img.load()
        fmt = img.format
        w, h = img.size
        if w / h > target_aspect:
            new_w = max(1, round(h * target_aspect))
            left = (w - new_w) // 2
            box = (left, 0, left + new_w, h)
        else:
            new_h = max(1, round(w / target_aspect))
            top = (h - new_h) // 2
            box = (0, top, w, top + new_h)
        cropped = img.crop(box)
        buf = io.BytesIO()
        if fmt == "JPEG":
            cropped.convert("RGB").save(buf, "JPEG", quality=95, subsampling=0)
        else:
            cropped.save(buf, "PNG")
        return buf.getvalue()


def probe_image(path: str) -> dict[str, Any]:
    image = load_image(path)
    return {
        "kind": "image",
        "name": os.path.basename(path),
        "sizeBytes": file_size(path),
        "pageCount": 1,
        "pages": [{"width": image.width, "height": image.height, "rotation": 0}],
        "image": {"width": image.width, "height": image.height, "hasAlpha": image.has_alpha},
    }


def probe_pdf(path: str, password: str | None) -> dict[str, Any]:
    """Collect the facts the UI needs, including preservation-relevant document features."""
    with open_pdf(path, password) as doc:
        metadata = doc.metadata or {}
        encryption = metadata.get("encryption")
        pages = []
        annot_pages = 0
        widget_pages = 0
        for page in doc:
            rect = page.rect
            pages.append(
                {"width": round(rect.width, 2), "height": round(rect.height, 2), "rotation": page.rotation}
            )
            if page.first_annot:
                annot_pages += 1
            if page.first_widget:
                widget_pages += 1
        catalog = doc.pdf_catalog()
        acroform_kind, acroform_value = doc.xref_get_key(catalog, "AcroForm")
        xfa = False
        if acroform_kind == "xref":
            xfa = doc.xref_get_key(int(acroform_value.split()[0]), "XFA")[0] != "null"
        elif acroform_kind == "dict":
            xfa = "/XFA" in acroform_value
        names = doc.xref_get_key(catalog, "Names")[1]
        has_js = "/JavaScript" in names or doc.xref_get_key(catalog, "OpenAction")[0] != "null"
        ocgs = doc.get_ocgs() or {}
        return {
            "kind": "pdf",
            "name": os.path.basename(path),
            "sizeBytes": file_size(path),
            "pageCount": doc.page_count,
            "pages": pages,
            "metadata": {
                key: metadata.get(key) or ""
                for key in (
                    "title", "author", "subject", "keywords",
                    "creator", "producer", "creationDate", "modDate", "format",
                )
            },
            "security": {
                "encrypted": bool(encryption),
                "encryption": encryption or "",
                "needsPassword": doc.pf_needs_password,
                "fullAccess": has_full_access(doc),
                "permissions": permission_summary(doc),
            },
            "features": {
                "tocEntries": len(doc.get_toc(simple=True)),
                "annotationPages": annot_pages,
                "formPages": widget_pages,
                "isForm": bool(doc.is_form_pdf),
                "xfa": bool(xfa),
                "signed": doc.get_sigflags() >= 1,
                "attachments": doc.embfile_count(),
                "layers": len(ocgs),
                "javascript": bool(has_js),
            },
        }


def permission_summary(doc: pymupdf.Document) -> dict[str, bool]:
    full = has_full_access(doc)
    perms = doc.permissions

    def allowed(flag: int) -> bool:
        return full or bool(perms & flag)

    return {
        "print": allowed(pymupdf.PDF_PERM_PRINT),
        "printHighQuality": allowed(pymupdf.PDF_PERM_PRINT_HQ),
        "modify": allowed(pymupdf.PDF_PERM_MODIFY),
        "copy": allowed(pymupdf.PDF_PERM_COPY),
        "annotate": allowed(pymupdf.PDF_PERM_ANNOTATE),
        "fillForms": allowed(pymupdf.PDF_PERM_FORM),
        "assemble": allowed(pymupdf.PDF_PERM_ASSEMBLE),
    }
