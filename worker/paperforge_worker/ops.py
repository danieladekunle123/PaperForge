"""Job handlers. Each takes validated params and a JobContext, and returns a JSON-able result."""

from __future__ import annotations

import base64
import hashlib
import os
from typing import Any, Callable

import pymupdf

from . import sources as src_mod
from . import stamps
from .assembly import (
    ExpectedPage,
    SourcePool,
    add_image_page,
    apply_metadata,
    build_document,
)
from .errors import WorkerError, from_os_error, invalid_request
from .fsutil import (
    Staging,
    ensure_free_space,
    file_size,
    native_path,
    resolve_collision,
    safe_filename,
)
from .job import JobContext

SAVE_OPTIONS = {"garbage": 3, "deflate": True, "use_objstms": 1}
TOLERANCE_PT = 0.75


def _output_path(output: dict[str, Any]) -> str:
    return resolve_collision(output["path"], output["overwrite"])


def _save(doc: pymupdf.Document, temp: str, **options: Any) -> None:
    merged = {**SAVE_OPTIONS, **options}
    try:
        doc.save(temp, **merged)
    except OSError as exc:
        raise from_os_error(exc, "output file") from exc
    except RuntimeError as exc:
        text = str(exc).lower()
        if "no space" in text or "disk full" in text:
            raise WorkerError("DISK_FULL", "The output drive ran out of space.") from exc
        if "permission" in text or "cannot open" in text:
            raise WorkerError(
                "OUTPUT_LOCKED",
                "The output location could not be written. Check that it is not read-only.",
            ) from exc
        raise


def verify_pdf(
    path: str,
    *,
    expected: list[ExpectedPage] | None = None,
    page_count: int | None = None,
    password: str | None = None,
) -> int:
    """Reopen an output and check it really is what we meant to write."""
    try:
        doc = pymupdf.open(path, filetype="pdf")
    except Exception as exc:
        raise WorkerError("VERIFY_FAILED", "The output file could not be reopened.") from exc
    with doc:
        if doc.needs_pass and (not password or not doc.authenticate(password)):
            raise WorkerError("VERIFY_FAILED", "The output could not be reopened with its password.")
        count = doc.page_count
        wanted = len(expected) if expected is not None else page_count
        if wanted is not None and count != wanted:
            raise WorkerError(
                "VERIFY_FAILED", f"The output has {count} page(s), but {wanted} were expected."
            )
        for index, page_spec in enumerate(expected or []):
            page = doc[index]
            rect = page.rect
            if (
                abs(rect.width - page_spec.width) > TOLERANCE_PT
                or abs(rect.height - page_spec.height) > TOLERANCE_PT
                or page.rotation != page_spec.rotation
            ):
                raise WorkerError(
                    "VERIFY_FAILED", f"Page {index + 1} of the output has unexpected dimensions."
                )
        return count


def _preview_png(page: pymupdf.Page, max_size: int) -> dict[str, Any]:
    rect = page.rect
    scale = min(max_size / max(rect.width, rect.height), 4.0)
    pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
    return {
        "pngBase64": base64.b64encode(pix.tobytes("png")).decode("ascii"),
        "width": pix.width,
        "height": pix.height,
        "pageWidth": round(rect.width, 2),
        "pageHeight": round(rect.height, 2),
    }


def probe(params: dict[str, Any], _ctx: JobContext) -> dict[str, Any]:
    source = params["source"]
    if source["kind"] == "image":
        return src_mod.probe_image(source["path"])
    return src_mod.probe_pdf(source["path"], source.get("password"))


def _estimate_input_bytes(pool: SourcePool, pages: list[dict[str, Any]]) -> int:
    ids = {p["sourceId"] for p in pages if p["kind"] != "blank"}
    return sum(file_size(pool.ref(i)["path"]) for i in ids if os.path.exists(native_path(pool.ref(i)["path"])))


