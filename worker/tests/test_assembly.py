from __future__ import annotations

import shutil

import pymupdf
import pytest

from conftest import ink_bbox, page_labels, src, temp_files
from paperforge_worker.errors import WorkerError
from paperforge_worker.ops import assemble, preview_assemble

OPTIONS = {"pageSizing": "preserve", "fitSize": "A4", "blankSize": "A4", "imageFit": "contain"}


def pdf_page(source_id: str, index: int, rotation: int = 0) -> dict:
    return {"kind": "pdf", "sourceId": source_id, "pageIndex": index, "rotation": rotation}


def output(path) -> dict:
    return {"path": str(path), "overwrite": "error"}


def test_user_journey_two_pdfs_three_images_rotation_numbers(fx, tmp_path, ctx):
    out = tmp_path / "journey.pdf"
    params = {
        "sources": [
            src(fx["a"], "a"),
            src(fx["b"], "b"),
            src(fx["png"], "png"),
            src(fx["jpg"], "jpg"),
            src(fx["jpg_exif"], "exif"),
        ],
        "pages": [
            pdf_page("a", 0),
            pdf_page("a", 1),
            {"kind": "image", "sourceId": "png", "rotation": 0},
            pdf_page("a", 2, rotation=90),
            {"kind": "image", "sourceId": "jpg", "rotation": 0},
            pdf_page("b", 6),
            {"kind": "image", "sourceId": "exif", "rotation": 0},
        ],
        "options": {
            **OPTIONS,
            "pageNumbers": {
                "position": "bottom-center",
                "start": 1,
                "fontSize": 11,
                "color": "#000000",
                "format": "n_of_total",
            },
        },
        "output": output(out),
    }
    result = assemble(params, ctx)
    assert result["verified"] is True
    assert result["outputs"][0]["pages"] == 7
    with pymupdf.open(out) as doc:
        assert doc.page_count == 7
        assert doc[3].rotation == 90
        assert "A-P1" in doc[0].get_text()
        assert "A-P3" in doc[3].get_text()
        assert "B-P7" in doc[5].get_text()
        for i in range(7):
            assert f"{i + 1} of 7" in doc[i].get_text(), f"page {i + 1} lacks its number"
        # Text stayed text: a labelled PDF page has no images after merging.
        assert doc[0].get_images() == []
        assert len(doc[2].get_images()) == 1
    assert temp_files(tmp_path) == []


def test_order_duplicates_and_blank_pages(fx, tmp_path, ctx):
    out = tmp_path / "order.pdf"
    assemble(
        {
            "sources": [src(fx["a"], "a")],
            "pages": [
                pdf_page("a", 4),
                pdf_page("a", 0),
                {"kind": "blank", "rotation": 0},
                pdf_page("a", 0),
                pdf_page("a", 2),
            ],
            "options": {**OPTIONS, "blankSize": "Letter"},
            "output": output(out),
        },
        ctx,
    )
    assert page_labels(out) == ["A-P5", "A-P1", "", "A-P1", "A-P3"]
    with pymupdf.open(out) as doc:
        assert (doc[2].rect.width, doc[2].rect.height) == (612, 792)


def test_duplicate_pages_do_not_duplicate_resources(fx, tmp_path, ctx):
    one = tmp_path / "one.pdf"
    many = tmp_path / "many.pdf"
    base = {"sources": [src(fx["heavy"], "h")], "options": OPTIONS}
    assemble({**base, "pages": [pdf_page("h", 0)], "output": output(one)}, ctx)
    assemble({**base, "pages": [pdf_page("h", 0)] * 4, "output": output(many)}, ctx)
    assert many.stat().st_size < one.stat().st_size * 1.2


