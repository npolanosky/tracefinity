"""Tests for parametric shape materialization in shape_compiler."""
import math

import pytest

from app.models.schemas import ToolShape
from app.services.shape_compiler import compile_shapes, recentre_shapes


def rect(id="r1", mode="add", x=0.0, y=0.0, w=40.0, h=40.0, rotation=0.0, corner_radius=0.0):
    return ToolShape(
        id=id, type="rectangle", mode=mode, x=x, y=y,
        width=w, height=h, rotation=rotation, corner_radius=corner_radius,
    )


def circle(id="c1", mode="add", x=0.0, y=0.0, r=16.5):
    return ToolShape(id=id, type="ellipse", mode=mode, x=x, y=y, rx=r, ry=r)


def bbox(points):
    xs = [p.x for p in points]
    ys = [p.y for p in points]
    return min(xs), min(ys), max(xs), max(ys)


class TestPrimitives:
    def test_circle_resolution(self):
        # a 33mm-diameter circle must stay genuinely round
        points, rings, _, _ = compile_shapes([circle(r=16.5)])
        assert len(points) >= 40
        assert rings == []
        # every vertex on the radius within chord tolerance
        for p in points:
            assert math.hypot(p.x, p.y) == pytest.approx(16.5, abs=0.06)

    def test_rectangle_exact(self):
        points, _, _, _ = compile_shapes([rect(w=80, h=30)])
        minx, miny, maxx, maxy = bbox(points)
        assert (maxx - minx) == pytest.approx(80)
        assert (maxy - miny) == pytest.approx(30)

    def test_rotated_rounded_rect_valid(self):
        points, rings, _, _ = compile_shapes([rect(w=50, h=20, rotation=30, corner_radius=5)])
        assert len(points) >= 4
        assert rings == []

    def test_result_centered_at_origin(self):
        points, _, offset, _ = compile_shapes([rect(x=100, y=-50, w=40, h=20)])
        minx, miny, maxx, maxy = bbox(points)
        assert (minx + maxx) / 2 == pytest.approx(0, abs=1e-6)
        assert (miny + maxy) / 2 == pytest.approx(0, abs=1e-6)
        assert offset == pytest.approx((100, -50))


class TestBooleans:
    def test_overlapping_adds_union_to_single_ring(self):
        points, rings, _, _ = compile_shapes([
            rect(id="a", w=40, h=40),
            rect(id="b", x=30, w=40, h=40),
        ])
        minx, _, maxx, _ = bbox(points)
        assert (maxx - minx) == pytest.approx(70)
        assert rings == []

    def test_subtract_inside_makes_interior_ring(self):
        points, rings, _, _ = compile_shapes([
            rect(w=80, h=30),
            circle(mode="subtract", r=5),
        ])
        assert len(rings) == 1
        assert len(rings[0]) >= 20

    def test_subtract_splitting_outline_rejected(self):
        with pytest.raises(ValueError, match="single connected outline"):
            compile_shapes([
                rect(w=80, h=30),
                rect(id="cut", mode="subtract", w=10, h=40),
            ])

    def test_subtract_everything_rejected(self):
        with pytest.raises(ValueError, match="empty outline"):
            compile_shapes([
                rect(w=20, h=20),
                rect(id="cut", mode="subtract", w=40, h=40),
            ])

    def test_disjoint_adds_rejected(self):
        with pytest.raises(ValueError, match="single connected outline"):
            compile_shapes([rect(id="a", w=10, h=10), rect(id="b", x=100, w=10, h=10)])

    def test_no_additive_shapes_rejected(self):
        with pytest.raises(ValueError, match="additive"):
            compile_shapes([circle(mode="subtract")])


class TestGuides:
    def test_guides_excluded_from_outline(self):
        points, rings, _, _ = compile_shapes([
            rect(w=40, h=40),
            circle(id="g", mode="guide", x=20, y=20, r=30),
        ])
        minx, miny, maxx, maxy = bbox(points)
        assert (maxx - minx) == pytest.approx(40)
        assert (maxy - miny) == pytest.approx(40)
        assert rings == []

    def test_guide_line_allowed(self):
        line = ToolShape(id="l", type="line", mode="guide", width=100)
        points, _, _, _ = compile_shapes([rect(), line])
        assert len(points) >= 4

    def test_solid_line_rejected(self):
        line = ToolShape(id="l", type="line", mode="add", width=100)
        with pytest.raises(ValueError, match="guides"):
            compile_shapes([rect(), line])


class TestRecentre:
    def test_shapes_shifted_by_offset(self):
        shapes = [rect(x=100, y=-50)]
        _, _, offset, _ = compile_shapes(shapes)
        shifted = recentre_shapes(shapes, offset)
        assert shifted[0].x == pytest.approx(0)
        assert shifted[0].y == pytest.approx(0)

    def test_recompiling_recentred_shapes_is_stable(self):
        shapes = [rect(x=12.5, w=40, h=20), circle(x=30, r=10)]
        points1, _, offset, _ = compile_shapes(shapes)
        shifted = recentre_shapes(shapes, offset)
        points2, _, offset2, _ = compile_shapes(shifted)
        assert offset2 == pytest.approx((0, 0), abs=1e-9)
        assert len(points1) == len(points2)