def assemble(params: dict[str, Any], ctx: JobContext) -> dict[str, Any]:
    pages = params["pages"]
    output_path = _output_path(params["output"])
    with SourcePool(params["sources"]) as pool:
        ensure_free_space(os.path.dirname(os.path.abspath(output_path)), _estimate_input_bytes(pool, pages))

        def on_page(done: int, total: int) -> None:
            ctx.check_cancelled()
            ctx.progress(done, total + 2, f"Assembling page {done} of {total}")

        built = build_document(pool, pages, params["options"], on_page=on_page)
        with built.doc, Staging(ctx.job_id) as staging:
            ctx.check_cancelled()
            ctx.progress(len(pages), len(pages) + 2, "Writing PDF")
            temp = staging.temp_for(output_path)
            if _uses_unicode_stamp(params["options"].get("pageNumbers")):
                built.doc.subset_fonts()
            _save(built.doc, temp)
            ctx.progress(len(pages) + 1, len(pages) + 2, "Verifying output")
            verify_pdf(temp, expected=built.expected)
            size = file_size(temp)
            staging.commit()
    return {
        "outputs": [{"path": output_path, "pages": len(pages), "sizeBytes": size}],
        "verified": True,
        "warnings": built.warnings,
    }


def _uses_unicode_stamp(spec: dict[str, Any] | None) -> bool:
    return bool(spec) and stamps.needs_font_subset(spec.get("text", ""))


def preview_assemble(params: dict[str, Any], _ctx: JobContext) -> dict[str, Any]:
    pages = params["pages"]
    index = params["previewIndex"]
    if index >= len(pages):
        raise invalid_request("The preview page is outside the output.")
    with SourcePool(params["sources"]) as pool:
        built = build_document(
            pool,
            [pages[index]],
            params["options"],
            include_extras=False,
            numbering_offset=(index, len(pages)),
        )
        with built.doc:
            return _preview_png(built.doc[0], params["maxSize"])


def split(params: dict[str, Any], ctx: JobContext) -> dict[str, Any]:
    source = params["source"]
    groups = params["groups"]
    folder = params["folder"]
    options = {
        "pageSizing": "preserve",
        "fitSize": "A4",
        "blankSize": "A4",
        "imageFit": "contain",
        "keepAttachments": False,
    }
    outputs: list[dict[str, Any]] = []
    warnings: list[str] = []
    taken: set[str] = set()
    with SourcePool([source]) as pool, Staging(ctx.job_id) as staging:
        page_count = pool.pdf(source["id"]).page_count
        ensure_free_space(folder["path"], file_size(source["path"]))
        planned: list[tuple[str, str, int]] = []
        for index, group in enumerate(groups):
            ctx.check_cancelled()
            ctx.progress(index, len(groups) + 1, f"Writing file {index + 1} of {len(groups)}")
            for page_index in group["pages"]:
                if page_index >= page_count:
                    raise invalid_request(f"Page {page_index + 1} does not exist in this document.")
            name = safe_filename(group["name"])
            if not name.lower().endswith(".pdf"):
                name += ".pdf"
            final = resolve_collision(os.path.join(folder["path"], name), folder["overwrite"], taken)
            taken.add(os.path.normcase(final))
            pages = [
                {"kind": "pdf", "sourceId": source["id"], "pageIndex": p, "rotation": 0}
                for p in group["pages"]
            ]
            built = build_document(pool, pages, options)
            with built.doc:
                temp = staging.temp_for(final)
                _save(built.doc, temp)
                verify_pdf(temp, expected=built.expected)
            for warning in built.warnings:
                if warning not in warnings:
                    warnings.append(warning)
            planned.append((final, temp, len(pages)))
        ctx.check_cancelled()
        sizes = {final: file_size(temp) for final, temp, _ in planned}
        ctx.progress(len(groups), len(groups) + 1, "Finishing")
        staging.commit()
        for final, _temp, count in planned:
            outputs.append({"path": final, "pages": count, "sizeBytes": sizes[final]})
    return {"outputs": outputs, "verified": True, "warnings": warnings}


def _image_digests(doc: pymupdf.Document) -> dict[int, str]:
    digests: dict[int, str] = {}
    for page in doc:
        for image in page.get_images(full=True):
            xref, smask = image[0], image[1]
            for item in (xref, smask):
                if item and item not in digests:
                    raw = doc.xref_stream_raw(item) or b""
                    digests[item] = hashlib.sha1(raw).hexdigest()
    return digests


COMPRESS_PROFILES = {
    "balanced": {"dpi_threshold": 200, "dpi_target": 150, "quality": 75},
    "strong": {"dpi_threshold": 130, "dpi_target": 96, "quality": 55},
}


