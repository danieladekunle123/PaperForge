from __future__ import annotations

import base64
import io
import os

import pymupdf
import pytest
from PIL import Image

from conftest import ink_bbox, page_labels, src, temp_files
from paperforge_worker.errors import WorkerError
from paperforge_worker.ops import (
    apply,
    compress,
    extract_text,
    images_to_pdf,
    pdf_to_images,
    preview_apply,
    preview_images,
    probe,
    protect,
    save_text,
    split,
    unprotect,
)


def output(path, policy="error") -> dict:
    return {"path": str(path), "overwrite": policy}


NUMBERS = {"position": "bottom-right", "start": 1, "fontSize": 12, "color": "#000000", "format": "n"}
WATERMARK = {
    "text": "DRAFT",
    "fontSize": 60,
    "color": "#000000",
    "opacity": 1.0,
    "rotation": 0,
    "position": "center",
    "layer": "foreground",
}


class TestSplit:
    def test_named_outputs_with_correct_pages(self, fx, tmp_path, ctx):
        result = split(
            {
                "source": src(fx["a"], "a"),
                "groups": [
                    {"name": "first.pdf", "pages": [0, 1, 2]},
                    {"name": "second", "pages": [3, 4]},
                ],
                "folder": output(tmp_path),
            },
            ctx,
        )
        assert [os.path.basename(o["path"]) for o in result["outputs"]] == ["first.pdf", "second.pdf"]
        assert page_labels(tmp_path / "first.pdf") == ["A-P1", "A-P2", "A-P3"]
        assert page_labels(tmp_path / "second.pdf") == ["A-P4", "A-P5"]
        assert temp_files(tmp_path) == []

    def test_collision_fails_before_any_output_appears(self, fx, tmp_path, ctx):
        (tmp_path / "b.pdf").write_bytes(b"existing")
        with pytest.raises(WorkerError) as err:
            split(
                {
                    "source": src(fx["a"], "a"),
                    "groups": [{"name": "a.pdf", "pages": [0]}, {"name": "b.pdf", "pages": [1]}],
                    "folder": output(tmp_path),
                },
                ctx,
            )
        assert err.value.code == "OUTPUT_EXISTS"
        assert not (tmp_path / "a.pdf").exists(), "split output is all-or-nothing"
        assert (tmp_path / "b.pdf").read_bytes() == b"existing"
        assert temp_files(tmp_path) == []

    def test_rename_policy_handles_duplicates_within_batch(self, fx, tmp_path, ctx):
        (tmp_path / "a.pdf").write_bytes(b"existing")
        result = split(
            {
                "source": src(fx["a"], "a"),
                "groups": [{"name": "a.pdf", "pages": [0]}, {"name": "a.pdf", "pages": [1]}],
                "folder": output(tmp_path, "rename"),
            },
            ctx,
        )
        names = [os.path.basename(o["path"]) for o in result["outputs"]]
        assert names == ["a (1).pdf", "a (2).pdf"]
        assert page_labels(tmp_path / "a (2).pdf") == ["A-P2"]

    @pytest.mark.parametrize("name", ["../escape.pdf", "a/b.pdf", "c:evil.pdf", "CON.pdf", "x?.pdf", "trail. "])
    def test_unsafe_names_rejected(self, fx, tmp_path, ctx, name):
        with pytest.raises(WorkerError) as err:
            split(
                {"source": src(fx["a"], "a"), "groups": [{"name": name, "pages": [0]}], "folder": output(tmp_path)},
                ctx,
            )
        assert err.value.code == "INVALID_REQUEST"

    def test_page_out_of_range(self, fx, tmp_path, ctx):
        with pytest.raises(WorkerError):
            split(
                {"source": src(fx["a"], "a"), "groups": [{"name": "x", "pages": [50]}], "folder": output(tmp_path)},
                ctx,
            )


