"""Tests for per-shape depth: compile-time level grouping, placement
transform, depth resolution and the multi-level pocket cutters."""
import math

import pytest

from app.models.schemas import (
    BinConfig,
    BinModel,
    BinParams,
    PlacedTool,
    Point,
    Tool,
    ToolLevel,
    ToolLevelPart,
    ToolShape,
)
from app.services.bin_service import placed_levels
from app.services.polygon_scaler import PolygonScaler, ScaledLevelPart, ScaledPolygon
from app.services.shape_compiler import compile_shapes
from app.services.stl_generator_manifold import (
    _make_polygon_cutouts,
    _resolve_level_depth,
)


def rect(id="r1", mode="add", x=0.0, y=0.0, w=40.0, h=40.0, depth=None):
    return ToolShape(id=id, type="rectangle", mode=mode, x=x, y=y, width=w, height=h, depth=depth)


def circle(id="c1", mode="add", x=0.0, y=0.0, r=16.5, depth=None):
    return ToolShape(id=id, type="ellipse", mode=mode, x=x, y=y, rx=r, ry=r, depth=depth)


def ring_area(points):
    """shoelace area of a Point ring"""
    n = len(points)
    s = 0.0
    for i in range(n):
        a, b = points[i], points[(i + 1) % n]
        s += a.x * b.y - b.x * a.y
    return abs(s) / 2


def part_area(part):
    return ring_area(part.points) - sum(ring_area(r) for r in part.interior_rings)


class TestCompileLevels:
    def test_concentric_circles_form_two_levels(self):
        # the C7 bulb: wide shallow recess over a narrow deep hole
        points, rings, _, levels = compile_shapes([
            circle(id="wide", r=11, depth=10),
            circle(id="narrow", r=7.5, depth=30),
        ])
        # footprint = the wide circle
        assert rings == []
        assert max(math.hypot(p.x, p.y) for p in points) == pytest.approx(11, abs=0.06)

        assert levels is not None
        by_depth = {lv.depth: lv for lv in levels}
        assert set(by_depth) == {10, 30}
        assert len(by_depth[10].parts) == 1
        assert len(by_depth[30].parts) == 1
        assert part_area(by_depth[10].parts[0]) == pytest.approx(math.pi * 11**2, rel=0.01)
        assert part_area(by_depth[30].parts[0]) == pytest.approx(math.pi * 7.5**2, rel=0.01)

    def test_no_depths_means_no_levels(self):
        _, _, _, levels = compile_shapes([circle(r=10), rect(x=5, w=20, h=20)])
        assert levels is None

    def test_mixed_depth_and_default_groups(self):
        _, _, _, levels = compile_shapes([
            rect(id="base", w=80, h=30),
            rect(id="deep", w=20, h=10, depth=25),
        ])
        assert levels is not None
        assert {lv.depth for lv in levels} == {None, 25}

    def test_subtract_carves_every_level(self):
        # subtract sits inside the deep rect and spans its full height
        _, _, _, levels = compile_shapes([
            rect(id="base", w=80, h=30),
            rect(id="deep", w=60, h=10, depth=20),
            rect(id="cut", mode="subtract", w=5, h=12),
        ])
        deep = next(lv for lv in levels if lv.depth == 20)
        total = sum(part_area(p) for p in deep.parts)
        assert total == pytest.approx(60 * 10 - 5 * 10, rel=0.01)

    def test_subtract_splitting_one_level_yields_parts(self):
        # the cut splits the deep rect in two but the footprint stays connected
        points, _, _, levels = compile_shapes([
            rect(id="base", w=80, h=30),
            rect(id="deep", w=60, h=10, depth=20),
            rect(id="cut", mode="subtract", w=5, h=12),
        ])
        deep = next(lv for lv in levels if lv.depth == 20)
        assert len(deep.parts) == 2

    def test_levels_recentred_with_footprint(self):
        _, _, offset, levels = compile_shapes([
            circle(id="wide", x=100, y=-50, r=11, depth=10),
            circle(id="narrow", x=100, y=-50, r=7.5, depth=30),
        ])
        assert offset == pytest.approx((100, -50))
        for lv in levels:
            for part in lv.parts:
                xs = [p.x for p in part.points]
                ys = [p.y for p in part.points]
                assert (min(xs) + max(xs)) / 2 == pytest.approx(0, abs=0.1)
                assert (min(ys) + max(ys)) / 2 == pytest.approx(0, abs=0.1)

    def test_depth_validator_bounds(self):
        with pytest.raises(ValueError):
            ToolShape(id="bad", type="ellipse", rx=5, ry=5, depth=0.5)
        with pytest.raises(ValueError):
            ToolShape(id="bad", type="ellipse", rx=5, ry=5, depth=201)


class TestResolveLevelDepth:
    def test_level_depth_is_absolute(self):
        bp = BinParams(cutout_depth=20)
        assert _resolve_level_depth(10, 25, bp, max_depth=100) == 10.0

    def test_default_group_falls_back_to_placement_override(self):
        bp = BinParams(cutout_depth=20)
        assert _resolve_level_depth(None, 25, bp, max_depth=100) == 25.0

    def test_default_group_falls_back_to_global(self):
        bp = BinParams(cutout_depth=20)
        assert _resolve_level_depth(None, None, bp, max_depth=100) == 20.0

    def test_insert_height_added(self):
        bp = BinParams(cutout_depth=20, insert_enabled=True, insert_height=2.5)
        assert _resolve_level_depth(10, None, bp, max_depth=100) == 12.5

    def test_clamped_to_min_and_max(self):
        bp = BinParams(cutout_depth=20)
        assert _resolve_level_depth(2, None, bp, max_depth=100) == 5.0
        assert _resolve_level_depth(150, None, bp, max_depth=100) == 100.0