def compress(params: dict[str, Any], ctx: JobContext) -> dict[str, Any]:
    source = params["source"]
    mode = params["mode"]
    original_size = file_size(source["path"])
    output_path = _output_path(params["output"])
    ensure_free_space(os.path.dirname(os.path.abspath(output_path)), original_size)
    images_changed = 0
    doc = src_mod.open_pdf(source["path"], source.get("password"))
    with doc, Staging(ctx.job_id) as staging:
        src_mod.require_permission(doc, source["path"], pymupdf.PDF_PERM_MODIFY)
        was_encrypted = bool((doc.metadata or {}).get("encryption"))
        page_count = doc.page_count
        temp = staging.temp_for(output_path)
        ctx.progress(0, 3, "Analysing document")
        ctx.check_cancelled()
        if mode == "rasterize":
            raster = _rasterize(doc, ctx)
            with raster:
                ctx.progress(2, 3, "Writing PDF")
                _save(raster, temp, garbage=4)
        else:
            save_options: dict[str, Any] = {
                "garbage": 4,
                "deflate_images": True,
                "deflate_fonts": True,
                "encryption": pymupdf.PDF_ENCRYPT_KEEP,
            }
            if mode in COMPRESS_PROFILES:
                before = _image_digests(doc)
                ctx.progress(1, 3, "Recompressing images")
                doc.rewrite_images(**COMPRESS_PROFILES[mode])
                after = _image_digests(doc)
                unchanged = set(before.values())
                images_changed = sum(1 for digest in after.values() if digest not in unchanged)
            ctx.check_cancelled()
            ctx.progress(2, 3, "Writing PDF")
            _save(doc, temp, **save_options)
        ctx.check_cancelled()
        verify_pdf(temp, page_count=page_count, password=source.get("password"))
        new_size = file_size(temp)
        result: dict[str, Any] = {
            "originalSize": original_size,
            "outputSize": new_size,
            "percentChange": round((new_size - original_size) / original_size * 100, 1)
            if original_size
            else 0,
            "imagesRecompressed": images_changed,
            "qualityReduced": mode == "rasterize" or images_changed > 0,
            "rasterized": mode == "rasterize",
            "wroteOutput": False,
            "outputs": [],
            "verified": True,
            "warnings": [],
        }
        if was_encrypted and mode != "rasterize":
            result["warnings"].append("The output keeps the source document's password protection.")
        if was_encrypted and mode == "rasterize":
            result["warnings"].append("Rasterising removes password protection from the output.")
        if new_size >= original_size:
            result["noImprovement"] = True
            return result  # Staging removes the temp file: never replace a file with a larger copy.
        staging.commit()
        result["wroteOutput"] = True
        result["outputs"] = [{"path": output_path, "pages": page_count, "sizeBytes": new_size}]
        return result


def _rasterize(doc: pymupdf.Document, ctx: JobContext, dpi: int = 150, quality: int = 70) -> pymupdf.Document:
    out = pymupdf.open()
    try:
        total = doc.page_count
        for index in range(total):
            ctx.check_cancelled()
            ctx.progress(index, total, f"Rasterising page {index + 1} of {total}")
            page = doc[index]
            rect = page.rect
            pix = page.get_pixmap(dpi=dpi, alpha=False)
            out.new_page(width=rect.width, height=rect.height)
            out[index].insert_image(
                pymupdf.Rect(0, 0, rect.width, rect.height),
                stream=pix.tobytes("jpeg", jpg_quality=quality),
                keep_proportion=False,
            )
        return out
    except Exception:
        out.close()
        raise


def pdf_to_images(params: dict[str, Any], ctx: JobContext) -> dict[str, Any]:
    source = params["source"]
    folder = params["folder"]
    extension = params["format"]
    dpi = params["dpi"]
    quality = params.get("jpegQuality") or 90
    base = safe_filename(params["baseName"])
    doc = src_mod.open_pdf(source["path"], source.get("password"))
    outputs: list[dict[str, Any]] = []
    taken: set[str] = set()
    with doc, Staging(ctx.job_id) as staging:
        src_mod.require_permission(doc, source["path"], pymupdf.PDF_PERM_COPY)
        pages = params["pages"]
        width = len(str(doc.page_count))
        pending: list[tuple[str, str, int]] = []
        for done, index in enumerate(pages):
            ctx.check_cancelled()
            ctx.progress(done, len(pages), f"Rendering page {index + 1}")
            if index >= doc.page_count:
                raise invalid_request(f"Page {index + 1} does not exist in this document.")
            page = doc[index]
            pixels = page.rect.width * page.rect.height * (dpi / 72) ** 2
            if pixels > 300_000_000:
                raise WorkerError(
                    "UNSUPPORTED",
                    f"Page {index + 1} would be over 300 megapixels at {dpi} DPI. Choose a lower resolution.",
                )
            name = f"{base}-page-{index + 1:0{width}d}.{extension}"
            final = resolve_collision(os.path.join(folder["path"], name), folder["overwrite"], taken)
            taken.add(os.path.normcase(final))
            pix = page.get_pixmap(dpi=dpi, alpha=False)
            data = pix.tobytes("png") if extension == "png" else pix.tobytes("jpeg", jpg_quality=quality)
            ensure_free_space(folder["path"], len(data))
            temp = staging.temp_for(final)
            try:
                with open(temp, "wb") as handle:
                    handle.write(data)
            except OSError as exc:
                raise from_os_error(exc, "output file") from exc
            pending.append((final, temp, len(data)))
        ctx.check_cancelled()
        staging.commit()
        for final, _temp, size in pending:
            outputs.append({"path": final, "pages": 1, "sizeBytes": size})
    return {"outputs": outputs, "verified": True, "warnings": []}