class TestSecurity:
    def test_protect_requires_password_and_decrypts_with_it(self, fx, tmp_path, ctx):
        out = tmp_path / "locked.pdf"
        result = protect({"source": src(fx["a"], "a"), "userPassword": "s3cret", "output": output(out)}, ctx)
        assert "AES" in result["encryption"]
        with pymupdf.open(out) as doc:
            assert doc.needs_pass
            assert doc.authenticate("nope") == 0
            assert doc.authenticate("s3cret")
            assert doc.page_count == 5
            assert "256" in doc.metadata["encryption"]

    def test_permissions_applied_and_reported(self, fx, tmp_path, ctx):
        out = tmp_path / "perm.pdf"
        protect(
            {
                "source": src(fx["a"], "a"),
                "userPassword": "open",
                "ownerPassword": "owner",
                "permissions": {
                    "print": True,
                    "printHighQuality": False,
                    "modify": False,
                    "copy": False,
                    "annotate": False,
                    "fillForms": False,
                    "assemble": False,
                },
                "output": output(out),
            },
            ctx,
        )
        info = probe({"source": {**src(out), "password": "open", "kind": "pdf"}}, ctx)
        assert info["security"]["permissions"]["print"] is True
        assert info["security"]["permissions"]["copy"] is False
        assert info["security"]["fullAccess"] is False
        owner = probe({"source": {**src(out), "password": "owner", "kind": "pdf"}}, ctx)
        assert owner["security"]["fullAccess"] is True

    def test_restrictions_need_owner_password(self, fx, tmp_path, ctx):
        with pytest.raises(WorkerError):
            protect(
                {
                    "source": src(fx["a"], "a"),
                    "userPassword": "open",
                    "permissions": {
                        "print": True, "printHighQuality": True, "modify": False, "copy": False,
                        "annotate": False, "fillForms": False, "assemble": False,
                    },
                    "output": output(tmp_path / "x.pdf"),
                },
                ctx,
            )

    def test_unprotect_with_authorising_password(self, fx, tmp_path, ctx):
        out = tmp_path / "open.pdf"
        unprotect({"source": src(fx["enc_same"], "e", "both"), "output": output(out)}, ctx)
        with pymupdf.open(out) as doc:
            assert not doc.needs_pass
            assert doc.metadata.get("encryption") is None
            assert doc.page_count == 5

    def test_unprotect_owner_password(self, fx, tmp_path, ctx):
        out = tmp_path / "open.pdf"
        unprotect({"source": src(fx["enc_user"], "e", "owner-secret"), "output": output(out)}, ctx)
        assert page_labels(out)[0] == "A-P1"

    def test_user_password_cannot_remove_owner_restrictions(self, fx, tmp_path, ctx):
        with pytest.raises(WorkerError) as err:
            unprotect({"source": src(fx["enc_user"], "e", "open-me"), "output": output(tmp_path / "o.pdf")}, ctx)
        assert err.value.code == "PERMISSION_DENIED"
        assert not (tmp_path / "o.pdf").exists()

    def test_empty_user_password_restrictions_are_respected(self, fx, tmp_path, ctx):
        with pytest.raises(WorkerError) as err:
            unprotect({"source": src(fx["enc_owner_only"], "e"), "output": output(tmp_path / "o.pdf")}, ctx)
        assert err.value.code == "PERMISSION_DENIED"
        ok = tmp_path / "ok.pdf"
        unprotect({"source": src(fx["enc_owner_only"], "e", "owner-secret"), "output": output(ok)}, ctx)
        assert ok.exists()

    def test_wrong_owner_password_on_restricted_file_is_reported(self, fx, ctx):
        with pytest.raises(WorkerError) as err:
            probe({"source": {**src(fx["enc_owner_only"], "e", "not-it"), "kind": "pdf"}}, ctx)
        assert err.value.code == "WRONG_PASSWORD"
        ok = probe({"source": {**src(fx["enc_owner_only"], "e", "owner-secret"), "kind": "pdf"}}, ctx)
        assert ok["security"]["fullAccess"] is True

    def test_password_ignored_on_unencrypted_file(self, fx, ctx):
        info = probe({"source": {**src(fx["a"], "a", "whatever"), "kind": "pdf"}}, ctx)
        assert info["security"]["encrypted"] is False

    def test_wrong_and_missing_password(self, fx, ctx):
        for password, code in ((None, "PASSWORD_REQUIRED"), ("wrong", "WRONG_PASSWORD")):
            with pytest.raises(WorkerError) as err:
                probe({"source": {**src(fx["enc_user"], "e", password), "kind": "pdf"}}, ctx)
            assert err.value.code == code

    def test_permission_flags_block_assembly_and_text(self, fx, tmp_path, ctx):
        with pytest.raises(WorkerError) as err:
            extract_text({"source": src(fx["enc_user"], "e", "open-me"), "pages": [0]}, ctx)
        assert err.value.code == "PERMISSION_DENIED"
        with pytest.raises(WorkerError) as err:
            split(
                {
                    "source": src(fx["enc_user"], "e", "open-me"),
                    "groups": [{"name": "x", "pages": [0]}],
                    "folder": output(tmp_path),
                },
                ctx,
            )
        assert err.value.code == "PERMISSION_DENIED"
        extract_text({"source": src(fx["enc_user"], "e", "owner-secret"), "pages": [0]}, ctx)

    def test_password_never_appears_in_error_messages(self, fx, ctx):
        with pytest.raises(WorkerError) as err:
            probe({"source": {**src(fx["enc_user"], "e", "hunter2secret"), "kind": "pdf"}}, ctx)
        assert "hunter2secret" not in err.value.message


