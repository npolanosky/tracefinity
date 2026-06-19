"""Tests for paper-detection helpers (corner ordering, aspect targets, quad fit).

These exercise the self-contained geometry helpers on ImageProcessor without
constructing the class (which would load the U2-Net model)."""
import numpy as np

from app.services.image_processor import ImageProcessor

order = lambda pts: ImageProcessor._order_corners(None, np.asarray(pts, dtype=float))
quad = lambda c: ImageProcessor._quad_from_contour(None, np.asarray(c).reshape(-1, 1, 2).astype(np.int32))


class TestTargetAspect:
    def test_known_sizes(self):
        assert round(ImageProcessor._target_aspect("a4"), 3) == 0.707
        assert round(ImageProcessor._target_aspect("a3"), 3) == 0.707
        assert round(ImageProcessor._target_aspect("letter"), 3) == 0.773
        assert round(ImageProcessor._target_aspect("tabloid"), 3) == 0.647

    def test_unknown_or_none(self):
        assert ImageProcessor._target_aspect(None) is None
        assert ImageProcessor._target_aspect("foolscap") is None


class TestOrderCorners:
    def test_axis_aligned(self):
        # input already TL,TR,BR,BL
        out = order([[10, 10], [110, 10], [110, 210], [10, 210]])
        assert out.tolist() == [[10, 10], [110, 10], [110, 210], [10, 210]]

    def test_shuffled_input(self):
        # any permutation must come back TL,TR,BR,BL
        out = order([[110, 210], [10, 10], [10, 210], [110, 10]])
        assert out.tolist() == [[10, 10], [110, 10], [110, 210], [10, 210]]

    def test_rotated_quad_stays_clockwise(self):
        # a square rotated ~30deg about its centre — the sum/diff heuristic
        # would mis-assign corners here; angle ordering must not.
        c = np.array([50.0, 50.0])
        base = np.array([[-30, -30], [30, -30], [30, 30], [-30, 30]], dtype=float)
        th = np.radians(30)
        R = np.array([[np.cos(th), -np.sin(th)], [np.sin(th), np.cos(th)]])
        rot = base @ R.T + c
        out = order(rot)
        # TL is the point with the smallest x+y; winding is clockwise
        tl_idx = int(np.argmin(rot.sum(axis=1)))
        assert np.allclose(out[0], rot[tl_idx])
        # clockwise in image coords (y down) => positive shoelace sum
        x, y = out[:, 0], out[:, 1]
        area2 = np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y)
        assert area2 > 0


class TestQuadFromContour:
    def test_square_contour_returns_four_corners(self):
        sq = [[0, 0], [100, 0], [100, 100], [0, 100]]
        q = quad(sq)
        assert q is not None
        assert q.shape == (4, 2)

    def test_triangle_is_not_a_quad(self):
        # approxPolyDP keeps a triangle at 3 points -> not a quad
        assert quad([[0, 0], [100, 0], [50, 90]]) is None


class TestBrightQuadStrategy:
    def _synthetic_paper(self):
        # black background, a white Letter-ratio sheet inset from the edges
        import cv2
        img = np.zeros((1000, 800, 3), dtype=np.uint8)
        cv2.rectangle(img, (120, 100), (680, 820), (255, 255, 255), -1)  # ~0.78 ratio
        return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    def test_detects_a_clean_sheet(self):
        ip = ImageProcessor.__new__(ImageProcessor)  # skip __init__ (no model load)
        gray = self._synthetic_paper()
        corners = ip._bright_quad_strategy(gray, 1000, 800, 0.773, ImageProcessor.PAPER_STRATEGIES[0])
        assert corners is not None and len(corners) == 4
        xs = [c[0] for c in corners]
        ys = [c[1] for c in corners]
        # corners land near the drawn rectangle (120,100)-(680,820)
        assert min(xs) < 160 and max(xs) > 640
        assert min(ys) < 140 and max(ys) > 780

    def test_strategy_ladder_present(self):
        labels = [s["label"] for s in ImageProcessor.PAPER_STRATEGIES]
        assert "edges" in labels
        assert len(ImageProcessor.PAPER_STRATEGIES) >= 3