def test_long_documents_assemble_in_linear_time(tmp_path, ctx):
    """Copying pages one at a time must not rescan the whole source on every call."""
    import random
    import time

    source = tmp_path / "long.pdf"
    doc = pymupdf.open()
    for i in range(1500):
        doc.new_page(width=200, height=200)
        doc[i].insert_text((10, 30), f"LONG-P{i + 1}")
    doc.save(source, garbage=3, deflate=True)
    doc.close()
    order = list(range(1500))
    random.Random(4).shuffle(order)
    out = tmp_path / "o.pdf"
    started = time.monotonic()
    assemble(
        {
            "sources": [src(source, "s")],
            "pages": [pdf_page("s", i) for i in order],
            "options": OPTIONS,
            "output": output(out),
        },
        ctx,
    )
    assert time.monotonic() - started < 20, "this took over 100 seconds with the quadratic behaviour"
    with pymupdf.open(out) as result:
        assert result[0].get_text().strip() == f"LONG-P{order[0] + 1}"
        assert result[1499].get_text().strip() == f"LONG-P{order[1499] + 1}"


def test_sources_are_unchanged(fx, tmp_path, ctx):
    before = fx["rich"].read_bytes()
    assemble(
        {
            "sources": [src(fx["rich"], "r")],
            "pages": [pdf_page("r", 2, rotation=90), pdf_page("r", 0)],
            "options": OPTIONS,
            "output": output(tmp_path / "x.pdf"),
        },
        ctx,
    )
    assert fx["rich"].read_bytes() == before


def test_mixed_sizes_and_rotations_preserved(fx, tmp_path, ctx):
    out = tmp_path / "mixed.pdf"
    assemble(
        {
            "sources": [src(fx["mixed"], "m")],
            "pages": [pdf_page("m", i) for i in range(5)],
            "options": OPTIONS,
            "output": output(out),
        },
        ctx,
    )
    with pymupdf.open(fx["mixed"]) as source, pymupdf.open(out) as doc:
        for a, b in zip(source, doc):
            assert a.rotation == b.rotation
            assert a.rect == b.rect
            assert a.mediabox == b.mediabox


def test_added_rotation_combines_with_existing(fx, tmp_path, ctx):
    out = tmp_path / "rot.pdf"
    assemble(
        {
            "sources": [src(fx["mixed"], "m")],
            "pages": [pdf_page("m", 2, rotation=90), pdf_page("m", 4, rotation=180)],
            "options": OPTIONS,
            "output": output(out),
        },
        ctx,
    )
    with pymupdf.open(out) as doc:
        assert doc[0].rotation == 180
        assert doc[1].rotation == 90


def test_crop_box_preserved(fx, tmp_path, ctx):
    out = tmp_path / "crop.pdf"
    assemble(
        {"sources": [src(fx["crop"], "c")], "pages": [pdf_page("c", 0)], "options": OPTIONS, "output": output(out)},
        ctx,
    )
    with pymupdf.open(out) as doc:
        assert doc[0].cropbox == pymupdf.Rect(100, 100, 400, 300)
        assert doc[0].mediabox == pymupdf.Rect(0, 0, 500, 500)
        assert (doc[0].rect.width, doc[0].rect.height) == (300, 200)


def test_fit_mode_scales_without_rasterising(fx, tmp_path, ctx):
    out = tmp_path / "fit.pdf"
    assemble(
        {
            "sources": [src(fx["mixed"], "m"), src(fx["crop"], "c")],
            "pages": [pdf_page("m", 1), pdf_page("m", 2), pdf_page("c", 0), {"kind": "blank", "rotation": 0}],
            "options": {**OPTIONS, "pageSizing": "fit", "fitSize": "Letter"},
            "output": output(out),
        },
        ctx,
    )
    with pymupdf.open(out) as doc:
        assert (doc[0].rect.width, doc[0].rect.height) == (792, 612)  # landscape source
        assert (doc[1].rect.width, doc[1].rect.height) == (792, 612)  # 300x500 rotated 90 is landscape
        assert (doc[2].rect.width, doc[2].rect.height) == (792, 612)  # crop box is landscape
        assert (doc[3].rect.width, doc[3].rect.height) == (612, 792)
        assert "MIX-P2" in doc[0].get_text()
        assert "CROP-P1" in doc[2].get_text()
        assert doc[0].get_images() == []


