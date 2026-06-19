from __future__ import annotations

import cv2
import logging
import math
import numpy as np
from pathlib import Path

from app.constants import PAPER_SIZES, PaperSize

logger = logging.getLogger(__name__)

PX_PER_MM = 10


def _quad_aspect_ratio(
    corners: list[tuple[float, float]], principal_point: tuple[float, float]
) -> float | None:
    """estimate width/height of the rectangle behind a projected quad.

    Zhang & He, "Whiteboard scanning and image enhancement": with the
    principal point assumed at the image centre, the focal length and the
    rectangle's aspect ratio have a closed-form solution from the four
    corners. falls back to the affine formula when the quad has no
    perspective (vanishing points at infinity). returns None when degenerate.

    corners ordered TL, TR, BR, BL."""
    u0, v0 = principal_point
    tl, tr, br, bl = corners
    m1 = np.array([tl[0], tl[1], 1.0])
    m2 = np.array([tr[0], tr[1], 1.0])
    m3 = np.array([bl[0], bl[1], 1.0])
    m4 = np.array([br[0], br[1], 1.0])

    denom2 = np.cross(m2, m4) @ m3
    denom3 = np.cross(m3, m4) @ m2
    if abs(denom2) < 1e-9 or abs(denom3) < 1e-9:
        return None
    k2 = (np.cross(m1, m4) @ m3) / denom2
    k3 = (np.cross(m1, m4) @ m2) / denom3

    n2 = k2 * m2 - m1
    n3 = k3 * m3 - m1

    # n[2] = k - 1 is the depth disparity along that edge pair
    flat2 = abs(n2[2]) < 1e-4
    flat3 = abs(n3[2]) < 1e-4

    if flat2 and flat3:
        # paper parallel to the image plane: ratio is the px length ratio
        len2 = math.hypot(n2[0], n2[1])
        len3 = math.hypot(n3[0], n3[1])
        if len3 < 1e-9:
            return None
        return len2 / len3

    if flat2 or flat3:
        # one edge pair parallel to the image plane: focal length (and with
        # it the ratio) is indeterminate from the quad alone
        return None

    f_sq = -(
        (n2[0] * n3[0] - (n2[0] * n3[2] + n2[2] * n3[0]) * u0 + n2[2] * n3[2] * u0 * u0)
        + (n2[1] * n3[1] - (n2[1] * n3[2] + n2[2] * n3[1]) * v0 + n2[2] * n3[2] * v0 * v0)
    ) / (n2[2] * n3[2])
    if not np.isfinite(f_sq) or f_sq <= 1.0:
        return None
    f = math.sqrt(f_sq)

    a = np.array([[f, 0.0, u0], [0.0, f, v0], [0.0, 0.0, 1.0]])
    ata_inv = np.linalg.inv(a @ a.T)
    num = float(n2 @ ata_inv @ n2)
    den = float(n3 @ ata_inv @ n3)
    if den <= 0 or num <= 0:
        return None
    return math.sqrt(num / den)


def pick_paper_orientation(
    corners: list[tuple[float, float]],
    width_mm: float,
    height_mm: float,
    principal_point: tuple[float, float] | None = None,
) -> tuple[float, float]:
    """return (w, h) with the paper's long axis matched to the photographed quad.

    px edge lengths lie under perspective: a foreshortened long edge can
    project shorter than the short edge, flipping a naive comparison. the
    rectangle's true aspect ratio is recovered from the quad instead and
    matched against the paper's two orientations."""
    src = np.array(corners, dtype=np.float64)
    if principal_point is None:
        principal_point = (float(src[:, 0].mean()), float(src[:, 1].mean()))

    estimated = _quad_aspect_ratio(corners, principal_point)
    if estimated is not None and estimated > 0:
        ratio = width_mm / height_mm
        if abs(math.log(estimated / ratio)) <= abs(math.log(estimated * ratio)):
            return width_mm, height_mm
        return height_mm, width_mm

    # degenerate quad: fall back to the px edge comparison
    top = np.linalg.norm(src[1] - src[0])
    left = np.linalg.norm(src[3] - src[0])
    return (height_mm, width_mm) if top > left else (width_mm, height_mm)


