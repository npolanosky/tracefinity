"""Tests for per-tool clearance override resolution and application."""
import pytest

from app.models.schemas import Tool, Point
from app.services.bin_service import resolve_clearance
from app.services.polygon_scaler import PolygonScaler, ScaledPolygon


def make_tool(clearance_override=None):
    return Tool(
        id="t1",
        name="test",
        points=[Point(x=0, y=0), Point(x=10, y=0), Point(x=10, y=10), Point(x=0, y=10)],
        clearance_override=clearance_override,
    )


class TestResolveClearance:
    def test_no_tool_uses_bin_default(self):
        assert resolve_clearance(None, 1.0) == 1.0

    def test_no_override_uses_bin_default(self):
        assert resolve_clearance(make_tool(), 1.0) == 1.0

    def test_override_takes_precedence(self):
        assert resolve_clearance(make_tool(clearance_override=0.25), 1.0) == 0.25

    def test_zero_override_means_exact_fit(self):
        assert resolve_clearance(make_tool(clearance_override=0.0), 1.0) == 0.0


class TestClearanceApplication:
    def test_cutout_width_reflects_clearance(self):
        scaler = PolygonScaler()
        square = [(0.0, 0.0), (33.0, 0.0), (33.0, 33.0), (0.0, 33.0)]
        sp = ScaledPolygon("p1", square, "square")

        expanded = scaler.add_clearance(sp, 0.25)
        xs = [p[0] for p in expanded.points_mm]
        assert max(xs) - min(xs) == pytest.approx(33.5)

        unchanged = scaler.add_clearance(sp, 0.0)
        xs = [p[0] for p in unchanged.points_mm]
        assert max(xs) - min(xs) == pytest.approx(33.0)
