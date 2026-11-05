# Upstream reference: Genforge

`upstream/genforge/` is a copy of Infinite's `tools/genforge`, from
Baladoodle/infinite at `52e6547` (2026-11-04), without `prototypes/`. It's here
so carbon's TypeScript port in `src/core/pixel/` can be read against the
original, and so the parity references can be regenerated:

```sh
python3 -m venv .venv && .venv/bin/pip install ./upstream/genforge
.venv/bin/python upstream/genforge filter <src.png> --target 16x16 --preset item --out <out.png>
```

It's reference material, not part of the app: nothing in `src/` imports it.
