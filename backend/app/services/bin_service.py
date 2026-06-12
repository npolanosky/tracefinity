import math
from app.models.schemas import Point, FingerHole, ToolLevel, ToolLevelPart


def resolve_clearance(source_tool, bin_clearance: float) -> float:
    """per-tool clearance override wins over the bin's global cutout_clearance"""
    if source_tool is not None and source_tool.clearance_override is not None:
        return source_tool.clearance_override
    return bin_clearance


def resolve_spacing(source_tool, bin_spacing: float) -> float:
    """per-tool spacing override wins over the bin's global tool_spacing.

    spacing is a keep-out air gap beyond the cutout outline used when
    arranging tools; it never changes pocket geometry.
    """
    if source_tool is not None and source_tool.spacing_override is not None:
        return source_tool.spacing_override
    return bin_spacing


def _placement_transform(tool, pt):
    """map library tool space into bin space using the placement's centroid +
    rotation. returns a point mapper fn. the vertex-mean centroid is
    rotation-invariant, so this reproduces the placed transform exactly."""
    n_placed = len(pt.points)
    placed_cx = sum(p.x for p in pt.points) / n_placed
    placed_cy = sum(p.y for p in pt.points) / n_placed

    n_lib = len(tool.points)
    lib_cx = sum(p.x for p in tool.points) / n_lib
    lib_cy = sum(p.y for p in tool.points) / n_lib

    rot = math.radians(pt.rotation)
    cos_r, sin_r = math.cos(rot), math.sin(rot)

    def map_xy(x: float, y: float) -> tuple[float, float]:
        rx = (x - lib_cx) * cos_r - (y - lib_cy) * sin_r
        ry = (x - lib_cx) * sin_r + (y - lib_cy) * cos_r
        return placed_cx + rx, placed_cy + ry

    return map_xy


def placed_levels(source_tool, pt) -> list[ToolLevel] | None:
    """transform source_tool.levels into bin space with the same centroid +
    rotation math sync_placed_tools uses for the footprint points"""
    if source_tool is None or not source_tool.levels or not source_tool.points or not pt.points:
        return None
    map_xy = _placement_transform(source_tool, pt)

    def map_points(points):
        return [Point(x=mx, y=my) for mx, my in (map_xy(p.x, p.y) for p in points)]

    return [
        ToolLevel(
            depth=level.depth,
            parts=[
                ToolLevelPart(
                    points=map_points(part.points),
                    interior_rings=[map_points(ring) for ring in part.interior_rings],
                )
                for part in level.parts
            ],
        )
        for level in source_tool.levels
    ]


def sync_placed_tools(bin_data, user_tools) -> bool:
    """sync placed tools with their library versions. returns True if any changed."""
    changed = False
    for pt in bin_data.placed_tools:
        if not pt.tool_id:
            continue
        tool = user_tools.get(pt.tool_id)
        if not tool or not tool.points:
            continue

        map_xy = _placement_transform(tool, pt)

        new_points = []
        for p in tool.points:
            mx, my = map_xy(p.x, p.y)
            new_points.append(Point(x=mx, y=my))

        # preserve per-placement state (depth_override, etc.) by matching
        # source-tool holes to existing placed holes by id. without this,
        # GET /bins/{id} silently overwrites stored overrides on every load.
        existing_overrides = {fh.id: fh.depth_override for fh in pt.finger_holes}
        new_fh = []
        for fh in tool.finger_holes:
            mx, my = map_xy(fh.x, fh.y)
            new_fh.append(FingerHole(
                id=fh.id, x=mx, y=my,
                radius=fh.radius, width=fh.width, height=fh.height,
                rotation=fh.rotation, shape=fh.shape,
                depth_override=existing_overrides.get(fh.id),
            ))

        new_rings = []
        for ring in (tool.interior_rings or []):
            new_ring = []
            for p in ring:
                mx, my = map_xy(p.x, p.y)
                new_ring.append(Point(x=mx, y=my))
            new_rings.append(new_ring)

        if new_points != pt.points or new_fh != pt.finger_holes or new_rings != pt.interior_rings:
            pt.points = new_points
            pt.finger_holes = new_fh
            pt.interior_rings = new_rings
            pt.name = tool.name
            changed = True

    return changed