def images_to_pdf(params: dict[str, Any], ctx: JobContext) -> dict[str, Any]:
    output_path = _output_path(params["output"])
    images = params["images"]
    with SourcePool(params["sources"]) as pool:
        out = pymupdf.open()
        with out, Staging(ctx.job_id) as staging:
            for index, source_id in enumerate(images):
                ctx.check_cancelled()
                ctx.progress(index, len(images) + 1, f"Adding image {index + 1} of {len(images)}")
                add_image_page(out, pool.image(source_id), params["layout"])
            ctx.progress(len(images), len(images) + 1, "Writing PDF")
            temp = staging.temp_for(output_path)
            _save(out, temp)
            verify_pdf(temp, page_count=len(images))
            size = file_size(temp)
            staging.commit()
    return {
        "outputs": [{"path": output_path, "pages": len(images), "sizeBytes": size}],
        "verified": True,
        "warnings": [],
    }


def preview_images(params: dict[str, Any], _ctx: JobContext) -> dict[str, Any]:
    images = params["images"]
    index = params["previewIndex"]
    if index >= len(images):
        raise invalid_request("The preview page is outside the output.")
    with SourcePool(params["sources"]) as pool:
        out = pymupdf.open()
        with out:
            add_image_page(out, pool.image(images[index]), params["layout"])
            return _preview_png(out[0], params["maxSize"])


def _apply_to_doc(
    doc: pymupdf.Document,
    params: dict[str, Any],
    *,
    page_filter: int | None = None,
    on_page: Callable[[int, int], None] = lambda _d, _t: None,
) -> None:
    """Apply stamps. With ``page_filter``, ``doc`` holds just that page, for previewing."""
    image_paths = {s["id"]: s["path"] for s in params.get("imageSources") or []}
    full_count = params.get("_full_count", doc.page_count)

    def target_page(index: int) -> pymupdf.Page | None:
        if page_filter is None:
            if index >= doc.page_count:
                raise invalid_request(f"Page {index + 1} does not exist in this document.")
            return doc[index]
        return doc[0] if index == page_filter else None

    numbers = params.get("pageNumbers")
    watermark = params.get("watermark")
    overlays = params.get("overlays") or []
    number_map, last = stamps.page_number_map(numbers, full_count) if numbers else ({}, 0)
    watermark_pages = (
        set(watermark["pages"]) if watermark and watermark.get("pages") is not None else None
    )
    indices = range(full_count) if page_filter is None else [page_filter]
    total = len(indices)
    by_page: dict[int, list[dict[str, Any]]] = {}
    for overlay in overlays:
        by_page.setdefault(overlay["pageIndex"], []).append(overlay)
    for key in by_page:
        if key >= full_count:
            raise invalid_request(f"Page {key + 1} does not exist in this document.")
    for done, index in enumerate(indices):
        on_page(done, total)
        page = target_page(index)
        if page is None:
            continue
        if watermark and (watermark_pages is None or index in watermark_pages):
            stamps.add_watermark(page, watermark)
        for overlay in by_page.get(index, []):
            stamps.add_overlay(page, overlay, image_paths)
        if index in number_map:
            stamps.add_page_number(page, numbers, number_map[index], last)


