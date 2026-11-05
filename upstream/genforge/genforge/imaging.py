import hashlib

from PIL import Image


def resample(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    if image.size == size:
        return image.copy()
    shrinking = size[0] <= image.width and size[1] <= image.height
    method = Image.Resampling.BOX if shrinking else Image.Resampling.NEAREST
    return image.convert("RGBA").resize(size, method)


def pixel_hash(image: Image.Image) -> str:
    rgba = image.convert("RGBA")
    digest = hashlib.sha256(f"{rgba.width}x{rgba.height}:".encode())
    digest.update(rgba.tobytes())
    return "sha256:" + digest.hexdigest()