class ImageProcessor:
    def __init__(self):
        from rembg import new_session
        from app.services.ort_runtime import get_onnx_providers
        logger.info("loading U2-Net Portable for paper detection")
        self._tool_mask_session = new_session("u2netp", providers=get_onnx_providers())

    def _get_tool_mask(self, image_path: str) -> np.ndarray:
        """get a rough tool mask via U2-Net Portable for paper detection."""
        from rembg import remove
        from PIL import Image

        img = Image.open(image_path).convert("RGB")
        result = remove(img, session=self._tool_mask_session)
        alpha = np.array(result)[:, :, 3]
        _, mask = cv2.threshold(alpha, 127, 255, cv2.THRESH_BINARY)
        return mask

    # Strategy ladder for paper detection. Each rung is a parameter set tried in
    # order (cascading on failure); the "re-detect" button advances to the next
    # rung. The "saliency" rung uses the U2-Net mask directly: when the salient
    # object IS the bright sheet (tool-on-paper photos, where the paper is the
    # dominant object), its filled outline is the cleanest paper boundary. The
    # bright/* rungs threshold the image; close fills tool/shadow holes, OPEN
    # snaps thin bridges to background specks that otherwise balloon the region
    # to the frame edge; then a 4-point quad is fit to the cleaned contour.
    PAPER_STRATEGIES = [
        {"label": "saliency", "thresh": (), "close": 0, "open": 0, "amin": 0.10, "amax": 0.97, "tol": 0.18},
        {"label": "bright/standard", "thresh": (215, 200, 190, 180), "close": 5, "open": 9, "amin": 0.08, "amax": 0.93, "tol": 0.12},
        {"label": "bright/dim", "thresh": (175, 160, 145, 130), "close": 7, "open": 13, "amin": 0.06, "amax": 0.96, "tol": 0.18},
        {"label": "bright/loose", "thresh": (205, 185, 165, 150), "close": 11, "open": 5, "amin": 0.05, "amax": 0.97, "tol": 0.30},
        {"label": "edges", "thresh": (), "close": 0, "open": 0, "amin": 0.05, "amax": 0.97, "tol": 0.30},  # canny/adaptive fallback
    ]

    def detect_paper_corners(
        self, image_path: str, paper_size: PaperSize | None = None, attempt: int | None = None
    ) -> tuple[list[tuple[float, float]] | None, int | None]:
        """detect paper corners by masking out tools first. Returns
        (corners, strategy_index). When the paper size is known its aspect
        ratio constrains the search. attempt=None cascades through every
        strategy and returns the first that finds the sheet; a specific attempt
        runs just that rung (used by the user-driven re-detect/retry button)."""
        img = cv2.imread(image_path)
        if img is None:
            logger.warning("paper detection: could not read %s", image_path)
            return None, None

        h, w = img.shape[:2]
        tool_mask = self._get_tool_mask(image_path)
        gray_full = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

        # U2-Net saliency can lock onto EITHER the dark tool or the bright sheet
        # (on tool-on-paper photos the paper is the dominant object, so the mask
        # becomes a paper silhouette with the tool punched out as a hole).
        # Compare brightness inside/outside the mask: if the salient region is
        # brighter, it's the paper -- keep it (blacking it out would destroy the
        # very thing we detect) and let the "saliency" rung fit its outline.
        # Otherwise it's a dark tool: black it out so it can't fragment the paper.
        sal = tool_mask > 0
        salient_is_paper = bool(
            sal.any() and (~sal).any()
            and gray_full[sal].mean() - gray_full[~sal].mean() > 15
        )
        if not salient_is_paper:
            img[sal] = [0, 0, 0]
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        target = self._target_aspect(paper_size)
        n = len(self.PAPER_STRATEGIES)

        def run(idx: int, asp: float | None) -> list[tuple[float, float]] | None:
            p = self.PAPER_STRATEGIES[idx]
            if p["label"] == "saliency":
                if not salient_is_paper:
                    return None
                return self._paper_from_saliency(tool_mask, h, w, asp, p)
            if p["label"] == "edges":
                return self._detect_paper_edges(gray, img, h, w, asp)
            return self._bright_quad_strategy(gray, h, w, asp, p)

        if attempt is not None:
            idx = attempt % n
            corners = run(idx, target) or (run(idx, None) if target is not None else None)
            if corners:
                logger.info("paper detected on retry strategy %d (%s)", idx, self.PAPER_STRATEGIES[idx]["label"])
                return corners, idx
            logger.warning("paper detection failed on retry strategy %d for %s", idx, image_path)
            return None, None

        # initial detection: cascade through the ladder, with the aspect target
        # first, then a looser unconstrained pass.
        for asp in (target, None) if target is not None else (None,):
            for idx in range(n):
                corners = run(idx, asp)
                if corners:
                    logger.info("paper detected on strategy %d (%s)", idx, self.PAPER_STRATEGIES[idx]["label"])
                    return corners, idx
        logger.warning("paper detection found nothing for %s (all strategies)", image_path)
        return None, None

    @staticmethod
    def _target_aspect(paper_size: PaperSize | None) -> float | None:
        """expected short/long edge ratio for a known sheet, else None."""
        if paper_size is None or paper_size not in PAPER_SIZES:
            return None
        a, b = PAPER_SIZES[paper_size]
        return min(a, b) / max(a, b)

    def _paper_from_saliency(
        self, mask: np.ndarray, h: int, w: int, target_aspect: float | None, p: dict
    ) -> list[tuple[float, float]] | None:
        """fit the paper quad to the U2-Net saliency mask outline.

        Used only when the salient region is the bright sheet itself. Smooths
        the (ragged, tool-holed) silhouette with a close, takes its external
        contour -- holes from the tool are ignored by RETR_EXTERNAL -- and fits
        a 4-point quad. Aspect/area gates keep it from accepting a non-sheet
        blob."""
        k = max(5, int(min(h, w) * 0.01) | 1)
        m = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((k, k), np.uint8), iterations=2)
        contours, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        best = None
        for c in sorted(contours, key=cv2.contourArea, reverse=True)[:3]:
            area = cv2.contourArea(c)
            if area < h * w * p["amin"] or area > h * w * p["amax"]:
                continue
            rect = cv2.minAreaRect(c)
            rw, rh = rect[1]
            if rw == 0 or rh == 0:
                continue
            aspect = min(rw, rh) / max(rw, rh)
            if target_aspect is not None:
                if abs(aspect - target_aspect) > p["tol"]:
                    continue
            elif aspect < 0.5 or aspect > 0.95:
                continue
            quad = self._quad_from_contour(c)
            corners_src = quad if quad is not None else cv2.boxPoints(rect).astype(float)
            score = abs(aspect - target_aspect) if target_aspect is not None else -area
            if best is None or score < best[0]:
                best = (score, corners_src)
        if best is None:
            return None
        corners = self._order_corners(np.asarray(best[1], dtype=float))
        return [(float(x), float(y)) for x, y in corners]

    def _bright_quad_strategy(
        self, gray: np.ndarray, h: int, w: int, target_aspect: float | None, p: dict
    ) -> list[tuple[float, float]] | None:
        """find the paper as a bright quad using one parameter rung."""
        best = None  # (score, corners_src, aspect)
        ck = p["close"] | 1
        ok = p["open"] | 1
        for tv in p["thresh"]:
            _, th = cv2.threshold(gray, tv, 255, cv2.THRESH_BINARY)
            th = cv2.morphologyEx(th, cv2.MORPH_CLOSE, np.ones((ck, ck), np.uint8), iterations=2)
            th = cv2.morphologyEx(th, cv2.MORPH_OPEN, np.ones((ok, ok), np.uint8), iterations=1)
            contours, _ = cv2.findContours(th, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            for c in sorted(contours, key=cv2.contourArea, reverse=True)[:5]:
                area = cv2.contourArea(c)
                if area < h * w * p["amin"] or area > h * w * p["amax"]:
                    continue
                rect = cv2.minAreaRect(c)
                rw, rh = rect[1]
                if rw == 0 or rh == 0:
                    continue
                aspect = min(rw, rh) / max(rw, rh)
                if target_aspect is not None:
                    if abs(aspect - target_aspect) > p["tol"]:
                        continue
                elif aspect < 0.55 or aspect > 0.9:
                    continue
                quad = self._quad_from_contour(c)
                corners_src = quad if quad is not None else cv2.boxPoints(rect).astype(float)
                # prefer the closest aspect match (or the largest with no target)
                score = abs(aspect - target_aspect) if target_aspect is not None else -area
                if best is None or score < best[0]:
                    best = (score, corners_src, aspect)
        if best is None:
            return None
        corners = self._order_corners(np.asarray(best[1], dtype=float))
        return [(float(x), float(y)) for x, y in corners]

    def _detect_paper_edges(
        self, gray: np.ndarray, img: np.ndarray, h: int, w: int, target_aspect: float | None
    ) -> list[tuple[float, float]] | None:
        """edge/contour fallback (canny + adaptive threshold)."""
        min_area = (h * w) * 0.05
        max_area = (h * w) * 0.97
        edge_margin = int(min(h, w) * 0.02)
        for edges in (
            self._detect_canny(gray, 50, 150),
            self._detect_canny(gray, 30, 100),
            self._detect_adaptive_threshold(gray),
            self._detect_saturation(img),
        ):
            if edges is None:
                continue
            result = self._find_paper_contour(edges, min_area, max_area, edge_margin, h, w, target_aspect)
            if result:
                return result
        return None

    def _detect_bright_region(
        self, img: np.ndarray, gray: np.ndarray,
        min_area: float, max_area: float, margin: int, h: int, w: int,
        target_aspect: float | None = None,
    ) -> list[tuple[float, float]] | None:
        """detect paper by finding bright white region"""
        # try all thresholds and pick the largest valid candidate
        best_result = None
        best_area = 0
        for thresh_val in [200, 190, 180]:
            result, area = self._try_brightness_threshold(
                gray, thresh_val, min_area, max_area, margin, h, w, target_aspect
            )
            if result and area > best_area:
                best_result = result
                best_area = area
        return best_result

    def _try_brightness_threshold(
        self, gray: np.ndarray, thresh_val: int,
        min_area: float, max_area: float, margin: int, h: int, w: int,
        target_aspect: float | None = None,
    ) -> tuple[list[tuple[float, float]] | None, float]:
        """try to find paper at a specific brightness threshold. returns (corners, area)."""
        _, thresh = cv2.threshold(gray, thresh_val, 255, cv2.THRESH_BINARY)

        # two-stage close: small kernel for noise, large kernel to bridge tool gaps
        small_kernel = np.ones((3, 3), np.uint8)
        thresh = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, small_kernel, iterations=1)
        large_k = max(5, int(max(h, w) * 0.02) | 1)  # ~2% of image, must be odd
        large_kernel = np.ones((large_k, large_k), np.uint8)
        thresh = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, large_kernel, iterations=1)

        contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        # build candidate list: individual contours + merged convex hull
        # the hull bridges gaps where tools split paper into separate bright regions
        candidates = list(sorted(contours, key=cv2.contourArea, reverse=True)[:10])
        min_fragment = (h * w) * 0.005
        fragments = [c for c in contours if cv2.contourArea(c) >= min_fragment]
        if len(fragments) >= 2:
            hull = cv2.convexHull(np.vstack(fragments))
            candidates.insert(0, hull)

        best = None
        best_area = 0
        best_score = None  # lower aspect error is better when a target is known

        for contour in candidates:
            area = cv2.contourArea(contour)
            if area < min_area or area > max_area:
                continue

            rect = cv2.minAreaRect(contour)
            box = cv2.boxPoints(rect)
            box = np.int32(box)

            # skip if any corner touches image boundary
            box_margin = margin * 2
            if np.any(box[:, 0] < box_margin) or np.any(box[:, 0] > w - box_margin):
                continue
            if np.any(box[:, 1] < box_margin) or np.any(box[:, 1] > h - box_margin):
                continue

            rect_mask = np.zeros(gray.shape, dtype=np.uint8)
            cv2.fillPoly(rect_mask, [box], 255)
            bright_pixels = cv2.countNonZero(cv2.bitwise_and(thresh, rect_mask))
            total_pixels = cv2.countNonZero(rect_mask)
            fill_ratio = bright_pixels / total_pixels if total_pixels > 0 else 0
            if fill_ratio < 0.35:
                logger.debug("paper candidate rejected: fill_ratio=%.2f at thresh=%d", fill_ratio, thresh_val)
                continue

            # check aspect ratio is paper-like (A-series=0.707, Letter=0.77, Tabloid=0.65)
            rect_w, rect_h = rect[1]
            if rect_w == 0 or rect_h == 0:
                continue
            aspect = min(rect_w, rect_h) / max(rect_w, rect_h)
            if target_aspect is not None:
                # known sheet: the measured ratio should be near it, but allow a
                # wide band so perspective skew doesn't reject a valid sheet
                if abs(aspect - target_aspect) > 0.15:
                    continue
            elif aspect < 0.55 or aspect > 0.85:
                continue

            # bright-background guard: paper should be brighter than what
            # surrounds it. If the ring just outside the box is nearly as bright
            # as the inside, the candidate bled into a bright table/background
            # (the classic paper-on-white-table failure) -> reject.
            ksize = box_margin * 2 + 1
            ring = cv2.subtract(
                cv2.dilate(rect_mask, np.ones((ksize, ksize), np.uint8)), rect_mask
            )
            if cv2.countNonZero(ring) > 0:
                inside_mean = cv2.mean(gray, mask=rect_mask)[0]
                ring_mean = cv2.mean(gray, mask=ring)[0]
                if inside_mean - ring_mean < 15:
                    logger.debug(
                        "paper candidate rejected: not brighter than surroundings "
                        "(in=%.0f out=%.0f)", inside_mean, ring_mean
                    )
                    continue

            # refine to the contour's true 4 corners; fall back to the box
            quad = self._quad_from_contour(contour)
            corners_src = quad if quad is not None else box.astype(float)

            if target_aspect is not None:
                # pick the closest aspect match (tie-break on area)
                score = abs(aspect - target_aspect)
                if best_score is None or score < best_score or (score == best_score and area > best_area):
                    best = (corners_src, aspect, fill_ratio)
                    best_score = score
                    best_area = area
            elif area > best_area:
                # no target: prefer the largest valid candidate (legacy behaviour)
                best = (corners_src, aspect, fill_ratio)
                best_area = area

        if best:
            corners_src, aspect, fill_ratio = best
            corners = self._order_corners(np.asarray(corners_src, dtype=float))
            result = [(float(c[0]), float(c[1])) for c in corners]
            logger.info("paper detected: thresh=%d aspect=%.2f fill=%.2f area=%.0f", thresh_val, aspect, fill_ratio, best_area)
            return result, best_area

        logger.debug("no paper found at thresh=%d", thresh_val)
        return None, 0

    def _find_paper_contour(
        self, edges: np.ndarray, min_area: float, max_area: float, margin: int, h: int, w: int,
        target_aspect: float | None = None,
    ) -> list[tuple[float, float]] | None:
        """find paper rectangle from edge image"""
        kernel = np.ones((3, 3), np.uint8)
        edges = cv2.dilate(edges, kernel, iterations=2)
        edges = cv2.erode(edges, kernel, iterations=1)

        contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:10]:
            area = cv2.contourArea(contour)
            if area < min_area or area > max_area:
                continue

            # skip if touching image boundary
            x, y, cw, ch = cv2.boundingRect(contour)
            if x < margin or y < margin or x + cw > w - margin or y + ch > h - margin:
                continue

            peri = cv2.arcLength(contour, True)
            approx = cv2.approxPolyDP(contour, 0.02 * peri, True)

            if len(approx) == 4 and self._is_roughly_rectangular(approx):
                if target_aspect is not None:
                    rect_w, rect_h = cv2.minAreaRect(approx)[1]
                    if rect_w == 0 or rect_h == 0:
                        continue
                    aspect = min(rect_w, rect_h) / max(rect_w, rect_h)
                    if abs(aspect - target_aspect) > 0.15:
                        continue
                corners = self._order_corners(approx.reshape(4, 2))
                return [(float(c[0]), float(c[1])) for c in corners]

        return None

    def _is_roughly_rectangular(self, approx: np.ndarray) -> bool:
        """check if 4-point contour is roughly rectangular (not too skewed)"""
        pts = approx.reshape(4, 2)
        # check angles are roughly 90 degrees
        for i in range(4):
            p1 = pts[i]
            p2 = pts[(i + 1) % 4]
            p3 = pts[(i + 2) % 4]
            v1 = p1 - p2
            v2 = p3 - p2
            cos_angle = np.dot(v1, v2) / (np.linalg.norm(v1) * np.linalg.norm(v2) + 1e-6)
            # angle should be close to 90 degrees (cos ~= 0), allow up to 30 degree deviation
            if abs(cos_angle) > 0.5:
                return False
        return True

    def _detect_canny(self, gray: np.ndarray, low: int, high: int) -> np.ndarray:
        """standard canny edge detection"""
        blur = cv2.GaussianBlur(gray, (5, 5), 0)
        return cv2.Canny(blur, low, high)

    def _detect_adaptive_threshold(self, gray: np.ndarray) -> np.ndarray | None:
        """adaptive threshold for varying lighting conditions"""
        blur = cv2.GaussianBlur(gray, (5, 5), 0)
        thresh = cv2.adaptiveThreshold(
            blur, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 11, 2
        )
        return cv2.Canny(thresh, 50, 150)

    def _detect_saturation(self, img: np.ndarray) -> np.ndarray | None:
        """detect paper using saturation channel (paper is usually low saturation)"""
        hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
        sat = hsv[:, :, 1]
        _, thresh = cv2.threshold(sat, 30, 255, cv2.THRESH_BINARY_INV)
        return cv2.Canny(thresh, 50, 150)

    def _order_corners(self, pts: np.ndarray) -> np.ndarray:
        """order corners clockwise as top-left, top-right, bottom-right,
        bottom-left. Angle-sorts around the centroid so it stays correct for
        rotated/skewed quads -- the classic sum/diff heuristic only holds for
        near axis-aligned rectangles and swaps corners once the paper is
        rotated past ~45deg in frame."""
        pts = np.asarray(pts, dtype="float32").reshape(-1, 2)
        c = pts.mean(axis=0)
        # consistent rotational cycle around the centroid
        angles = np.arctan2(pts[:, 1] - c[1], pts[:, 0] - c[0])
        pts = pts[np.argsort(angles)]
        # start the cycle at the corner nearest the image top-left (min x+y)
        start = int(np.argmin(pts.sum(axis=1)))
        pts = np.roll(pts, -start, axis=0)
        # force clockwise winding (TL -> TR -> BR -> BL) in image coords (y down)
        if pts[1][1] > pts[3][1]:
            pts = pts[[0, 3, 2, 1]]
        return pts.astype("float32")

    def _quad_from_contour(self, contour: np.ndarray) -> np.ndarray | None:
        """fit a 4-point convex quad to a contour via approxPolyDP -- the
        paper's true corners, not the enclosing minAreaRect box (which rounds
        outward and squares off the perspective quad). Returns 4x2 or None."""
        peri = cv2.arcLength(contour, True)
        if peri <= 0:
            return None
        for eps in (0.02, 0.03, 0.05, 0.08):
            approx = cv2.approxPolyDP(contour, eps * peri, True)
            if len(approx) == 4 and cv2.isContourConvex(approx):
                return approx.reshape(4, 2).astype(float)
        return None

    def apply_perspective_correction(
        self,
        image_path: str,
        corners: list[tuple[float, float]],
        paper_size: PaperSize,
    ) -> tuple[str, float]:
        """warp image to top-down view and return output path + scale factor.
        includes the full visible area beyond the paper so oversized tools
        are captured. paper is used for scale only."""
        img = cv2.imread(image_path)
        src = np.array(corners, dtype="float32")

        width_mm, height_mm = PAPER_SIZES[paper_size]
        h_img, w_img = img.shape[:2]
        width_mm, height_mm = pick_paper_orientation(
            corners, width_mm, height_mm, principal_point=(w_img / 2, h_img / 2)
        )

        paper_w = round(width_mm * PX_PER_MM)
        paper_h = round(height_mm * PX_PER_MM)

        dst = np.array(
            [
                [0, 0],
                [paper_w, 0],
                [paper_w, paper_h],
                [0, paper_h],
            ],
            dtype="float32",
        )

        M = cv2.getPerspectiveTransform(src, dst)

        # transform full source image corners to find how much area is visible
        h_src, w_src = img.shape[:2]
        img_corners = np.array(
            [[0, 0], [w_src, 0], [w_src, h_src], [0, h_src]],
            dtype="float32",
        ).reshape(-1, 1, 2)
        warped_corners = cv2.perspectiveTransform(img_corners, M).reshape(-1, 2)

        # cap to avoid extreme warp artifacts at vanishing points
        max_extent = max(paper_w, paper_h) * 3
        warped_corners = np.clip(warped_corners, -max_extent, max_extent)

        min_x = min(0.0, float(warped_corners[:, 0].min()))
        min_y = min(0.0, float(warped_corners[:, 1].min()))
        max_x = max(float(paper_w), float(warped_corners[:, 0].max()))
        max_y = max(float(paper_h), float(warped_corners[:, 1].max()))

        # translate so all coords are positive
        tx, ty = -min_x, -min_y
        T = np.array([[1, 0, tx], [0, 1, ty], [0, 0, 1]], dtype="float64")
        M_full = T @ M

        out_w = int(np.ceil(max_x + tx))
        out_h = int(np.ceil(max_y + ty))

        warped = cv2.warpPerspective(img, M_full, (out_w, out_h))

        base = Path(image_path)
        output_dir = base.parent.parent / "processed"
        output_path = output_dir / f"{base.stem}_corrected{base.suffix}"
        cv2.imwrite(str(output_path), warped)

        scale_factor = 1.0 / PX_PER_MM
        return str(output_path), scale_factor

    def debug_contour_detection(
        self, image_path: str, output_dir: Path
    ) -> dict:
        """run contour detection and save debug images for each step"""
        img = cv2.imread(image_path)
        if img is None:
            return {"error": "could not read image"}

        h, w = img.shape[:2]
        results = {}

        # step 1: grayscale
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        cv2.imwrite(str(output_dir / "01_gray.jpg"), gray)
        results["gray"] = "01_gray.jpg"

        # step 2: CLAHE normalized
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        normalized = clahe.apply(gray)
        cv2.imwrite(str(output_dir / "02_clahe.jpg"), normalized)
        results["clahe"] = "02_clahe.jpg"

        # step 3: blur
        blur = cv2.GaussianBlur(normalized, (7, 7), 0)
        cv2.imwrite(str(output_dir / "03_blur.jpg"), blur)
        results["blur"] = "03_blur.jpg"

        # step 4: canny edges
        edges = cv2.Canny(blur, 30, 100)
        cv2.imwrite(str(output_dir / "04_canny.jpg"), edges)
        results["canny"] = "04_canny.jpg"

        # step 5: dilate edges
        kernel = np.ones((5, 5), np.uint8)
        dilated = cv2.dilate(edges, kernel, iterations=2)
        cv2.imwrite(str(output_dir / "05_dilated.jpg"), dilated)
        results["dilated"] = "05_dilated.jpg"

        # step 6: close gaps
        closed = cv2.morphologyEx(dilated, cv2.MORPH_CLOSE, kernel, iterations=3)
        cv2.imwrite(str(output_dir / "06_closed.jpg"), closed)
        results["closed"] = "06_closed.jpg"

        # step 7: flood fill from corners
        filled = closed.copy()
        mask = np.zeros((h + 2, w + 2), np.uint8)
        cv2.floodFill(filled, mask, (0, 0), 255)
        filled_inv = cv2.bitwise_not(filled)
        final_mask = closed | filled_inv
        cv2.imwrite(str(output_dir / "07_filled.jpg"), final_mask)
        results["filled"] = "07_filled.jpg"

        # step 8: cleanup
        final_clean = cv2.morphologyEx(final_mask, cv2.MORPH_OPEN, kernel, iterations=1)
        cv2.imwrite(str(output_dir / "08_final.jpg"), final_clean)
        results["final"] = "08_final.jpg"

        # step 9: contours on original
        contours, _ = cv2.findContours(final_clean, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        contour_img = img.copy()
        cv2.drawContours(contour_img, contours, -1, (0, 255, 0), 2)
        cv2.imwrite(str(output_dir / "09_contours.jpg"), contour_img)
        results["contours"] = "09_contours.jpg"
        results["contour_count"] = len(contours)
        results["contour_areas"] = sorted([cv2.contourArea(c) for c in contours], reverse=True)[:10]

        return results