def apply(params: dict[str, Any], ctx: JobContext) -> dict[str, Any]:
    source = params["source"]
    output_path = _output_path(params["output"])
    ensure_free_space(os.path.dirname(os.path.abspath(output_path)), file_size(source["path"]))
    doc = src_mod.open_pdf(source["path"], source.get("password"))
    with doc, Staging(ctx.job_id) as staging:
        src_mod.require_permission(doc, source["path"], pymupdf.PDF_PERM_MODIFY)
        page_count = doc.page_count
        was_encrypted = bool((doc.metadata or {}).get("encryption"))

        def on_page(done: int, total: int) -> None:
            ctx.check_cancelled()
            ctx.progress(done, total + 2, f"Updating page {done + 1} of {total}")

        _apply_to_doc(doc, params, on_page=on_page)
        if params.get("metadata"):
            apply_metadata(doc, params["metadata"])
        ctx.progress(page_count, page_count + 2, "Writing PDF")
        ctx.check_cancelled()
        texts = [(params.get("watermark") or {}).get("text", "")]
        texts += [o.get("text", "") for o in params.get("overlays") or []]
        if stamps.needs_font_subset(*texts):
            doc.subset_fonts()
        temp = staging.temp_for(output_path)
        _save(doc, temp, encryption=pymupdf.PDF_ENCRYPT_KEEP)
        ctx.progress(page_count + 1, page_count + 2, "Verifying output")
        verify_pdf(temp, page_count=page_count, password=source.get("password"))
        size = file_size(temp)
        staging.commit()
    warnings = []
    if was_encrypted:
        warnings.append("The output keeps the source document's password protection.")
    return {
        "outputs": [{"path": output_path, "pages": page_count, "sizeBytes": size}],
        "verified": True,
        "warnings": warnings,
    }


def preview_apply(params: dict[str, Any], _ctx: JobContext) -> dict[str, Any]:
    source = params["source"]
    index = params["previewIndex"]
    with src_mod.open_pdf(source["path"], source.get("password")) as doc:
        if index >= doc.page_count:
            raise invalid_request("The preview page is outside this document.")
        single = pymupdf.open()
        with single:
            single.insert_pdf(doc, from_page=index, to_page=index, links=False)
            scoped = {**params, "_full_count": doc.page_count}
            _apply_to_doc(single, scoped, page_filter=index)
            # Reload so transparency groups and new fonts render as they will after saving.
            reopened = pymupdf.open("pdf", single.tobytes())
            with reopened:
                return _preview_png(reopened[0], params["maxSize"])


def protect(params: dict[str, Any], ctx: JobContext) -> dict[str, Any]:
    source = params["source"]
    user_pw = params.get("userPassword")
    owner_pw = params.get("ownerPassword")
    permissions = params.get("permissions")
    if not user_pw and not owner_pw:
        raise invalid_request("Enter an open password or an owner password.")
    if permissions and not owner_pw:
        raise invalid_request("Restricting permissions needs an owner password.")
    if owner_pw and user_pw and owner_pw == user_pw and permissions:
        raise invalid_request(
            "The owner password must differ from the open password, or the restrictions have no effect."
        )
    output_path = _output_path(params["output"])
    doc = src_mod.open_pdf(source["path"], source.get("password"))
    with doc, Staging(ctx.job_id) as staging:
        if (doc.metadata or {}).get("encryption") and not src_mod.has_full_access(doc):
            raise WorkerError(
                "PERMISSION_DENIED",
                "This document's security settings can only be changed with its owner password.",
            )
        flag_map = {
            "print": pymupdf.PDF_PERM_PRINT,
            "printHighQuality": pymupdf.PDF_PERM_PRINT_HQ,
            "modify": pymupdf.PDF_PERM_MODIFY,
            "copy": pymupdf.PDF_PERM_COPY,
            "annotate": pymupdf.PDF_PERM_ANNOTATE,
            "fillForms": pymupdf.PDF_PERM_FORM,
            "assemble": pymupdf.PDF_PERM_ASSEMBLE,
        }
        flags = pymupdf.PDF_PERM_ACCESSIBILITY
        if permissions is None:
            flags = sum(flag_map.values()) + pymupdf.PDF_PERM_ACCESSIBILITY
        else:
            for key, flag in flag_map.items():
                if permissions.get(key):
                    flags |= flag
        ctx.progress(0, 2, "Encrypting with AES-256")
        temp = staging.temp_for(output_path)
        _save(
            doc,
            temp,
            encryption=pymupdf.PDF_ENCRYPT_AES_256,
            permissions=flags,
            user_pw=user_pw or "",
            owner_pw=owner_pw or user_pw,
        )
        ctx.check_cancelled()
        ctx.progress(1, 2, "Verifying output")
        check_pw = user_pw if user_pw else None
        count = verify_pdf(temp, page_count=doc.page_count, password=check_pw)
        with pymupdf.open(temp, filetype="pdf") as check:
            if user_pw and not check.needs_pass:
                raise WorkerError("VERIFY_FAILED", "The output was not protected as requested.")
            if user_pw:
                check.authenticate(user_pw)
            encryption = (check.metadata or {}).get("encryption") or ""
        if "AES" not in encryption:
            raise WorkerError("VERIFY_FAILED", "The output was not encrypted as requested.")
        size = file_size(temp)
        staging.commit()
    return {
        "outputs": [{"path": output_path, "pages": count, "sizeBytes": size}],
        "verified": True,
        "encryption": encryption,
        "warnings": [],
    }


