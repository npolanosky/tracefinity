"""Materialize parametric tool shapes into a polygon outline.

Designer-made tools store a list of ToolShape primitives; everything
downstream (bin editor, sync, STL generation) consumes the materialized
points/interior_rings, so this is the only place boolean geometry happens.
"""

import math

from shapely import affinity
from shapely.geometry import Point as ShapelyPoint, Polygon as ShapelyPolygon, box
from shapely.ops import unary_union
from shapely.validation import make_valid

from app.models.schemas import Point, ToolLevel, ToolLevelPart, ToolShape

# max chord deviation when approximating curves with segments. 0.05mm keeps a
# 33mm circle visually round and survives the 0.05mm collinear-cleanup simplify.
CHORD_ERROR_MM = 0.05


def _segments(radius: float) -> int:
    """segment count so the sagitta r*(1-cos(pi/n)) stays under CHORD_ERROR_MM"""
    if radius <= CHORD_ERROR_MM:
        return 32
    n = math.pi / math.acos(max(-1.0, 1.0 - CHORD_ERROR_MM / radius))
    return min(256, max(32, math.ceil(n)))


def _shape_geometry(shape: ToolShape):
    """build the shapely polygon for one primitive, positioned in tool space"""
    if shape.type == "rectangle":
        w = shape.width or 0.0
        h = shape.height or 0.0
        if w <= 0 or h <= 0:
            raise ValueError(f"rectangle {shape.id} needs positive width and height")
        r = min(shape.corner_radius, w / 2, h / 2)
        if r > 0:
            inner = box(-w / 2 + r, -h / 2 + r, w / 2 - r, h / 2 - r)
            geom = inner.buffer(r, quad_segs=max(8, _segments(r) // 4))
        else:
            geom = box(-w / 2, -h / 2, w / 2, h / 2)
    elif shape.type == "ellipse":
        rx = shape.rx or 0.0
        ry = shape.ry or 0.0
        if rx <= 0 or ry <= 0:
            raise ValueError(f"ellipse {shape.id} needs positive radii")
        circle = ShapelyPoint(0, 0).buffer(1.0, quad_segs=max(8, _segments(max(rx, ry)) // 4))
        geom = affinity.scale(circle, rx, ry, origin=(0, 0))
    else:
        raise ValueError(f"shape type {shape.type} cannot form an outline")

    if shape.rotation:
        geom = affinity.rotate(geom, shape.rotation, origin=(0, 0))
    return affinity.translate(geom, shape.x, shape.y)


def _ring_points(coords) -> list[Point]:
    return [Point(x=c[0], y=c[1]) for c in list(coords)[:-1]]


def _level_parts(geom) -> list[ToolLevelPart]:
    """split a (Multi)Polygon into ToolLevelParts, one per connected component"""
    polys = list(geom.geoms) if geom.geom_type == "MultiPolygon" else [geom]
    parts = []
    for p in polys:
        if p.is_empty or p.area < 1e-6:
            continue
        parts.append(ToolLevelPart(
            points=_ring_points(p.exterior.coords),
            interior_rings=[_ring_points(i.coords) for i in p.interiors],
        ))
    return parts


def compile_shapes(
    shapes: list[ToolShape],
) -> tuple[list[Point], list[list[Point]], tuple[float, float], list[ToolLevel] | None]:
    """union all additive shapes, subtract all subtractive ones, recentre on the
    bounding-box midpoint (the convention every Tool consumer assumes).

    Returns (points, interior_rings, (cx, cy), levels) where (cx, cy) is the
    offset that was subtracted -- callers must shift stored shape positions by
    the same amount so shapes and materialized points stay congruent.

    levels is None unless at least one add-shape has a depth: then adds are
    grouped by depth (None = default group), every group has ALL subtracts
    carved out, and union(levels) == the footprint exactly. The pocket becomes
    the union of each level extruded to its own depth.

    Raises ValueError with a user-facing message on invalid input.
    """
    for s in shapes:
        if s.type == "line" and s.mode != "guide":
            raise ValueError("lines can only be guides")

    add_shapes = [s for s in shapes if s.mode == "add"]
    adds = [_shape_geometry(s) for s in add_shapes]
    subs = [_shape_geometry(s) for s in shapes if s.mode == "subtract"]

    if not adds:
        raise ValueError("design needs at least one solid (additive) shape")

    sub_union = unary_union(subs) if subs else None
    result = unary_union(adds)
    if sub_union is not None:
        result = result.difference(sub_union)
    if not result.is_valid:
        result = make_valid(result)

    if result.is_empty or result.area < 1e-6:
        raise ValueError("shapes produce an empty outline")
    if result.geom_type == "MultiPolygon":
        parts = len(result.geoms)
        raise ValueError(
            f"shapes must form a single connected outline ({parts} disconnected pieces)"
        )
    if result.geom_type != "Polygon":
        raise ValueError("shapes produce an invalid outline")

    minx, miny, maxx, maxy = result.bounds
    cx = (minx + maxx) / 2
    cy = (miny + maxy) / 2
    result = affinity.translate(result, -cx, -cy)

    points = _ring_points(result.exterior.coords)
    interior_rings = [_ring_points(interior.coords) for interior in result.interiors]

    levels = None
    if any(s.depth is not None for s in add_shapes):
        groups: dict[float | None, list] = {}
        for s, geom in zip(add_shapes, adds):
            groups.setdefault(s.depth, []).append(geom)
        levels = []
        for depth, geoms in groups.items():
            level_geom = unary_union(geoms)
            if sub_union is not None:
                level_geom = level_geom.difference(sub_union)
            if not level_geom.is_valid:
                level_geom = make_valid(level_geom)
            if level_geom.is_empty or level_geom.area < 1e-6:
                continue
            level_geom = affinity.translate(level_geom, -cx, -cy)
            parts = _level_parts(level_geom)
            if parts:
                levels.append(ToolLevel(depth=depth, parts=parts))
        if not levels:
            levels = None

    return points, interior_rings, (cx, cy), levels


def recentre_shapes(shapes: list[ToolShape], offset: tuple[float, float]) -> list[ToolShape]:
    """shift stored shape positions by the recentring offset compile applied"""
    cx, cy = offset
    if cx == 0 and cy == 0:
        return shapes
    return [s.model_copy(update={"x": s.x - cx, "y": s.y - cy}) for s in shapes]
