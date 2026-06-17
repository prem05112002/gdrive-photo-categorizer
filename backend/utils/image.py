import io
from pathlib import Path
from datetime import datetime
from typing import Optional

import imagehash
from PIL import Image
import pillow_heif

pillow_heif.register_heif_opener()

RAW_EXTENSIONS = frozenset({".cr2", ".cr3", ".arw", ".nef", ".orf", ".raf", ".dng", ".rw2", ".pef", ".3fr", ".erf"})
IMAGE_EXTENSIONS = frozenset({".jpg", ".jpeg", ".png", ".heic", ".heif", ".tiff", ".tif", ".bmp", ".webp"})
# Common video formats from phones and DSLRs
VIDEO_EXTENSIONS = frozenset({".mp4", ".mov", ".avi", ".mkv", ".m4v", ".3gp", ".mts", ".m2ts", ".wmv", ".hevc"})

# EXIF tag IDs
_EXIF_DATETIME_ORIGINAL = 36867
_EXIF_CAMERA_MODEL = 272


def get_file_type(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in RAW_EXTENSIONS:
        return "raw"
    if ext in VIDEO_EXTENSIONS:
        return "video"
    if ext in {".heic", ".heif"}:
        return "heic"
    if ext in {".jpg", ".jpeg"}:
        return "jpeg"
    if ext == ".png":
        return "png"
    if ext in {".tiff", ".tif"}:
        return "tiff"
    return "other"


def is_supported_file(filename: str) -> bool:
    """Returns True for any file we want to ingest: images, RAW, and video."""
    ext = Path(filename).suffix.lower()
    return ext in IMAGE_EXTENSIONS or ext in RAW_EXTENSIONS or ext in VIDEO_EXTENSIONS


def is_supported_image(filename: str) -> bool:
    """Returns True only for processable image files (excludes RAW and video)."""
    ext = Path(filename).suffix.lower()
    return ext in IMAGE_EXTENSIONS or ext in RAW_EXTENSIONS


def compute_phash(path: Path) -> Optional[str]:
    try:
        img = Image.open(path)
        return str(imagehash.phash(img))
    except Exception:
        return None


def extract_exif(path: Path) -> tuple[Optional[datetime], Optional[str]]:
    try:
        img = Image.open(path)
        raw_exif = img._getexif()  # type: ignore[attr-defined]
        if not raw_exif:
            return None, None

        raw_dt = raw_exif.get(_EXIF_DATETIME_ORIGINAL)
        device = raw_exif.get(_EXIF_CAMERA_MODEL)

        dt = None
        if raw_dt:
            try:
                dt = datetime.strptime(raw_dt, "%Y:%m:%d %H:%M:%S")
            except ValueError:
                pass

        return dt, (device.strip() if device else None)
    except Exception:
        return None, None


def open_for_processing(path: Path, max_long_side: int = 1920) -> Image.Image:
    """
    Open any supported image (JPEG, PNG, HEIC) for face/scene processing.
    Resizes so the longest side is at most max_long_side — reduces memory and speeds up models.
    Returns an RGB PIL Image.
    """
    img = Image.open(path)
    if img.mode not in ("RGB",):
        img = img.convert("RGB")

    w, h = img.size
    if max(w, h) > max_long_side:
        scale = max_long_side / max(w, h)
        img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)

    return img


def image_to_jpeg_bytes(img: Image.Image, quality: int = 90) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def crop_face(img: Image.Image, bbox: tuple[int, int, int, int], padding: float = 0.2) -> bytes:
    """
    Crop a face from an image with padding, return JPEG bytes.
    bbox = (x, y, w, h)
    """
    x, y, w, h = bbox
    pw, ph = int(w * padding), int(h * padding)
    x0 = max(0, x - pw)
    y0 = max(0, y - ph)
    x1 = min(img.width, x + w + pw)
    y1 = min(img.height, y + h + ph)

    cropped = img.crop((x0, y0, x1, y1))
    cropped.thumbnail((256, 256))
    return image_to_jpeg_bytes(cropped)