def unprotect(params: dict[str, Any], ctx: JobContext) -> dict[str, Any]:
    source = params["source"]
    output_path = _output_path(params["output"])
    doc = src_mod.open_pdf(source["path"], source.get("password"))
    with doc, Staging(ctx.job_id) as staging:
        if not (doc.metadata or {}).get("encryption"):
            raise WorkerError("UNSUPPORTED", "This document is not encrypted, so there is nothing to remove.")
        if not src_mod.has_full_access(doc):
            raise WorkerError(
                "PERMISSION_DENIED",
                "Removing encryption from this document needs its owner password. "
                "The open password only grants the restricted access its owner chose.",
            )
        ctx.progress(0, 2, "Removing encryption")
        temp = staging.temp_for(output_path)
        _save(doc, temp, encryption=pymupdf.PDF_ENCRYPT_NONE)
        ctx.check_cancelled()
        ctx.progress(1, 2, "Verifying output")
        count = verify_pdf(temp, page_count=doc.page_count)
        with pymupdf.open(temp, filetype="pdf") as check:
            if check.needs_pass or (check.metadata or {}).get("encryption"):
                raise WorkerError("VERIFY_FAILED", "Encryption could not be removed.")
        size = file_size(temp)
        staging.commit()
    return {
        "outputs": [{"path": output_path, "pages": count, "sizeBytes": size}],
        "verified": True,
        "warnings": [],
    }


def extract_text(params: dict[str, Any], ctx: JobContext) -> dict[str, Any]:
    source = params["source"]
    pages_out: list[dict[str, Any]] = []
    with src_mod.open_pdf(source["path"], source.get("password")) as doc:
        src_mod.require_permission(doc, source["path"], pymupdf.PDF_PERM_COPY)
        pages = params["pages"]
        for done, index in enumerate(pages):
            ctx.check_cancelled()
            ctx.progress(done, len(pages), f"Reading page {index + 1}")
            if index >= doc.page_count:
                raise invalid_request(f"Page {index + 1} does not exist in this document.")
            page = doc[index]
            text = page.get_text("text").strip("\n")
            pages_out.append(
                {
                    "index": index,
                    "text": text,
                    "hasText": bool(text.strip()),
                    "hasImages": bool(page.get_images(full=False)),
                }
            )
    return {"pages": pages_out}


def save_text(params: dict[str, Any], ctx: JobContext) -> dict[str, Any]:
    output_path = _output_path(params["output"])
    data = params["text"].encode("utf-8")
    ensure_free_space(os.path.dirname(os.path.abspath(output_path)), len(data))
    with Staging(ctx.job_id) as staging:
        temp = staging.temp_for(output_path)
        try:
            with open(temp, "wb") as handle:
                handle.write(data)
        except OSError as exc:
            raise from_os_error(exc, "output file") from exc
        staging.commit()
    return {
        "outputs": [{"path": output_path, "pages": 0, "sizeBytes": len(data)}],
        "verified": True,
        "warnings": [],
    }


HANDLERS: dict[str, Callable[[dict[str, Any], JobContext], dict[str, Any]]] = {
    "probe": probe,
    "assemble": assemble,
    "preview_assemble": preview_assemble,
    "split": split,
    "compress": compress,
    "pdf_to_images": pdf_to_images,
    "images_to_pdf": images_to_pdf,
    "preview_images": preview_images,
    "apply": apply,
    "preview_apply": preview_apply,
    "protect": protect,
    "unprotect": unprotect,
    "extract_text": extract_text,
    "save_text": save_text,
}
