# Pixel filters

The port retains Genforge's staged filter and dedicated item converter. Python callers can use
`from genforge import filters` followed by `filters.render(image, (width, height), settings)`.
`render_family` shares a palette between same-size images; `render_batch` supports different
sizes. These functions use local files and have no provider dependency.

Stages: source adjustment → topology/downscale → vibrance → palette → dithering/noise →
outline → cleanup → alpha. Tile sheets bypass these stages: their original art pixels are
sampled at the center of each 4×4 source block and cut into exact 16×16 tiles.

Example settings file:

```json
{
  "downscale": "edge_preserving",
  "before": {"contrast": 1.1, "saturation": 1.05},
  "colors": {"count": 16, "pick": "variance"},
  "outline": {"mode": "rim", "darken": 0.25},
  "cleanup": {"stray": true},
  "alpha": 0.5
}
```

| Stage | Controls |
|---|---|
| `before` | `blur`, `sharpen`; grid grading `contrast`, `saturation`, `hue_shift`, `exposure`, `highlights`, `span` |
| `downscale` | `edge_preserving`, `area`, `nearest`, `median`, or the dedicated `item` path |
| `colors` | `count`; `pick: variance` or `range`; or `palette: ["#rrggbb", ...]` for exact colours |
| `vibrance` | Amount of selective saturation |
| `dither` | `mode: ordered` or `diffusion`, with `strength` |
| `noise` | Amount of deterministic palette-step variation |
| `outline` | `none`, `inner`, `hard`, `rim`, `outer`; optional `darken` and `color` |
| `cleanup` | `stray`, `min_cluster`, `symmetry` |
| `alpha` | Coverage threshold as a fraction, or `smooth` |

`item` replaces the later general stages with its own halo attenuation, tight fit,
linear-light resampling, median-cut material palette and inward rim. Its relevant controls
are `colors.count`, `outline.darken`, `hairlines`, and an explicit palette. Use square targets;
the tuning evidence is for 16×16. Thin parts need deliberately chunky source drawings.

The implementation docstrings in `genforge/filters/` describe the detailed controls. Original
topology and palette functions live in `filters/topology.py`; the unrelated API processor
classes were not ported. Filter tests use a hole and thin diagonal to detect changes to
the original pixels, not just output dimensions.