class TestCompress:
    def test_balanced_reduces_image_data_keeps_text(self, fx, tmp_path, ctx):
        out = tmp_path / "balanced.pdf"
        result = compress({"source": src(fx["heavy"]), "mode": "balanced", "output": output(out)}, ctx)
        assert result["wroteOutput"] is True
        assert result["outputSize"] < result["originalSize"]
        assert result["percentChange"] < 0
        assert result["qualityReduced"] is True
        assert result["imagesRecompressed"] >= 1
        with pymupdf.open(out) as doc:
            assert "HEAVY text remains selectable" in doc[0].get_text()

    def test_strong_is_smaller_than_balanced(self, fx, tmp_path, ctx):
        a = compress({"source": src(fx["heavy"]), "mode": "balanced", "output": output(tmp_path / "b.pdf")}, ctx)
        b = compress({"source": src(fx["heavy"]), "mode": "strong", "output": output(tmp_path / "s.pdf")}, ctx)
        assert b["outputSize"] < a["outputSize"]

    def test_lossless_never_reports_quality_loss(self, fx, tmp_path, ctx):
        result = compress({"source": src(fx["heavy"]), "mode": "lossless", "output": output(tmp_path / "l.pdf")}, ctx)
        assert result["qualityReduced"] is False
        assert result["imagesRecompressed"] == 0

    def test_transparency_survives_recompression(self, fx, tmp_path, ctx):
        out = tmp_path / "alpha.pdf"
        compress({"source": src(fx["alpha"]), "mode": "strong", "output": output(out)}, ctx)
        with pymupdf.open(out) as doc:
            pix = doc[0].get_pixmap(dpi=72, alpha=False)
            left = pix.pixel(100, 200)
            right = pix.pixel(300, 200)
            assert left == (255, 0, 0), "the transparent half still shows the red background"
            assert right != (255, 0, 0)

    def test_no_output_when_it_would_not_shrink(self, fx, tmp_path, ctx):
        out = tmp_path / "tiny-out.pdf"
        result = compress({"source": src(fx["tiny"]), "mode": "lossless", "output": output(out)}, ctx)
        assert result["noImprovement"] is True
        assert result["wroteOutput"] is False
        assert result["outputs"] == []
        assert not out.exists()
        assert temp_files(tmp_path) == []

    def test_rasterize_flags_loss_of_text(self, fx, tmp_path, ctx):
        out = tmp_path / "raster.pdf"
        result = compress({"source": src(fx["heavy"]), "mode": "rasterize", "output": output(out)}, ctx)
        assert result["rasterized"] is True
        assert result["qualityReduced"] is True
        with pymupdf.open(out) as doc:
            assert doc[0].get_text().strip() == ""

    def test_encrypted_source_stays_protected(self, fx, tmp_path, ctx):
        out = tmp_path / "enc.pdf"
        source = tmp_path / "enc-heavy.pdf"
        with pymupdf.open(fx["heavy"]) as doc:
            doc.save(source, encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="pw", owner_pw="pw")
        result = compress({"source": src(source, "s", "pw"), "mode": "balanced", "output": output(out)}, ctx)
        assert result["wroteOutput"]
        with pymupdf.open(out) as doc:
            assert doc.needs_pass