class _Store:
    def __init__(self, items):
        self._d = {item.id: item for item in items}

    def get(self, key):
        return self._d.get(key)


def _square(x0, y0, size):
    return [Point(x=x0, y=y0), Point(x=x0 + size, y=y0), Point(x=x0 + size, y=y0 + size), Point(x=x0, y=y0 + size)]


class TestPlacedLevels:
    def _tool_with_level(self):
        return Tool(
            id="tool1",
            name="bulb",
            points=_square(0, 0, 10),
            levels=[ToolLevel(depth=12, parts=[ToolLevelPart(points=_square(0, 0, 10))])],
        )

    def test_rotation_matches_sync_transform(self):
        tool = self._tool_with_level()
        # marker level point so the rotation is observable
        tool.levels[0].parts[0].points = [Point(x=10, y=5), Point(x=10, y=0), Point(x=0, y=0), Point(x=0, y=5)]
        placed = PlacedTool(
            id="p1", tool_id="tool1", name="bulb",
            points=_square(20, 20, 10), rotation=90,
        )
        levels = placed_levels(tool, placed)
        # lib centroid (5,5), placed centroid (25,25); (10,5) -> 90deg ->
        # rx = -(y-cy) = 0, ry = (x-cx) = 5 -> (25, 30)
        p = levels[0].parts[0].points[0]
        assert (p.x, p.y) == (pytest.approx(25), pytest.approx(30))
        assert levels[0].depth == 12

    def test_no_levels_returns_none(self):
        tool = Tool(id="t", name="flat", points=_square(0, 0, 10))
        placed = PlacedTool(id="p1", tool_id="t", name="flat", points=_square(20, 20, 10), rotation=0)
        assert placed_levels(tool, placed) is None

    def test_translation_only(self):
        tool = self._tool_with_level()
        placed = PlacedTool(id="p1", tool_id="tool1", name="bulb", points=_square(30, 40, 10), rotation=0)
        levels = placed_levels(tool, placed)
        xs = [p.x for p in levels[0].parts[0].points]
        ys = [p.y for p in levels[0].parts[0].points]
        assert min(xs) == pytest.approx(30)
        assert min(ys) == pytest.approx(40)


class TestLevelCutters:
    def test_volume_matches_sum_of_level_prisms(self):
        bp = BinParams(cutout_depth=20)
        poly = ScaledPolygon(
            "p1",
            [(0.0, 0.0), (30.0, 0.0), (30.0, 30.0), (0.0, 30.0)],
            "test",
            levels=[
                ScaledLevelPart(8, [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]),
                ScaledLevelPart(15, [(20.0, 0.0), (25.0, 0.0), (25.0, 5.0), (20.0, 5.0)]),
            ],
        )
        cutter = _make_polygon_cutouts([poly], bp, wall_top_z=30, max_depth=100, offset_x=0, offset_y=0)
        assert cutter is not None
        # the footprint (30x30) must NOT be cut -- only the two level prisms
        assert cutter.volume() == pytest.approx(100 * 8 + 25 * 15, rel=0.02)

    def test_default_level_uses_placement_override(self):
        bp = BinParams(cutout_depth=20)
        poly = ScaledPolygon(
            "p1",
            [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)],
            "test",
            depth_override=25,
            levels=[ScaledLevelPart(None, [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)])],
        )
        cutter = _make_polygon_cutouts([poly], bp, wall_top_z=30, max_depth=100, offset_x=0, offset_y=0)
        assert cutter.volume() == pytest.approx(100 * 25, rel=0.02)


class TestScalerCarriesLevels:
    def _poly(self):
        return ScaledPolygon(
            "p1",
            [(0.0, 0.0), (20.0, 0.0), (20.0, 20.0), (0.0, 20.0)],
            "test",
            levels=[ScaledLevelPart(10, [(5.0, 5.0), (15.0, 5.0), (15.0, 15.0), (5.0, 15.0)])],
        )

    def test_add_clearance_buffers_each_level(self):
        scaler = PolygonScaler()
        out = scaler.add_clearance(self._poly(), 1.0)
        xs = [p[0] for p in out.levels[0].points_mm]
        assert max(xs) - min(xs) == pytest.approx(12.0)
        assert out.levels[0].depth == 10

    def test_simplify_keeps_levels(self):
        scaler = PolygonScaler()
        out = scaler.simplify(self._poly(), tolerance_mm=0.05)
        assert out.levels is not None
        assert out.levels[0].depth == 10

    def test_zero_clearance_passthrough(self):
        scaler = PolygonScaler()
        out = scaler.add_clearance(self._poly(), 0.0)
        assert out.levels is not None


class TestLevelsRoundTrip:
    def test_tool_with_levels_survives_dump_and_validate(self):
        tool = Tool(
            id="t",
            name="bulb",
            points=_square(0, 0, 10),
            levels=[ToolLevel(depth=12, parts=[ToolLevelPart(points=_square(0, 0, 10))])],
        )
        loaded = Tool.model_validate(tool.model_dump())
        assert loaded.levels[0].depth == 12
        assert len(loaded.levels[0].parts) == 1

    def test_missing_levels_key_loads_as_none(self):
        data = Tool(id="t", name="flat", points=_square(0, 0, 10)).model_dump()
        del data["levels"]
        assert Tool.model_validate(data).levels is None

    def test_bin_with_legacy_placed_tools_loads(self):
        bin_data = BinModel(
            id="b1",
            bin_config=BinConfig(),
            placed_tools=[PlacedTool(id="p1", tool_id="t", name="flat", points=_square(0, 0, 10))],
        )
        loaded = BinModel.model_validate(bin_data.model_dump())
        assert loaded.placed_tools[0].points == bin_data.placed_tools[0].points
