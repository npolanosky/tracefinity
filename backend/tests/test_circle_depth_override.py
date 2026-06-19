"""Geometry tests for depth overrides on the default circular finger hole.

A bare sphere cutter can only reach a depth of its radius, so before the fix
an explicit ``depth_override`` deeper than the radius was silently ignored for
circle holes (the default finger-hole shape). These tests verify that an
explicit override is now honored while the default thumb-scoop is preserved.
"""
from app.models.schemas import BinParams
from app.services.polygon_scaler import ScaledFingerHole, ScaledPolygon
from app.services.stl_generator_manifold import _make_finger_holes

WALL_TOP_Z = 33.0


def _circle_poly(radius=4.0, depth_override=None):
    fh = ScaledFingerHole(
        id="fh1", x_mm=0.0, y_mm=0.0, radius_mm=radius,
        shape="circle", depth_override=depth_override,
    )
    return ScaledPolygon(
        id="p1",
        points_mm=[(-30, -30), (30, -30), (30, 30), (-30, 30)],
        label="test",
        finger_holes=[fh],
    )


def _depth_below_surface(cutter):
    # bounding_box() -> (min_x, min_y, min_z, max_x, max_y, max_z)
    bb = cutter.bounding_box()
    return WALL_TOP_Z - bb[2]


class TestCircleDepthOverride:
    def test_default_circle_is_shallow_scoop(self):
        # No override: a small radius scoop stays ~radius deep even though the
        # global cutout_depth is much larger.
        poly = _circle_poly(radius=4.0, depth_override=None)
        config = BinParams(cutout_depth=20.0)
        cutter = _make_finger_holes(
            [poly], config, wall_top_z=WALL_TOP_Z, max_depth=20.0,
            offset_x=0.0, offset_y=0.0,
        )
        assert cutter is not None
        # spherical scoop reaches at most its radius below the surface
        assert _depth_below_surface(cutter) < 4.5

    def test_deep_override_is_honored(self):
        # Explicit override deeper than the radius must carve to that depth.
        poly = _circle_poly(radius=4.0, depth_override=15.0)
        config = BinParams(cutout_depth=20.0)
        cutter = _make_finger_holes(
            [poly], config, wall_top_z=WALL_TOP_Z, max_depth=20.0,
            offset_x=0.0, offset_y=0.0,
        )
        assert cutter is not None
        assert 14.5 < _depth_below_surface(cutter) < 15.5

    def test_shallow_override_still_honored(self):
        # An override smaller than the radius is honored by the sphere path.
        poly = _circle_poly(radius=8.0, depth_override=5.0)
        config = BinParams(cutout_depth=20.0)
        cutter = _make_finger_holes(
            [poly], config, wall_top_z=WALL_TOP_Z, max_depth=20.0,
            offset_x=0.0, offset_y=0.0,
        )
        assert cutter is not None
        assert 4.5 < _depth_below_surface(cutter) < 5.5
