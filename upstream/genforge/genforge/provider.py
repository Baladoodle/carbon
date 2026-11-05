"""Direct Images API transport. A failed or uncertain call is never retried."""
import base64
from dataclasses import dataclass
import io
import json
import os
from pathlib import Path
import shlex
import urllib.error
import urllib.request
import uuid

from PIL import Image

API_ROOT = "https://api.openai.com/v1"
DEFAULT_MODEL = "gpt-image-2.5-flare"


class GenerationError(RuntimeError):
    def __init__(self, message, status="indeterminate"):
        super().__init__(message)
        self.status = status


@dataclass
class Result:
    image: bytes
    usage: dict | None
    request_id: str | None


def load_env(path: Path, environ=None):
    """Read literal .env assignments; existing environment values take precedence."""
    environ = os.environ if environ is None else environ
    if not path.exists():
        return
    allowed = {"OPENAI_API_KEY", "GENFORGE_IMAGE_MODEL"}
    for number, raw in enumerate(path.read_text().splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:]
        name, separator, value = line.partition("=")
        name = name.strip()
        if name not in allowed:
            continue
        if not separator:
            raise ValueError(f"Invalid .env assignment on line {number}")
        try:
            parts = shlex.split(value, comments=True)
        except ValueError:
            raise ValueError(f"Invalid .env quoting on line {number}") from None
        if len(parts) > 1:
            raise ValueError(f"Invalid .env value on line {number}")
        environ.setdefault(name, parts[0] if parts else "")


def multipart(fields, images, mask=None):
    boundary = "----Genforge" + uuid.uuid4().hex
    body = io.BytesIO()
    for name, value in fields.items():
        body.write(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    files = [("image[]", f"reference-{i}.png", data) for i, data in enumerate(images)]
    if mask is not None:
        files.append(("mask", "mask.png", mask))
    for name, filename, data in files:
        body.write(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{filename}"\r\nContent-Type: image/png\r\n\r\n'.encode())
        body.write(data)
        body.write(b"\r\n")
    body.write(f"--{boundary}--\r\n".encode())
    return body.getvalue(), f"multipart/form-data; boundary={boundary}"


def send(request, timeout):
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read(), response.headers.get("x-request-id")


class Images:
    def __init__(self, key=None, transport=send, timeout=600):
        self.key = (key if key is not None else os.environ.get("OPENAI_API_KEY", "")).strip()
        self.transport, self.timeout = transport, timeout

    def generate(self, call, images=(), mask=None):
        if not self.key:
            raise GenerationError("Set OPENAI_API_KEY in the environment or an ignored .env file", "not_submitted")
        if mask is not None and not images:
            raise ValueError("A mask needs an edit image")
        fields = {"model": call["model"], "prompt": call["prompt"], "n": 1,
                  "size": "x".join(map(str, call["size"])), "quality": call["quality"],
                  "background": call["background"], "output_format": "png"}
        if images:
            body, content_type = multipart(fields, images, mask)
            endpoint = "/images/edits"
        else:
            body, content_type = json.dumps(fields).encode(), "application/json"
            endpoint = "/images/generations"
        request = urllib.request.Request(API_ROOT + endpoint, data=body, method="POST",
                                         headers={"Authorization": "Bearer " + self.key, "Content-Type": content_type})
        try:
            raw, request_id = self.transport(request, self.timeout)
        except urllib.error.HTTPError as error:
            status = "indeterminate" if error.code >= 500 or error.code == 408 else "provider_failed"
            # Provider text may echo submitted values. Never log the raw body or request.
            raise GenerationError(f"Image API returned HTTP {error.code}; no retry was attempted", status) from None
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
            raise GenerationError("Image API outcome unknown after a transport failure; do not retry this run") from None
        try:
            response = json.loads(raw)
            image = base64.b64decode(response["data"][0]["b64_json"], validate=True)
            with Image.open(io.BytesIO(image)) as decoded:
                if decoded.format != "PNG":
                    raise ValueError("not PNG")
                decoded.verify()
        except (ValueError, KeyError, IndexError, TypeError, OSError):
            raise GenerationError("Image API returned an unreadable image; it may have charged the call") from None
        return Result(image, response.get("usage"), request_id)
