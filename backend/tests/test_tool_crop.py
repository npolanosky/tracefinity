"""Tests for the saved-tool image crop used by the per-tool namer."""
import io
from types import SimpleNamespace

from PIL import Image

from app.services.image_service import png_bytes_from_file, tool_crop_png


def _pt(x, y):
    return SimpleNamespace(x=x, y=y)


def _write_img(path, w, h, color=(120, 130, 140)):
    Image.new("RGB", (w, h), color).save(path)


class TestPngBytesFromFile:
    def test_reads_and_reencodes_png(self, tmp_path):
        p = tmp_path / "thumb.jpg"
        _write_img(p, 200, 120)
        out = png_bytes_from_file(str(p))
        assert out and out[:8] == b"\x89PNG\r\n\x1a\n"

    def test_downsizes_to_max_dim(self, tmp_path):
        p = tmp_path / "big.jpg"
        _write_img(p, 1000, 500)
        out = png_bytes_from_file(str(p), max_dim=384)
        assert max(Image.open(io.BytesIO(out)).size) == 384

    def test_missing_file_is_none(self, tmp_path):
        assert png_bytes_from_file(str(tmp_path / "nope.jpg")) is None


class TestToolCropPng:
    def test_prefers_thumbnail(self, tmp_path):
        thumb = tmp_path / "t.jpg"
        _write_img(thumb, 64, 64)
        tool = SimpleNamespace(source_image_transform=None, points=[])
        out = tool_crop_png(tool, None, str(thumb))
        assert out and out[:8] == b"\x89PNG\r\n\x1a\n"

    def test_source_crop_fallback_via_transform(self, tmp_path):
        # identity transform: mm == px. points pick a sub-rectangle to crop.
        src = tmp_path / "src.jpg"
        _write_img(src, 400, 400)
        tool = SimpleNamespace(
            source_image_transform=[1, 0, 0, 0, 1, 0],
            points=[_pt(100, 100), _pt(300, 100), _pt(300, 250), _pt(100, 250)],
        )
        out = tool_crop_png(tool, str(src), None)
        assert out and out[:8] == b"\x89PNG\r\n\x1a\n"

    def test_none_when_no_image_available(self):
        tool = SimpleNamespace(source_image_transform=None, points=[])
        assert tool_crop_png(tool, None, None) is None

    def test_none_on_degenerate_transform(self, tmp_path):
        src = tmp_path / "src.jpg"
        _write_img(src, 400, 400)
        tool = SimpleNamespace(
            source_image_transform=[0, 0, 0, 0, 0, 0],  # det 0
            points=[_pt(1, 1), _pt(2, 2)],
        )
        assert tool_crop_png(tool, str(src), None) is None
