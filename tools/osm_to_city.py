#!/usr/bin/env python3
"""
Custom GIS to 3D Geometry Pipeline
--------------------------------------------------
This script extracts raw OpenStreetMap data and procedurally generates a lightweight 
3D environment optimized for web-based real-time rendering.

Workflow:
  OSM Raw Data -> Base polygons + Height extraction
               -> Centerline road topologies + Lane counts + Material metadata
  Output: A unified JSON payload consumed directly by the SceneGenerator.
"""
import json, math, os

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC  = os.path.join(HERE, "data", "osm_raw.json")
DST  = os.path.join(HERE, "data", "simulation_environment.json") # Renamed for generic application

# Center of the study area (City of London bounds)
LAT0, LON0 = 51.5160, -0.0915

# Default lane assignments based on highway classification
DEFAULT_LANES = {
    "motorway": 3, "trunk": 3, "primary": 2, "secondary": 2,
    "tertiary": 2, "residential": 1, "unclassified": 1, "living_street": 1,
}
LANE_WIDTH = 3.5

# Routing hierarchy for traffic generation weights
ROAD_RANK = {
    "motorway": 5, "trunk": 5, "primary": 4, "secondary": 3,
    "tertiary": 2, "residential": 1, "unclassified": 1, "living_street": 1,
}

def project(lat, lon):
    """
    Equirectangular local projection around the scene center.
    Converts geographic coordinates (degrees) to local metric coordinates (x = East, z = North).
    """
    x = (lon - LON0) * 111320.0 * math.cos(math.radians(LAT0))
    z = (lat - LAT0) * 110540.0
    return x, z

def parse_height(tags):
    """Extracts building height from OSM tags in meters."""
    h = tags.get("height") or tags.get("building:height")
    if h:
        try:
            return max(3.0, float(str(h).split()[0].replace("m", "")))
        except ValueError:
            pass
    levels = tags.get("building:levels")
    if levels:
        try:
            return max(3.0, float(str(levels).split(";")[0]) * 3.2)
        except ValueError:
            pass
    return 12.0 

def signed_area(poly):
    """Calculates signed area of a polygon to determine vertex winding order."""
    s = 0.0
    for i in range(len(poly)):
        x1, z1 = poly[i]
        x2, z2 = poly[(i + 1) % len(poly)]
        s += x1 * z2 - x2 * z1
    return s / 2.0

def simplify(points, tol=0.6):
    """
    Douglas-Peucker simplification algorithm.
    Reduces vertex count to ensure the generated meshes can be rendered at 60FPS.
    """
    if len(points) < 3:
        return points

    def rdp(pts):
        if len(pts) < 3:
            return pts
        x1, z1 = pts[0]
        x2, z2 = pts[-1]
        dx, dz = x2 - x1, z2 - z1
        norm = math.hypot(dx, dz)
        dmax, idx = 0.0, 0
        for i in range(1, len(pts) - 1):
            px, pz = pts[i]
            if norm == 0:
                d = math.hypot(px - x1, pz - z1)
            else:
                d = abs(dz * px - dx * pz + x2 * z1 - z2 * x1) / norm
            if d > dmax:
                dmax, idx = d, i
        if dmax > tol:
            return rdp(pts[:idx + 1])[:-1] + rdp(pts[idx:])
        return [pts[0], pts[-1]]

    return rdp(points)

def main():
    with open(SRC, encoding="utf-8") as f:
        osm = json.load(f)

    nodes = {e["id"]: (e["lat"], e["lon"]) for e in osm["elements"] if e["type"] == "node"}
    ways = [e for e in osm["elements"] if e["type"] == "way"]

    # --- Identify Intersection Nodes ---
    ref_count = {}
    for w in ways:
        if "highway" not in w.get("tags", {}):
            continue
        for n in set(w.get("nodes", [])):
            ref_count[n] = ref_count.get(n, 0) + 1
    junctions = {n for n, c in ref_count.items() if c >= 2}
    print(f"Intersections: {len(junctions)} shared nodes identified")

    buildings, roads = [], []
    minx = minz = 1e18
    maxx = maxz = -1e18

    for w in ways:
        tags = w.get("tags", {})
        refs = w.get("nodes", [])
        if len(refs) < 2:
            continue
        pts = [project(*nodes[n]) for n in refs if n in nodes]
        if len(pts) < 2:
            continue
        for x, z in pts:
            minx, maxx = min(minx, x), max(maxx, x)
            minz, maxz = min(minz, z), max(maxz, z)

        if "building" in tags:
            ring = pts[:-1] if pts[0] == pts[-1] else pts        
            ring = simplify(ring, tol=0.6)
            if len(ring) < 3 or abs(signed_area(ring)) < 12.0:   
                continue
            if signed_area(ring) < 0:                            
                ring.reverse()
            buildings.append({
                "id": w["id"],
                "name": tags.get("name", ""),
                "h": round(parse_height(tags), 1),
                "mat": tags.get("building:material", tags.get("building", "yes")),
                "poly": [[round(x, 2), round(z, 2)] for x, z in ring],
            })

        elif "highway" in tags:
            hw = tags["highway"]
            try:
                lanes = int(str(tags.get("lanes", "")).split(";")[0])
            except ValueError:
                lanes = DEFAULT_LANES.get(hw, 1)
            
            valid_refs = [n for n in refs if n in nodes]
            cut = [0] + [i for i in range(1, len(pts) - 1)
                         if valid_refs[i] in junctions] + [len(pts) - 1]
            line = []
            for ci in range(len(cut) - 1):
                piece = simplify(pts[cut[ci]:cut[ci + 1] + 1], tol=0.8)
                line.extend(piece if not line else piece[1:])
            if len(line) < 2:
                continue
            length = sum(math.dist(line[i], line[i + 1]) for i in range(len(line) - 1))
            if length < 3.0:           
                continue
            roads.append({
                "id": w["id"],
                "name": tags.get("name", f"Road {w['id']}"),
                "type": hw,
                "lanes": max(1, min(lanes, 4)),
                "width": round(max(1, min(lanes, 4)) * LANE_WIDTH, 2),
                "rank": ROAD_RANK.get(hw, 1),
                "oneway": tags.get("oneway", "no") == "yes",
                "maxspeed": tags.get("maxspeed", ""),
                "len": round(length, 1),
                "line": [[round(x, 2), round(z, 2)] for x, z in line],
            })

    out = {
        "meta": {
            "area": "City of London",
            "source": "OpenStreetMap (ODbL) via Overpass API",
            "center": {"lat": LAT0, "lon": LON0},
            "bounds": {"minx": round(minx, 1), "maxx": round(maxx, 1),
                       "minz": round(minz, 1), "maxz": round(maxz, 1)},
            "laneWidth": LANE_WIDTH,
        },
        "buildings": buildings,
        "roads": roads,
    }

    with open(DST, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))

    total_len = sum(r["len"] for r in roads)
    print(f"Buildings : {len(buildings)}")
    print(f"Roads     : {len(roads)}  (Total length {total_len / 1000:.1f} km)")
    print(f"Bounds    : {maxx - minx:.0f} m x {maxz - minz:.0f} m")
    print(f"Output    : {DST}  ({os.path.getsize(DST) / 1024:.0f} KB)")

if __name__ == "__main__":
    main()