class TestImages:
    def test_pdf_to_png_and_jpg_at_resolution(self, fx, tmp_path, ctx):
        result = pdf_to_images(
            {
                "source": src(fx["a"]),
                "pages": [0, 2],
                "format": "png",
                "dpi": 144,
                "baseName": "doc",
                "folder": output(tmp_path),
            },
            ctx,
        )
        assert [os.path.basename(o["path"]) for o in result["outputs"]] == ["doc-page-1.png", "doc-page-3.png"]
        with Image.open(tmp_path / "doc-page-1.png") as image:
            assert image.size == (1190, 1684)
        pdf_to_images(
            {
                "source": src(fx["a"]),
                "pages": [1],
                "format": "jpg",
                "dpi": 72,
                "jpegQuality": 80,
                "baseName": "j",
                "folder": output(tmp_path),
            },
            ctx,
        )
        with Image.open(tmp_path / "j-page-2.jpg") as image:
            assert image.format == "JPEG"

    def test_images_to_pdf_layouts(self, fx, tmp_path, ctx):
        out = tmp_path / "imgs.pdf"
        result = images_to_pdf(
            {
                "sources": [src(fx["png"], "p"), src(fx["jpg"], "j")],
                "images": ["j", "p", "j"],
                "layout": {"pageSize": "A4", "orientation": "portrait", "marginPt": 36, "fit": "contain"},
                "output": output(out),
            },
            ctx,
        )
        assert result["outputs"][0]["pages"] == 3
        with pymupdf.open(out) as doc:
            assert doc.page_count == 3
            page = doc[0]
            assert abs(page.rect.width - 595.28) < 0.1 and page.rect.height > page.rect.width
            image_rect = page.get_image_rects(page.get_images()[0][0])[0]
            assert abs(image_rect.x0 - 36) < 0.5 and abs(image_rect.x1 - (page.rect.width - 36)) < 0.5
            assert abs(image_rect.width / image_rect.height - 1.5) < 0.01, "aspect ratio preserved"

    def test_image_page_size_matches_image(self, fx, tmp_path, ctx):
        out = tmp_path / "natural.pdf"
        images_to_pdf(
            {
                "sources": [src(fx["png"], "p")],
                "images": ["p"],
                "layout": {"pageSize": "image", "orientation": "auto", "marginPt": 0, "fit": "contain"},
                "output": output(out),
            },
            ctx,
        )
        with pymupdf.open(out) as doc:
            assert abs(doc[0].rect.width - 150) < 0.5  # 200 px at 96 DPI

    def test_cover_fills_margin_box_exactly(self, fx, tmp_path, ctx):
        out = tmp_path / "cover.pdf"
        images_to_pdf(
            {
                "sources": [src(fx["png"], "p")],
                "images": ["p"],
                "layout": {"pageSize": "A4", "orientation": "portrait", "marginPt": 20, "fit": "cover"},
                "output": output(out),
            },
            ctx,
        )
        with pymupdf.open(out) as doc:
            rect = doc[0].get_image_rects(doc[0].get_images()[0][0])[0]
            assert abs(rect.x0 - 20) < 0.5 and abs(rect.y0 - 20) < 0.5
            assert abs(rect.y1 - (doc[0].rect.height - 20)) < 0.5

    def test_preview_images(self, fx, ctx):
        result = preview_images(
            {
                "sources": [src(fx["png"], "p")],
                "images": ["p"],
                "layout": {"pageSize": "Letter", "orientation": "auto", "marginPt": 10, "fit": "contain"},
                "previewIndex": 0,
                "maxSize": 300,
            },
            ctx,
        )
        assert result["width"] == 300

    def test_corrupt_image_reports(self, fx, tmp_path, ctx):
        with pytest.raises(WorkerError) as err:
            images_to_pdf(
                {
                    "sources": [src(fx["truncated_png"], "b")],
                    "images": ["b"],
                    "layout": {"pageSize": "A4", "orientation": "auto", "marginPt": 0, "fit": "contain"},
                    "output": output(tmp_path / "o.pdf"),
                },
                ctx,
            )
        assert err.value.code == "INVALID_FILE"
        assert temp_files(tmp_path) == []


