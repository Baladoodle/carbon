"""Reference occupancy-to-texture rules. Coordinates are engine-owned."""

# Right and up on each outward-facing surface; right × up = outward normal.
BASES = {
    (1, 0, 0): ((0, 0, -1), (0, 1, 0)),
    (-1, 0, 0): ((0, 0, 1), (0, 1, 0)),
    (0, 1, 0): ((1, 0, 0), (0, 0, -1)),
    (0, -1, 0): ((1, 0, 0), (0, 0, 1)),
    (0, 0, 1): ((1, 0, 0), (0, 1, 0)),
    (0, 0, -1): ((-1, 0, 0), (0, 1, 0)),
}


def add(point, axis, distance=1):
    return tuple(p + a * distance for p, a in zip(point, axis))


def select(solid, point, normal):
    """Return (surface, state), or None for hidden/nonexistent faces.

    `solid` accepts an (x,y,z) tuple and returns whether that voxel is solid.
    Occupancy connects any solid material; material-transition paint is separate.
    """
    right, up = BASES[normal]
    if not solid(point) or solid(add(point, normal)):
        return None
    if normal[1]:
        def absent(u, v):
            return not solid(add(add(point, right, u), up, v))
        north, east, south, west = absent(0, 1), absent(1, 0), absent(0, -1), absent(-1, 0)
        bits = (north, east, south, west,
                absent(1, 1) and not north and not east,
                absent(-1, 1) and not north and not west,
                absent(1, -1) and not south and not east,
                absent(-1, -1) and not south and not west)
        return ("top" if normal[1] > 0 else "bottom", str(sum(int(b) << i for i, b in enumerate(bits))))

    def exposed(q):
        return solid(q) and not solid(add(q, normal))
    above, below = exposed(add(point, up)), exposed(add(point, up, -1))
    if above:
        role = "mid" if below else "foot"
    else:
        role = "top" if below else "single"

    def side(direction):
        neighbor = add(point, right, direction)
        if solid(add(neighbor, normal)):
            return "T"
        return "F" if solid(neighbor) else "O"
    return "side", f"{role}:{side(-1)}:{side(1)}"