def test_fit_mode_shows_content_upright_for_rotated_source(fx, tmp_path, ctx):
    out = tmp_path / "fit-rot.pdf"
    source_path = tmp_path / "rot-src.pdf"
    doc = pymupdf.open()
    doc.new_page(width=600, height=400)
    doc[0].draw_rect(pymupdf.Rect(0, 0, 100, 100), fill=(0, 0, 0), color=None)  # unrotated top-left
    doc[0].set_rotation(90)  # top-left corner appears at the top-right
    doc.save(source_path)
    doc.close()
    assemble(
        {
            "sources": [src(source_path, "s")],
            "pages": [pdf_page("s", 0)],
            "options": {**OPTIONS, "pageSizing": "fit", "fitSize": "A4"},
            "output": output(out),
        },
        ctx,
    )
    with pymupdf.open(out) as result:
        bbox = ink_bbox(result[0])
        assert result[0].rect.width < result[0].rect.height
        assert bbox[2] > result[0].rect.width * 0.8, "ink should sit in the top-right corner"
        assert bbox[1] < result[0].rect.height * 0.3


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_fit_mode_matches_visual_source_with_crop_and_rotation(tmp_path, ctx, rotation):
    source_path = tmp_path / "s.pdf"
    doc = pymupdf.open()
    doc.new_page(width=500, height=500)
    doc[0].draw_rect(pymupdf.Rect(100, 100, 150, 120), fill=(0, 0, 0), color=None)
    doc[0].insert_link({"kind": pymupdf.LINK_URI, "from": pymupdf.Rect(100, 100, 150, 120), "uri": "https://x.test/"})
    doc[0].set_cropbox(pymupdf.Rect(100, 100, 400, 300))
    doc[0].set_rotation(rotation)
    doc.save(source_path)
    with pymupdf.open(source_path) as check:
        source_bbox = ink_bbox(check[0])
        source_rect = check[0].rect
    doc.close()
    out = tmp_path / "o.pdf"
    assemble(
        {
            "sources": [src(source_path, "s")],
            "pages": [pdf_page("s", 0)],
            "options": {**OPTIONS, "pageSizing": "fit", "fitSize": "A4"},
            "output": output(out),
        },
        ctx,
    )
    with pymupdf.open(out) as result:
        page = result[0]
        assert (page.rect.width > page.rect.height) == (source_rect.width > source_rect.height)
        scale = min(page.rect.width / source_rect.width, page.rect.height / source_rect.height)
        off_x = (page.rect.width - source_rect.width * scale) / 2
        off_y = (page.rect.height - source_rect.height * scale) / 2
        bbox = ink_bbox(page)
        expected = (
            off_x + source_bbox[0] * scale,
            off_y + source_bbox[1] * scale,
            off_x + source_bbox[2] * scale,
            off_y + source_bbox[3] * scale,
        )
        for got, want in zip(bbox, expected):
            assert abs(got - want) < 4
        link = page.get_links()[0]["from"]
        for got, want in zip(link, expected):
            assert abs(got - want) < 4


def test_external_and_internal_links_preserved(fx, tmp_path, ctx):
    out = tmp_path / "links.pdf"
    result = assemble(
        {
            "sources": [src(fx["rich"], "r")],
            "pages": [pdf_page("r", 2), pdf_page("r", 0), pdf_page("r", 3)],
            "options": OPTIONS,
            "output": output(out),
        },
        ctx,
    )
    with pymupdf.open(out) as doc:
        links = doc[1].get_links()
        uris = [link["uri"] for link in links if link["kind"] == pymupdf.LINK_URI]
        gotos = [link["page"] for link in links if link["kind"] == pymupdf.LINK_GOTO]
        assert uris == ["https://example.com/doc"]
        assert gotos == [0], "source page 3 is output page 1"
        # Page 4 linked to source page 2, which is not in the output.
        assert doc[2].get_links() == []
    assert any("internal link" in w for w in result["warnings"])


