import argparse
import json
import os
from pathlib import Path
import sys

from PIL import Image

from . import filters
from .build import build
from .files import digest, load_plan, write_json
from .plans import PRESETS, dimensions, image_plan, tiles_plan
from .provider import DEFAULT_MODEL, GenerationError, load_env
from .run import run


def settings_file(path):
    settings = json.loads(path.read_text())
    if not isinstance(settings, dict):
        raise ValueError("Filter settings must be a JSON object")
    return settings


def parser():
    cli = argparse.ArgumentParser(description="Genforge image generation, pixel filters and voxel tile tooling")
    cli.add_argument("--env-file", type=Path, help="Optional literal .env file; environment values take precedence")
    commands = cli.add_subparsers(dest="command", required=True)
    image = commands.add_parser("image", help="Prepare an image/edit plan without spending")
    image.add_argument("--prompt-file", type=Path, required=True)
    image.add_argument("--out", type=Path, required=True, help="New run directory")
    image.add_argument("--size", type=dimensions, default=(1024, 1024), help="Provider canvas, default 1024x1024")
    image.add_argument("--target", type=dimensions, default=(16, 16), help="Final pixels, default 16x16")
    image.add_argument("--preset", choices=PRESETS, default="item")
    image.add_argument("--settings", type=Path, help="Optional JSON filter settings, replacing the preset")
    image.add_argument("--model")
    image.add_argument("--quality", choices=("low", "medium", "high", "xhigh", "max"), default="low")
    image.add_argument("--background", choices=("opaque", "transparent", "auto"), default="transparent")
    image.add_argument("--reference", type=Path, action="append", default=[])
    image.add_argument("--mask", type=Path)
    tiles = commands.add_parser("tiles", help="Prepare top, side and underside specimen calls without spending")
    tiles.add_argument("--material", type=Path, required=True, help="Material words in JSON; see examples/meadow.json")
    tiles.add_argument("--out", type=Path, required=True)
    tiles.add_argument("--model")
    execute = commands.add_parser("run", help="Execute a prepared plan; paid calls require --yes and a call ceiling")
    execute.add_argument("directory", type=Path)
    execute.add_argument("--yes", action="store_true")
    execute.add_argument("--max-calls", type=int, required=True)
    process = commands.add_parser("build", help="Process retained/imported sources without spending")
    process.add_argument("directory", type=Path)
    process.add_argument("--source", action="append", default=[], metavar="CALL_ID=PATH")
    status = commands.add_parser("status", help="Show plan and attempt state without contacting the provider")
    status.add_argument("directory", type=Path)
    filtering = commands.add_parser("filter", help="Filter an existing image without generation")
    filtering.add_argument("source", type=Path)
    filtering.add_argument("--out", type=Path, required=True)
    filtering.add_argument("--target", type=dimensions, required=True)
    filtering.add_argument("--preset", choices=PRESETS, default="sprite")
    filtering.add_argument("--settings", type=Path)
    filtering.add_argument("--replace", action="store_true")
    return cli


def main(argv=None):
    cli = parser()
    args = cli.parse_args(argv)
    try:
        # Load only an explicit file, or the repository's own ignored .env.
        default_env = Path(__file__).resolve().parents[3] / ".env"
        if args.env_file:
            if not args.env_file.is_file():
                raise ValueError("The requested .env file does not exist")
            load_env(args.env_file)
        else:
            load_env(default_env)
        model = getattr(args, "model", None) or os.environ.get("GENFORGE_IMAGE_MODEL", DEFAULT_MODEL)
        if args.command == "image":
            settings = settings_file(args.settings) if args.settings else None
            result = image_plan(args.out, args.prompt_file.read_text(), args.size, args.target, args.preset,
                                model, args.quality, args.background, args.reference, args.mask, settings)
            print(json.dumps({"plan": str(args.out / "plan.json"), "calls": len(result["calls"]), "paid_calls": 0}))
        elif args.command == "tiles":
            result = tiles_plan(args.out, json.loads(args.material.read_text()), model)
            print(json.dumps({"plan": str(args.out / "plan.json"), "calls": len(result["calls"]), "paid_calls": 0}))
        elif args.command == "run":
            if not args.yes or args.max_calls < 0:
                raise ValueError("Run needs --yes and a non-negative --max-calls ceiling")
            run(args.directory, args.max_calls)
            print(f"Built {args.directory / 'output'}")
        elif args.command == "build":
            build(args.directory, args.source)
            print(f"Built {args.directory / 'output'} (no generation)")
        elif args.command == "status":
            plan = load_plan(args.directory)
            path = args.directory / "receipt.json"
            result = {"kind": plan["kind"], "planned_calls": len(plan["calls"]),
                      "attempts": json.loads(path.read_text()) if path.exists() else {}}
            print(json.dumps(result, indent=2))
        else:
            if args.out.suffix.lower() != ".png":
                raise ValueError("Filtered output must be a .png file")
            if (args.out.exists() or args.out.with_suffix(".json").exists()) and not args.replace:
                raise ValueError("Output exists; choose a new path or pass --replace")
            if args.source.resolve() == args.out.resolve():
                raise ValueError("Keep the source image; choose a different output path")
            if args.preset == "item" and args.target[0] != args.target[1]:
                raise ValueError("The item preset requires a square target")
            settings = settings_file(args.settings) if args.settings else PRESETS[args.preset]
            with Image.open(args.source) as source:
                output = filters.render(source, args.target, settings)
            args.out.parent.mkdir(parents=True, exist_ok=True)
            output.save(args.out)
            write_json(args.out.with_suffix(".json"), {"source": args.source.name,
                       "source_hash": digest(args.source.read_bytes()), "target": list(args.target),
                       "settings": settings, "output_hash": digest(args.out.read_bytes())})
            print(args.out)
        return 0
    except (ValueError, KeyError, OSError, GenerationError) as error:
        # Avoid tracebacks containing requests, headers or environment mappings.
        print(f"genforge: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
