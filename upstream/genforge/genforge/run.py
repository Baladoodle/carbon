"""File-based attempts: retain sources, bound calls and never retry uncertainty."""
from contextlib import contextmanager
from datetime import datetime, timezone
import io
import json
from pathlib import Path

from PIL import Image

from .build import build, source_path
from .files import digest, load_plan, local, write_json
from .provider import GenerationError, Images


def now():
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def lock(root):
    path = root / ".run.lock"
    try:
        stream = path.open("x")
    except FileExistsError:
        raise ValueError("Run is locked. Inspect receipt.json and any running process before removing .run.lock") from None
    try:
        with stream:
            stream.write(now())
        yield
    finally:
        path.unlink()


def input_bytes(root, reference):
    path = local(root, reference["file"]) if "file" in reference else source_path(root, reference["call"])
    data = path.read_bytes()
    if "crop" in reference:
        with Image.open(io.BytesIO(data)) as image:
            x0, y0, x1, y1 = reference["crop"]
            if not (0 <= x0 < x1 <= image.width and 0 <= y0 < y1 <= image.height):
                raise ValueError("Reference crop falls outside its source")
            buffer = io.BytesIO()
            image.crop((x0, y0, x1, y1)).save(buffer, "PNG")
            data = buffer.getvalue()
    if len(data) >= 50 * 1024 * 1024:
        raise ValueError("Reference images must be smaller than 50 MiB")
    return data


def check_source_size(root, call):
    with Image.open(source_path(root, call["id"])) as image:
        if image.size != tuple(call["size"]):
            raise ValueError(f"{call['id']}: source size {image.size} differs from requested {tuple(call['size'])}; source preserved")


def run(root: Path, max_calls: int, client=None):
    plan = load_plan(root)
    with lock(root):
        receipt_path = root / "receipt.json"
        receipt = json.loads(receipt_path.read_text()) if receipt_path.exists() else {
            "version": 1, "plan_hash": plan["hash"], "calls": {}}
        if receipt["plan_hash"] != plan["hash"]:
            raise ValueError("Receipt belongs to a different plan")
        remaining = []
        for call in plan["calls"]:
            previous = receipt["calls"].get(call["id"])
            if previous:
                if previous["status"] != "succeeded":
                    raise ValueError(f"{call['id']} is {previous['status']}; this tool never retries an existing attempt")
                if digest(source_path(root, call["id"]).read_bytes()) != previous["source_hash"]:
                    raise ValueError("Retained source changed; refusing to submit more calls")
                check_source_size(root, call)
            else:
                if source_path(root, call["id"]).exists():
                    raise ValueError("Imported sources already exist; use build rather than run")
                remaining.append(call)
        if len(remaining) > max_calls:
            raise ValueError(f"Plan needs {len(remaining)} calls, exceeding --max-calls {max_calls}")
        if remaining:
            client = client or Images()
            if not client.key:
                raise ValueError("OPENAI_API_KEY is missing; planning and build work without it")
        for call in remaining:
            inputs = [input_bytes(root, ref) for ref in call["inputs"]]
            mask = input_bytes(root, call["mask"]) if call.get("mask") else None
            record = {"status": "pending", "started": now(), "model": call["model"],
                      "quality": call["quality"], "input_hashes": [digest(b) for b in inputs]}
            receipt["calls"][call["id"]] = record
            write_json(receipt_path, receipt)
            try:
                result = client.generate(call, inputs, mask)
                with source_path(root, call["id"]).open("xb") as stream:
                    stream.write(result.image)
            except BaseException as error:
                record["status"] = error.status if isinstance(error, GenerationError) else "indeterminate"
                record["finished"] = now()
                write_json(receipt_path, receipt)
                raise
            record.update(status="succeeded", finished=now(), source_hash=digest(result.image),
                          usage=result.usage, request_id=result.request_id)
            write_json(receipt_path, receipt)
            # A wrong-size parent must stop dependent calls before they can spend.
            check_source_size(root, call)
        return build(root)