def test_links_keep_position_on_rotated_pages(fx, tmp_path, ctx):
    source_path = tmp_path / "rotlink.pdf"
    doc = pymupdf.open()
    doc.new_page(width=600, height=400)
    doc[0].insert_link({"kind": pymupdf.LINK_URI, "from": pymupdf.Rect(10, 10, 60, 40), "uri": "https://x.test/"})
    doc[0].set_rotation(90)
    doc.save(source_path)
    with pymupdf.open(source_path) as check:
        expected = check[0].get_links()[0]["from"]
    doc.close()
    out = tmp_path / "out.pdf"
    assemble(
        {"sources": [src(source_path, "s")], "pages": [pdf_page("s", 0)], "options": OPTIONS, "output": output(out)},
        ctx,
    )
    with pymupdf.open(out) as result:
        assert result[0].rotation == 90
        got = result[0].get_links()[0]["from"]
        for a, b in zip(got, expected):
            assert abs(a - b) < 0.5


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_links_keep_position_on_cropped_rotated_pages(tmp_path, ctx, rotation):
    source_path = tmp_path / "cr.pdf"
    doc = pymupdf.open()
    doc.new_page(width=500, height=400)
    doc[0].insert_link({"kind": pymupdf.LINK_URI, "from": pymupdf.Rect(120, 80, 180, 120), "uri": "https://x.test/"})
    doc[0].set_cropbox(pymupdf.Rect(100, 50, 400, 250))
    doc[0].set_rotation(rotation)
    doc.save(source_path)
    with pymupdf.open(source_path) as check:
        expected = check[0].get_links()[0]["from"]
    doc.close()
    out = tmp_path / "o.pdf"
    assemble(
        {"sources": [src(source_path, "s")], "pages": [pdf_page("s", 0)], "options": OPTIONS, "output": output(out)},
        ctx,
    )
    with pymupdf.open(out) as result:
        got = result[0].get_links()[0]["from"]
        for a, b in zip(got, expected):
            assert abs(a - b) < 0.5, f"{got} vs {expected}"


def test_bookmarks_rebuilt_and_filtered(fx, tmp_path, ctx):
    out = tmp_path / "toc.pdf"
    result = assemble(
        {
            "sources": [src(fx["rich"], "r")],
            "pages": [pdf_page("r", 3), pdf_page("r", 0)],
            "options": OPTIONS,
            "output": output(out),
        },
        ctx,
    )
    with pymupdf.open(out) as doc:
        assert doc.get_toc(simple=True) == [[1, "Intro", 2], [1, "Annex detail", 1]][::-1]
    assert any("bookmark" in w for w in result["warnings"])


def test_attachments_copied_and_optional(fx, tmp_path, ctx):
    base = {"sources": [src(fx["rich"], "r")], "pages": [pdf_page("r", 0)]}
    keep = tmp_path / "keep.pdf"
    drop = tmp_path / "drop.pdf"
    assemble({**base, "options": OPTIONS, "output": output(keep)}, ctx)
    assemble({**base, "options": {**OPTIONS, "keepAttachments": False}, "output": output(drop)}, ctx)
    with pymupdf.open(keep) as doc:
        assert doc.embfile_names() == ["data.txt"]
        assert doc.embfile_get("data.txt") == b"attachment payload"
    with pymupdf.open(drop) as doc:
        assert doc.embfile_count() == 0


def test_annotations_and_forms_stay_live_in_preserve_mode(fx, tmp_path, ctx):
    out = tmp_path / "live.pdf"
    assemble(
        {
            "sources": [src(fx["rich"], "r"), src(fx["form"], "f")],
            "pages": [pdf_page("r", 1), pdf_page("f", 0)],
            "options": OPTIONS,
            "output": output(out),
        },
        ctx,
    )
    with pymupdf.open(out) as doc:
        assert doc[0].first_annot is not None
        widgets = list(doc[1].widgets())
        assert widgets and widgets[0].field_value == "FORMVALUE"