class TestStamps:
    @pytest.mark.parametrize("rotation", [0, 90, 180, 270])
    def test_page_numbers_appear_in_visual_corner_on_rotated_pages(self, tmp_path, ctx, rotation):
        source = tmp_path / "r.pdf"
        doc = pymupdf.open()
        doc.new_page(width=300, height=500)
        doc[0].set_rotation(rotation)
        doc.save(source)
        doc.close()
        out = tmp_path / "o.pdf"
        apply({"source": src(source), "pageNumbers": NUMBERS, "output": output(out)}, ctx)
        with pymupdf.open(out) as result:
            page = result[0]
            bbox = ink_bbox(page)
            assert bbox is not None
            assert bbox[2] > page.rect.width * 0.8, "number is at the visual right"
            assert bbox[3] > page.rect.height * 0.85, "number is at the visual bottom"
            assert bbox[3] - bbox[1] < 20 and bbox[2] - bbox[0] < 20, "text is upright and small"

    def test_page_numbers_on_cropped_page_sit_inside_crop(self, fx, tmp_path, ctx):
        out = tmp_path / "o.pdf"
        blank = tmp_path / "blankcrop.pdf"
        doc = pymupdf.open()
        doc.new_page(width=500, height=500)
        doc[0].set_cropbox(pymupdf.Rect(100, 100, 400, 300))
        doc.save(blank)
        doc.close()
        apply(
            {"source": src(blank), "pageNumbers": {**NUMBERS, "position": "top-left"}, "output": output(out)},
            ctx,
        )
        with pymupdf.open(out) as result:
            bbox = ink_bbox(result[0])
            assert bbox[0] < 40 and bbox[1] < 40

    def test_formats_ranges_and_start(self, fx, tmp_path, ctx):
        out = tmp_path / "o.pdf"
        apply(
            {
                "source": src(fx["a"]),
                "pageNumbers": {**NUMBERS, "format": "n_of_total", "start": 10, "pages": [1, 3]},
                "output": output(out),
            },
            ctx,
        )
        with pymupdf.open(out) as doc:
            assert "10 of 11" in doc[1].get_text()
            assert "11 of 11" in doc[3].get_text()
            assert " of " not in doc[0].get_text()
        out2 = tmp_path / "o2.pdf"
        apply({"source": src(fx["a"]), "pageNumbers": {**NUMBERS, "format": "page_n"}, "output": output(out2)}, ctx)
        with pymupdf.open(out2) as doc:
            assert "Page 5" in doc[4].get_text()

    def test_number_colour_applied(self, tmp_path, ctx):
        source = tmp_path / "b.pdf"
        doc = pymupdf.open()
        doc.new_page(width=200, height=200)
        doc.save(source)
        doc.close()
        out = tmp_path / "o.pdf"
        apply(
            {
                "source": src(source),
                "pageNumbers": {**NUMBERS, "color": "#ff0000", "fontSize": 40, "format": "page_n", "position": "top-left"},
                "output": output(out),
            },
            ctx,
        )
        with pymupdf.open(out) as result:
            pix = result[0].get_pixmap(dpi=72, alpha=False)
            pixels = {pix.pixel(x, y) for x in range(0, 200, 2) for y in range(0, 100, 2)}
            assert any(p[0] > 200 and p[1] < 80 and p[2] < 80 for p in pixels)

    @pytest.mark.parametrize("rotation", [0, 90, 180, 270])
    def test_watermark_centred_on_visual_page(self, tmp_path, ctx, rotation):
        source = tmp_path / "r.pdf"
        doc = pymupdf.open()
        doc.new_page(width=400, height=600)
        doc[0].set_rotation(rotation)
        doc.save(source)
        doc.close()
        out = tmp_path / "o.pdf"
        apply({"source": src(source), "watermark": WATERMARK, "output": output(out)}, ctx)
        with pymupdf.open(out) as result:
            page = result[0]
            bbox = ink_bbox(page)
            cx, cy = (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2
            assert abs(cx - page.rect.width / 2) < 12
            assert abs(cy - page.rect.height / 2) < 12
            assert bbox[2] - bbox[0] > bbox[3] - bbox[1], "unrotated watermark reads horizontally"

    def test_watermark_rotation_opacity_and_page_selection(self, fx, tmp_path, ctx):
        out = tmp_path / "o.pdf"
        apply(
            {
                "source": src(fx["a"]),
                "watermark": {**WATERMARK, "rotation": 45, "opacity": 0.2, "pages": [1]},
                "output": output(out),
            },
            ctx,
        )
        with pymupdf.open(out) as doc:
            assert "DRAFT" in doc[1].get_text()
            assert "DRAFT" not in doc[0].get_text()
            pix = doc[1].get_pixmap(dpi=72, alpha=False)
            darkest = min(
                pix.pixel(x, y)[0]
                for x in range(150, 450, 3)
                for y in range(350, 500, 3)
            )
            assert 150 < darkest < 255, "20% opacity black is a light grey"

    def test_background_watermark_sits_behind_content(self, tmp_path, ctx):
        source = tmp_path / "opaque.pdf"
        doc = pymupdf.open()
        doc.new_page(width=400, height=400)
        doc[0].draw_rect(doc[0].rect, fill=(1, 1, 1), color=None)
        doc.save(source)
        doc.close()
        back = tmp_path / "back.pdf"
        front = tmp_path / "front.pdf"
        apply({"source": src(source), "watermark": {**WATERMARK, "layer": "background"}, "output": output(back)}, ctx)
        apply({"source": src(source), "watermark": WATERMARK, "output": output(front)}, ctx)
        with pymupdf.open(back) as doc:
            assert ink_bbox(doc[0]) is None, "opaque content covers a background watermark"
        with pymupdf.open(front) as doc:
            assert ink_bbox(doc[0]) is not None

    def test_unicode_watermark_embedded_and_subset(self, fx, tmp_path, ctx):
        out = tmp_path / "o.pdf"
        apply({"source": src(fx["a"]), "watermark": {**WATERMARK, "text": "機密 Секрет"}, "output": output(out)}, ctx)
        with pymupdf.open(out) as doc:
            assert "機密" in doc[0].get_text()
            assert "Секрет" in doc[0].get_text()
        assert out.stat().st_size < 400_000, "the fallback font must be subset"

    def test_unsupported_script_is_refused_not_silently_replaced(self, fx, tmp_path, ctx):
        with pytest.raises(WorkerError) as err:
            apply(
                {"source": src(fx["a"]), "watermark": {**WATERMARK, "text": "שלום"}, "output": output(tmp_path / "o.pdf")},
                ctx,
            )
        assert err.value.code == "UNSUPPORTED"

    @pytest.mark.parametrize("rotation", [0, 90, 180, 270])
    def test_signature_placement_matches_preview_coordinates(self, tmp_path, ctx, rotation):
        """A half-black, half-white image at a normalised rect must land exactly there, upright."""
        source = tmp_path / "r.pdf"
        doc = pymupdf.open()
        doc.new_page(width=300, height=500)
        doc[0].set_rotation(rotation)
        doc.save(source)
        doc.close()
        image = Image.new("RGB", (40, 20), "white")
        image.paste((0, 0, 0), (0, 0, 20, 20))
        buf = io.BytesIO()
        image.save(buf, "PNG")
        out = tmp_path / "o.pdf"
        with pymupdf.open(source) as check:
            w, h = check[0].rect.width, check[0].rect.height
        overlay = {
            "kind": "image",
            "pageIndex": 0,
            "x": 20 / w,
            "y": 30 / h,
            "w": 80 / w,
            "h": 40 / h,
            "pngBase64": base64.b64encode(buf.getvalue()).decode(),
        }
        apply({"source": src(source), "overlays": [overlay], "output": output(out)}, ctx)
        with pymupdf.open(out) as result:
            bbox = ink_bbox(result[0])
            assert abs(bbox[0] - 20) <= 1 and abs(bbox[1] - 30) <= 1
            assert abs(bbox[2] - 60) <= 1, "left half is black: image is upright, not mirrored or turned"
            assert abs(bbox[3] - 70) <= 1

    def test_signature_with_crop_and_rotation(self, tmp_path, ctx):
        source = tmp_path / "cr.pdf"
        doc = pymupdf.open()
        doc.new_page(width=500, height=500)
        doc[0].set_cropbox(pymupdf.Rect(100, 100, 400, 300))
        doc[0].set_rotation(90)
        doc.save(source)
        doc.close()
        image = Image.new("RGB", (20, 20), "black")
        buf = io.BytesIO()
        image.save(buf, "PNG")
        out = tmp_path / "o.pdf"
        with pymupdf.open(source) as check:
            w, h = check[0].rect.width, check[0].rect.height
        apply(
            {
                "source": src(source),
                "overlays": [
                    {
                        "kind": "image", "pageIndex": 0, "x": 10 / w, "y": 20 / h, "w": 30 / w, "h": 30 / h,
                        "pngBase64": base64.b64encode(buf.getvalue()).decode(),
                    }
                ],
                "output": output(out),
            },
            ctx,
        )
        with pymupdf.open(out) as result:
            bbox = ink_bbox(result[0])
            assert abs(bbox[0] - 10) <= 1 and abs(bbox[1] - 20) <= 1
            assert abs(bbox[2] - 40) <= 1 and abs(bbox[3] - 50) <= 1

    @pytest.mark.parametrize("rotation", [90, 180, 270])
    def test_text_stamps_on_cropped_rotated_page(self, tmp_path, ctx, rotation):
        source = tmp_path / "cr.pdf"
        doc = pymupdf.open()
        doc.new_page(width=500, height=400)
        doc[0].set_cropbox(pymupdf.Rect(100, 50, 400, 250))
        doc[0].set_rotation(rotation)
        doc.save(source)
        doc.close()
        out = tmp_path / "o.pdf"
        apply({"source": src(source), "pageNumbers": NUMBERS, "output": output(out)}, ctx)
        with pymupdf.open(out) as result:
            page = result[0]
            bbox = ink_bbox(page)
            assert bbox[2] > page.rect.width * 0.8 and bbox[3] > page.rect.height * 0.8
            assert bbox[3] - bbox[1] < 20

    def test_imported_signature_with_white_knockout(self, fx, tmp_path, ctx):
        white = tmp_path / "white.png"
        image = Image.new("RGB", (40, 20), "white")
        image.paste((0, 0, 0), (0, 0, 10, 20))
        image.save(white)
        base = tmp_path / "base.pdf"
        doc = pymupdf.open()
        doc.new_page(width=200, height=200)
        doc[0].draw_rect(doc[0].rect, fill=(1, 0, 0), color=None)
        doc.save(base)
        doc.close()
        out = tmp_path / "o.pdf"
        apply(
            {
                "source": src(base),
                "imageSources": [src(white, "sig")],
                "overlays": [
                    {
                        "kind": "image", "pageIndex": 0, "x": 0, "y": 0, "w": 1, "h": 0.5,
                        "imageSourceId": "sig", "knockoutWhite": True,
                    }
                ],
                "output": output(out),
            },
            ctx,
        )
        with pymupdf.open(out) as result:
            pix = result[0].get_pixmap(dpi=72, alpha=False)
            assert pix.pixel(150, 50) == (255, 0, 0), "white became transparent"
            assert pix.pixel(10, 50)[0] < 60, "ink stays"

    def test_text_annotation_lands_where_placed(self, tmp_path, ctx):
        source = tmp_path / "r.pdf"
        doc = pymupdf.open()
        doc.new_page(width=300, height=500)
        doc[0].set_rotation(90)
        doc.save(source)
        doc.close()
        out = tmp_path / "o.pdf"
        apply(
            {
                "source": src(source),
                "overlays": [
                    {
                        "kind": "text", "pageIndex": 0, "x": 0.5, "y": 0.5, "text": "Hi\nThere",
                        "fontSize": 14, "color": "#000000",
                    }
                ],
                "output": output(out),
            },
            ctx,
        )
        with pymupdf.open(out) as result:
            page = result[0]
            bbox = ink_bbox(page)
            assert abs(bbox[0] - page.rect.width / 2) <= 3
            assert abs(bbox[1] - page.rect.height / 2) <= 6
            assert "There" in page.get_text()

    def test_preview_matches_applied_output(self, fx, tmp_path, ctx):
        params = {"source": src(fx["mixed"]), "watermark": WATERMARK, "pageNumbers": NUMBERS}
        preview = preview_apply({**params, "previewIndex": 2, "maxSize": 500}, ctx)
        out = tmp_path / "o.pdf"
        apply({**params, "output": output(out)}, ctx)
        with pymupdf.open(out) as doc:
            page = doc[2]
            scale = 500 / max(page.rect.width, page.rect.height)
            pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
        decoded = Image.open(io.BytesIO(base64.b64decode(preview["pngBase64"]))).convert("RGB")
        applied = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        assert decoded.size == applied.size
        diff = Image.eval(Image.blend(decoded, Image.eval(applied, lambda v: 255 - v), 0.5).convert("L"), lambda v: abs(v - 127))
        assert diff.getextrema()[1] < 40, "preview and exported page render the same"


class TestTextAndInfo:
    def test_extract_text_flags_empty_pages(self, fx, ctx):
        result = extract_text({"source": src(fx["mixed_text"]), "pages": [0, 1, 2]}, ctx)
        pages = result["pages"]
        assert "Héllo wörld" in pages[0]["text"] and pages[0]["hasText"]
        assert pages[1]["hasText"] is False and pages[1]["hasImages"] is True
        assert pages[2]["hasText"] is False and pages[2]["hasImages"] is False

    def test_save_text_utf8(self, tmp_path, ctx):
        out = tmp_path / "t é.txt"
        save_text({"text": "héllo 文档\n", "output": output(out)}, ctx)
        assert out.read_bytes().decode("utf-8") == "héllo 文档\n"
        assert temp_files(tmp_path) == []

    def test_probe_reports_facts(self, fx, ctx):
        info = probe({"source": {**src(fx["rich"]), "kind": "pdf"}}, ctx)
        assert info["pageCount"] == 4
        assert info["metadata"]["title"] == "Rich Title"
        assert info["metadata"]["author"] == "Test Author"
        assert info["features"]["tocEntries"] == 4
        assert info["features"]["attachments"] == 1
        assert info["features"]["annotationPages"] == 1
        assert info["features"]["signed"] is False
        assert info["security"]["encrypted"] is False
        form = probe({"source": {**src(fx["form"]), "kind": "pdf"}}, ctx)
        assert form["features"]["isForm"] is True

    def test_probe_detects_signed_xfa_and_scripted_documents(self, fx, tmp_path, ctx):
        source = tmp_path / "special.pdf"
        with pymupdf.open(fx["form"]) as doc:
            catalog = doc.pdf_catalog()
            doc.xref_set_key(catalog, "AcroForm/SigFlags", "3")
            doc.xref_set_key(catalog, "AcroForm/XFA", "[(template) 1 0 R]")
            doc.xref_set_key(catalog, "OpenAction", "<</S/JavaScript/JS(1)>>")
            doc.save(source)
        features = probe({"source": {**src(source), "kind": "pdf"}}, ctx)["features"]
        assert features["signed"] is True
        assert features["xfa"] is True
        assert features["javascript"] is True
        plain = probe({"source": {**src(fx["a"]), "kind": "pdf"}}, ctx)["features"]
        assert plain["signed"] is False and plain["xfa"] is False and plain["javascript"] is False

    def test_whole_document_tools_keep_encryption_and_structure(self, fx, tmp_path, ctx):
        source = tmp_path / "enc-rich.pdf"
        with pymupdf.open(fx["rich"]) as doc:
            doc.save(source, encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="pw", owner_pw="pw")
        out = tmp_path / "o.pdf"
        result = apply({"source": src(source, "s", "pw"), "pageNumbers": NUMBERS, "output": output(out)}, ctx)
        assert any("password protection" in warning for warning in result["warnings"])
        with pymupdf.open(out) as doc:
            assert doc.needs_pass
            assert doc.authenticate("pw")
            assert doc.get_toc(simple=True)
            assert doc.embfile_count() == 1
            assert doc[0].get_links()
            assert doc[1].first_annot is not None

    def test_probe_page_dimensions_are_visual(self, fx, ctx):
        info = probe({"source": {**src(fx["mixed"]), "kind": "pdf"}}, ctx)
        assert info["pages"][2] == {"width": 500.0, "height": 300.0, "rotation": 90}
        crop = probe({"source": {**src(fx["crop"]), "kind": "pdf"}}, ctx)
        assert crop["pages"][0]["width"] == 300

    def test_probe_image(self, fx, ctx):
        info = probe({"source": {**src(fx["jpg_exif"]), "kind": "image"}}, ctx)
        assert info["image"]["width"] == 200 and info["image"]["height"] == 300

    def test_metadata_edit_and_strip(self, fx, tmp_path, ctx):
        edited = tmp_path / "e.pdf"
        apply(
            {"source": src(fx["rich"]), "metadata": {"mode": "edit", "title": "New", "keywords": ""}, "output": output(edited)},
            ctx,
        )
        with pymupdf.open(edited) as doc:
            assert doc.metadata["title"] == "New"
            assert doc.metadata["author"] == "Test Author"
            assert doc.metadata["keywords"] == ""
            assert doc.get_toc(simple=True), "other structures remain"
            assert doc.embfile_count() == 1
        stripped = tmp_path / "s.pdf"
        apply({"source": src(fx["rich"]), "metadata": {"mode": "strip"}, "output": output(stripped)}, ctx)
        with pymupdf.open(stripped) as doc:
            assert not doc.metadata["title"] and not doc.metadata["author"]
            assert not doc.get_xml_metadata()

    @pytest.mark.parametrize("key", ["garbage", "empty_pdf"])
    def test_malformed_input(self, fx, ctx, key):
        with pytest.raises(WorkerError) as err:
            probe({"source": {**src(fx[key]), "kind": "pdf"}}, ctx)
        assert err.value.code == "INVALID_FILE"

    def test_source_released_after_error(self, fx, tmp_path, ctx):
        """On Windows an unclosed document would keep the user's file locked."""
        copy = tmp_path / "copy.pdf"
        copy.write_bytes(fx["enc_user"].read_bytes())
        with pytest.raises(WorkerError):
            probe({"source": {**src(copy, "c", "wrong"), "kind": "pdf"}}, ctx)
        copy.unlink()
