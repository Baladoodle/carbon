import base64
import io
import json
from pathlib import Path

import pytest
from PIL import Image, ImageDraw

from genforge import filters
from genforge.build import build
from genforge.cli import main
from genforge.files import load_plan
from genforge.plans import image_plan, tiles_plan
from genforge.provider import Images
from genforge.run import run
from genforge.walls import draft, layout

MATERIAL = json.loads((Path(__file__).parents[1] / "examples/meadow.json").read_text())


def image_transport(request, timeout):
    data = json.loads(request.data)
    stream = io.BytesIO()
    image = Image.new("RGBA", tuple(map(int, data["size"].split("x"))))
    ImageDraw.Draw(image).rectangle((300, 200, 700, 800), fill=(100, 130, 70, 255))
    image.save(stream, "PNG")
    return json.dumps({"data": [{"b64_json": base64.b64encode(stream.getvalue()).decode()}]}).encode(), "fake"


def plan_image(path):
    return image_plan(path, "A chunky stone", (1024, 1024), (16, 16), preset="texture")


def test_image_run_retains_source_and_repeated_run_does_not_pay_again(tmp_path):
    root = tmp_path / "item"
    plan_image(root)
    calls = []
    def transport(*args):
        calls.append(1)
        return image_transport(*args)
    client = Images("test-only", transport=transport)
    run(root, 1, client)
    run(root, 0, client)
    assert len(calls) == 1
    assert Image.open(root / "sources/image.png").size == (1024, 1024)
    assert Image.open(root / "output/image.png").size == (16, 16)
    provenance = json.loads((root / "output/provenance.json").read_text())
    assert provenance["sources"]["image"]["origin"] == "generated"
    assert "test-only" not in (root / "receipt.json").read_text()


def test_call_ceiling_blocks_all_submission(tmp_path):
    root = tmp_path / "tiles"
    tiles_plan(root, MATERIAL)
    with pytest.raises(ValueError, match="exceeding"):
        run(root, 2, Images("test-only", transport=lambda *_: pytest.fail("provider contacted")))
    assert not (root / "receipt.json").exists()


def test_uncertain_attempt_cannot_be_retried(tmp_path):
    root = tmp_path / "item"
    plan_image(root)
    calls = []
    def fail(*_):
        calls.append(1)
        raise TimeoutError()
    with pytest.raises(RuntimeError, match="unknown"):
        run(root, 1, Images("test-only", transport=fail))
    assert json.loads((root / "receipt.json").read_text())["calls"]["image"]["status"] == "indeterminate"
    with pytest.raises(ValueError, match="never retries"):
        run(root, 1, Images("test-only", transport=fail))
    assert len(calls) == 1


def test_plan_and_input_tampering_are_rejected(tmp_path):
    root = tmp_path / "item"
    plan_image(root)
    (root / "inputs/prompt.txt").write_text("changed")
    with pytest.raises(ValueError, match="input changed"):
        load_plan(root)
    other = tmp_path / "other"
    plan_image(other)
    data = json.loads((other / "plan.json").read_text())
    data["calls"][0]["quality"] = "max"
    (other / "plan.json").write_text(json.dumps(data))
    with pytest.raises(ValueError, match="Plan changed"):
        load_plan(other)


def test_wrong_size_source_is_retained_and_not_regenerated(tmp_path):
    root = tmp_path / "item"
    plan_image(root)
    def transport(*_):
        stream = io.BytesIO(); Image.new("RGB", (64, 64)).save(stream, "PNG")
        return json.dumps({"data": [{"b64_json": base64.b64encode(stream.getvalue()).decode()}]}).encode(), None
    with pytest.raises(ValueError, match="source size"):
        run(root, 1, Images("test-only", transport=transport))
    with pytest.raises(ValueError, match="source size"):
        run(root, 0, Images("test-only", transport=lambda *_: pytest.fail("retried")))
    assert (root / "sources/image.png").exists()


def test_wrong_size_parent_stops_dependent_calls(tmp_path):
    root = tmp_path / "tiles"
    tiles_plan(root, MATERIAL)
    calls = []
    def transport(*_):
        calls.append(1)
        stream = io.BytesIO(); Image.new("RGB", (64, 64)).save(stream, "PNG")
        return json.dumps({"data": [{"b64_json": base64.b64encode(stream.getvalue()).decode()}]}).encode(), None
    with pytest.raises(ValueError, match="source size"):
        run(root, 3, Images("test-only", transport=transport))
    with pytest.raises(ValueError, match="source size"):
        run(root, 3, Images("test-only", transport=transport))
    assert len(calls) == 1


def test_tiles_build_130_exact_crops_without_provider(tmp_path):
    root = tmp_path / "tiles"
    plan = tiles_plan(root, MATERIAL)
    assert len(plan["calls"]) == 3
    assert plan["calls"][1]["inputs"][1]["crop"] == list(layout.ground_box(3))
    assert "UNDERSIDE" in plan["calls"][2]["prompt"].upper()
    for call in plan["calls"]:
        Image.fromarray(draft.draft(call["height"])[1]).save(root / "sources" / f"{call['id']}.png")
    build(root)
    output = root / "output"
    meta = json.loads((output / "tileset.json").read_text())
    assert meta["tilecount"] == 130
    assert {k: len(v) for k, v in meta["surfaces"].items()} == {"top": 47, "side": 36, "bottom": 47}
    atlas = Image.open(output / "atlas.png").convert("RGB")
    review = json.loads((output / "review.json").read_text())
    for entry in review["selected"]:
        index, (row, col) = entry["tile"], entry["cell"]
        source = Image.open(root / "sources" / f"{entry['source']}.png").convert("RGB")
        expected = source.crop((col * 64, row * 64, (col + 1) * 64, (row + 1) * 64)).resize((16, 16), Image.Resampling.NEAREST)
        actual = atlas.crop((index % 16 * 16, index // 16 * 16, index % 16 * 16 + 16, index // 16 * 16 + 16))
        assert actual.tobytes() == expected.tobytes()


@pytest.mark.parametrize("preset", ["item", "sprite", "texture", "none"])
def test_filter_presets_work_on_transparent_shapes(preset):
    from genforge.plans import PRESETS
    image = Image.new("RGBA", (64, 64))
    ImageDraw.Draw(image).rectangle((12, 10, 50, 54), fill=(120, 80, 40, 255))
    out = filters.render(image, (16, 16), PRESETS[preset])
    assert out.size == (16, 16) and out.getchannel("A").getextrema()[1] == 255
    assert out.getpixel((0, 0))[3] == 0


def test_cli_default_is_free_and_run_requires_confirmation(tmp_path, capsys):
    prompt = tmp_path / "prompt.txt"; prompt.write_text("A stone")
    root = tmp_path / "run"
    assert main(["image", "--prompt-file", str(prompt), "--out", str(root)]) == 0
    assert '"paid_calls": 0' in capsys.readouterr().out
    assert main(["run", str(root), "--max-calls", "1"]) == 1
    assert "--yes" in capsys.readouterr().err


def test_item_rectangles_are_rejected_before_planning(tmp_path):
    with pytest.raises(ValueError, match="square"):
        image_plan(tmp_path / "run", "A thing", (1024, 1024), (16, 32), preset="item")