def test_fit_mode_flattens_form_values_visibly(fx, tmp_path, ctx):
    out = tmp_path / "flat.pdf"
    assemble(
        {
            "sources": [src(fx["form"], "f")],
            "pages": [pdf_page("f", 0)],
            "options": {**OPTIONS, "pageSizing": "fit"},
            "output": output(out),
        },
        ctx,
    )
    with pymupdf.open(out) as doc:
        assert list(doc[0].widgets()) == []
        assert "FORMVALUE" in doc[0].get_text()


def test_unicode_filenames_and_output(fx, tmp_path, ctx):
    out = tmp_path / "出力 résumé — 1.pdf"
    assemble(
        {"sources": [src(fx["unicode"], "u")], "pages": [pdf_page("u", 1)], "options": OPTIONS, "output": output(out)},
        ctx,
    )
    assert page_labels(out) == ["U-P2"]


def test_long_paths_supported(fx, tmp_path, ctx):
    deep = str(tmp_path)
    while len(deep) < 280:
        deep += "\\very_long_folder_name_for_testing"
    import os

    os.makedirs("\\\\?\\" + deep)
    input_path = deep + "\\input.pdf"
    shutil.copyfile(fx["a"], "\\\\?\\" + input_path)
    out = deep + "\\output.pdf"
    result = assemble(
        {
            "sources": [{"id": "a", "path": input_path}],
            "pages": [pdf_page("a", 1)],
            "options": OPTIONS,
            "output": {"path": out, "overwrite": "error"},
        },
        ctx,
    )
    assert result["verified"]
    assert os.path.exists("\\\\?\\" + out)


def test_image_fit_modes(fx, tmp_path, ctx):
    wide = tmp_path / "contain.pdf"
    cover = tmp_path / "cover.pdf"
    base = {"sources": [src(fx["png"], "p")], "pages": [{"kind": "image", "sourceId": "p", "rotation": 0}]}
    assemble({**base, "options": OPTIONS, "output": output(wide)}, ctx)
    assemble({**base, "options": {**OPTIONS, "imageFit": "cover"}, "output": output(cover)}, ctx)
    with pymupdf.open(wide) as doc:
        page = doc[0]
        assert page.rect.width > page.rect.height, "landscape image selects a landscape page"
        bbox = ink_bbox(page, 200)
        assert bbox[1] == 0 or bbox[3] - bbox[1] < page.rect.height
        assert bbox[0] == 0 and bbox[2] == int(page.rect.width + 0.999)
    with pymupdf.open(cover) as doc:
        page = doc[0]
        pix = page.get_pixmap(dpi=36, alpha=False)
        assert pix.pixel(1, 1)[2] > 150 and pix.pixel(pix.width - 2, pix.height - 2)[2] > 150


def test_exif_orientation_applied(fx, tmp_path, ctx):
    out = tmp_path / "exif.pdf"
    assemble(
        {
            "sources": [src(fx["jpg_exif"], "e")],
            "pages": [{"kind": "image", "sourceId": "e", "rotation": 0}],
            "options": OPTIONS,
            "output": output(out),
        },
        ctx,
    )
    with pymupdf.open(out) as doc:
        assert doc[0].rect.width < doc[0].rect.height, "an EXIF-rotated 300x200 is portrait"


def test_output_exists_policy(fx, tmp_path, ctx):
    out = tmp_path / "exists.pdf"
    out.write_bytes(b"keep me")
    params = {"sources": [src(fx["a"], "a")], "pages": [pdf_page("a", 0)], "options": OPTIONS}
    with pytest.raises(WorkerError) as err:
        assemble({**params, "output": output(out)}, ctx)
    assert err.value.code == "OUTPUT_EXISTS"
    assert out.read_bytes() == b"keep me"
    renamed = assemble({**params, "output": {"path": str(out), "overwrite": "rename"}}, ctx)
    assert renamed["outputs"][0]["path"].endswith("exists (1).pdf")
    assert out.read_bytes() == b"keep me"
    assemble({**params, "output": {"path": str(out), "overwrite": "replace"}}, ctx)
    assert page_labels(out) == ["A-P1"]


