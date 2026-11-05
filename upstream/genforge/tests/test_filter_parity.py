import json
from pathlib import Path

from genforge import filters
from genforge.imaging import pixel_hash
from genforge.plans import PRESETS
from filter_fixture import source


def test_filters_match_recorded_upstream_pixels():
    # Golden values were computed with Defacing-spider's filter, before importing
    # this port. The fixture includes a hole and a thin diagonal crossing it.
    expected = json.loads(Path(__file__).with_name("filter-golden.json").read_text())
    for name, settings in PRESETS.items():
        assert pixel_hash(filters.render(source(), (16, 16), settings)) == expected[name], name
