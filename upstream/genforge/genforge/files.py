import hashlib
import json
from pathlib import Path
import re
import tempfile


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def digest(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def write_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    # Receipts must never be truncated by an interrupted write.
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False, encoding="utf-8") as stream:
        stream.write(json.dumps(value, indent=2, allow_nan=False) + "\n")
        temporary = Path(stream.name)
    temporary.replace(path)


def local(root: Path, value: str):
    path = (root / value).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError("Plan files must stay inside the run directory")
    return path


def load_plan(root: Path):
    plan = json.loads((root / "plan.json").read_text())
    expected = plan.pop("hash")
    if digest(canonical(plan)) != expected:
        raise ValueError("Plan changed after preparation; create a new plan")
    for relative, expected_hash in plan["files"].items():
        if digest(local(root, relative).read_bytes()) != expected_hash:
            raise ValueError(f"Plan input changed: {relative}")
    if plan.get("version") != 1 or plan.get("kind") not in ("image", "voxel_tiles"):
        raise ValueError("Unknown plan format")
    seen = set()
    for call in plan["calls"]:
        sid = call["id"]
        if not re.fullmatch(r"[a-z0-9_-]+", sid) or sid in seen:
            raise ValueError("Call IDs must be unique, lowercase names")
        for ref in [*call["inputs"], *([call["mask"]] if call.get("mask") else [])]:
            if "call" in ref and ref["call"] not in seen:
                raise ValueError("Call inputs must reference an earlier call")
            if "file" in ref and ref["file"] not in plan["files"]:
                raise ValueError("File input is not covered by the plan hash")
        seen.add(sid)
    plan["hash"] = expected
    return plan