def test_locked_output_reports_clearly(fx, tmp_path, ctx):
    out = tmp_path / "locked.pdf"
    shutil.copyfile(fx["a"], out)
    holder = open(out, "rb")  # Windows sharing rules block replacing an open file.
    try:
        with pytest.raises(WorkerError) as err:
            assemble(
                {
                    "sources": [src(fx["b"], "b")],
                    "pages": [pdf_page("b", 0)],
                    "options": OPTIONS,
                    "output": {"path": str(out), "overwrite": "replace"},
                },
                ctx,
            )
        assert err.value.code == "OUTPUT_LOCKED"
    finally:
        holder.close()
    assert page_labels(out)[0] == "A-P1", "the original is restored"
    assert temp_files(tmp_path) == []


def test_insufficient_disk_space_reports_before_writing(fx, tmp_path, ctx, monkeypatch):
    import collections

    import paperforge_worker.fsutil as fsutil

    usage = collections.namedtuple("usage", "total used free")
    monkeypatch.setattr(fsutil.shutil, "disk_usage", lambda _path: usage(100, 99, 1))
    with pytest.raises(WorkerError) as err:
        assemble(
            {
                "sources": [src(fx["a"], "a")],
                "pages": [pdf_page("a", 0)],
                "options": OPTIONS,
                "output": output(tmp_path / "o.pdf"),
            },
            ctx,
        )
    assert err.value.code == "DISK_FULL"
    assert "free space" in err.value.message
    assert list(tmp_path.iterdir()) == []


def test_missing_source(fx, tmp_path, ctx):
    with pytest.raises(WorkerError) as err:
        assemble(
            {
                "sources": [src(tmp_path / "gone.pdf", "x")],
                "pages": [pdf_page("x", 0)],
                "options": OPTIONS,
                "output": output(tmp_path / "o.pdf"),
            },
            ctx,
        )
    assert err.value.code == "FILE_NOT_FOUND"


def test_page_out_of_range(fx, tmp_path, ctx):
    with pytest.raises(WorkerError) as err:
        assemble(
            {
                "sources": [src(fx["a"], "a")],
                "pages": [pdf_page("a", 99)],
                "options": OPTIONS,
                "output": output(tmp_path / "o.pdf"),
            },
            ctx,
        )
    assert err.value.code == "INVALID_REQUEST"


def test_cancellation_leaves_no_output_or_temp_files(fx, tmp_path):
    from paperforge_worker.errors import JobCancelled
    from paperforge_worker.job import JobContext

    token = JobContext("cancelme")
    calls = {"n": 0}

    def emit(_id, _done, _total, _stage):
        calls["n"] += 1
        if calls["n"] == 2:
            token.cancel()

    token._emit = emit
    out = tmp_path / "cancelled.pdf"
    with pytest.raises(JobCancelled):
        assemble(
            {
                "sources": [src(fx["a"], "a")],
                "pages": [pdf_page("a", i) for i in range(5)],
                "options": OPTIONS,
                "output": output(out),
            },
            token,
        )
    assert not out.exists()
    assert temp_files(tmp_path) == []


def test_preview_renders_requested_page_with_correct_number(fx, ctx):
    result = preview_assemble(
        {
            "sources": [src(fx["a"], "a")],
            "pages": [pdf_page("a", 0), pdf_page("a", 1), pdf_page("a", 2)],
            "options": {
                **OPTIONS,
                "pageNumbers": {
                    "position": "top-right",
                    "start": 5,
                    "fontSize": 12,
                    "color": "#000000",
                    "format": "n_of_total",
                },
            },
            "previewIndex": 1,
            "maxSize": 400,
        },
        ctx,
    )
    assert result["height"] == 400 or result["width"] == 400
    assert result["pngBase64"].startswith("iVBOR")
