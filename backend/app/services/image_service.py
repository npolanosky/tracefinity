import io
from pathlib import Path
from PIL import Image


def crop_polygon_png(src_img: Image.Image, poly_points, pad: int = 20, max_dim: int = 384) -> bytes | None:
    """Crop the bounding box of a polygon and return it as PNG bytes.

    Used to send a single tool to a namer. Mirrors the thumbnail crop but
    returns bytes instead of writing a file, and keeps a little more detail."""
    try:
        px_xs = [p.x for p in poly_points]
        px_ys = [p.y for p in poly_points]
        left = max(0, int(min(px_xs)) - pad)
        top = max(0, int(min(px_ys)) - pad)
        right = min(src_img.width, int(max(px_xs)) + pad)
        bottom = min(src_img.height, int(max(px_ys)) + pad)
        crop = src_img.crop((left, top, right, bottom))
        longest = max(crop.width, crop.height)
        if longest > max_dim:
            scale = max_dim / longest
            crop = crop.resize((int(crop.width * scale), int(crop.height * scale)), Image.LANCZOS)
        buf = io.BytesIO()
        crop.convert("RGB").save(buf, "PNG")
        return buf.getvalue()
    except Exception:
        return None


def png_bytes_from_file(path: str, max_dim: int = 384) -> bytes | None:
    """Load an image file (e.g. a tool thumbnail) as downsized RGB PNG bytes,
    suitable to hand to a namer. None on any failure."""
    try:
        img = Image.open(path)
        longest = max(img.width, img.height)
        if longest > max_dim:
            scale = max_dim / longest
            img = img.resize((int(img.width * scale), int(img.height * scale)), Image.LANCZOS)
        buf = io.BytesIO()
        img.convert("RGB").save(buf, "PNG")
        return buf.getvalue()
    except Exception:
        return None


def tool_crop_png(
    tool, source_path: str | None, thumbnail_path: str | None, max_dim: int = 384
) -> bytes | None:
    """Best single-tool image for naming a saved tool.

    Prefers the existing thumbnail crop; falls back to cropping the tool's
    bounding box out of its source image by inverting the stored image->mm
    affine. Returns PNG bytes or None."""
    if thumbnail_path and Path(thumbnail_path).exists():
        png = png_bytes_from_file(thumbnail_path, max_dim)
        if png:
            return png

    t = getattr(tool, "source_image_transform", None)
    pts = getattr(tool, "points", None)
    if not source_path or not Path(source_path).exists() or not t or len(t) != 6 or not pts:
        return None
    a, b, c, d, e, f = t
    det = a * e - b * d
    if abs(det) < 1e-9:
        return None

    def to_px(mx: float, my: float) -> tuple[float, float]:
        # inverse of [mx,my] = [a*x+b*y+c, d*x+e*y+f]
        return (
            (e * (mx - c) - b * (my - f)) / det,
            (-d * (mx - c) + a * (my - f)) / det,
        )
    try:
        px = [to_px(p.x, p.y) for p in pts]
        img = Image.open(source_path)
        pad = 20
        left = max(0, int(min(x for x, _ in px)) - pad)
        top = max(0, int(min(y for _, y in px)) - pad)
        right = min(img.width, int(max(x for x, _ in px)) + pad)
        bottom = min(img.height, int(max(y for _, y in px)) + pad)
        if right <= left or bottom <= top:
            return None
        crop = img.crop((left, top, right, bottom))
        longest = max(crop.width, crop.height)
        if longest > max_dim:
            scale = max_dim / longest
            crop = crop.resize((int(crop.width * scale), int(crop.height * scale)), Image.LANCZOS)
        buf = io.BytesIO()
        crop.convert("RGB").save(buf, "PNG")
        return buf.getvalue()
    except Exception:
        return None


def generate_tool_thumbnail(
    src_img: Image.Image, poly_points, tool_id: str, output_dir: Path
) -> str | None:
    """crop and save a tool thumbnail. returns the file path or None."""
    try:
        px_xs = [p.x for p in poly_points]
        px_ys = [p.y for p in poly_points]
        pad = 20
        left = max(0, int(min(px_xs)) - pad)
        top = max(0, int(min(px_ys)) - pad)
        right = min(src_img.width, int(max(px_xs)) + pad)
        bottom = min(src_img.height, int(max(px_ys)) + pad)
        crop = src_img.crop((left, top, right, bottom))
        max_dim = max(crop.width, crop.height)
        if max_dim > 256:
            scale = 256 / max_dim
            crop = crop.resize(
                (int(crop.width * scale), int(crop.height * scale)), Image.LANCZOS
            )
        thumb_file = output_dir / f"{tool_id}.jpg"
        crop.convert("RGB").save(thumb_file, "JPEG", quality=80)
        return str(thumb_file)
    except Exception:
        return None
