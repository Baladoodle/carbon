from itertools import product

from genforge.voxel import BASES, add, select
from genforge.walls import layout


def test_original_boards_cover_47_tops_and_all_side_roles():
    assert len(layout.states(1)) == 56
    assert len(layout.states(3)) == 74
    sides = {key for height in (1, 3) for kind, key in layout.states(height) if kind == "face"}
    assert len(sides) == 36


def test_all_horizontal_neighborhoods_use_exactly_47_states():
    offsets = ((0, 1), (1, 0), (0, -1), (-1, 0), (1, 1), (-1, 1), (1, -1), (-1, -1))
    expected = {str(sum(int(b) << i for i, b in enumerate(key))) for kind, key in layout.states(3) if kind == "edge"}
    for normal in ((0, 1, 0), (0, -1, 0)):
        right, up = BASES[normal]
        states = set()
        for mask in range(256):
            cells = {(0, 0, 0)}
            for i, (u, v) in enumerate(offsets):
                if not mask & (1 << i):
                    cells.add(add(add((0, 0, 0), right, u), up, v))
            family, state = select(cells.__contains__, (0, 0, 0), normal)
            assert family == ("top" if normal[1] > 0 else "bottom")
            states.add(state)
        assert states == expected


def test_all_36_side_cases_on_four_directions():
    point = (0, 0, 0)
    for normal, (right, up) in BASES.items():
        if normal[1]:
            continue
        for role, left, right_state in product(("single", "top", "mid", "foot"), "OFT", "OFT"):
            cells = {point}
            if role in ("mid", "foot"):
                cells.add(add(point, up))
            if role in ("mid", "top"):
                cells.add(add(point, up, -1))
            for sign, state in ((-1, left), (1, right_state)):
                neighbor = add(point, right, sign)
                if state != "O":
                    cells.add(neighbor)
                if state == "T":
                    cells.add(add(neighbor, normal))
            assert select(cells.__contains__, point, normal) == ("side", f"{role}:{left}:{right_state}")


def test_hidden_faces_and_diagonal_side_limit():
    assert select({(0, 0, 0), (0, 0, 1)}.__contains__, (0, 0, 0), (0, 0, 1)) is None
    cells = {(x, y, 0) for x in (-1, 0, 1) for y in (-1, 0, 1)}
    before = select(cells.__contains__, (0, 0, 0), (0, 0, 1))
    cells.remove((1, 1, 0))
    assert select(cells.__contains__, (0, 0, 0), (0, 0, 1)) == before
