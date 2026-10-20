#!/usr/bin/env python3
"""
Generates client/src/components/markerWriteData.ts: for each character of the phrases written by <MarkerWrite>
("Shifts." in the footer, "Hi!!" on the login page) the outline of every glyph in Marker Hand, plus the PEN STROKES
that draw it (centre-lines, in writing order, with a pen speed profile and the timing of every stroke).

How the strokes are made
  1. Each glyph is rasterised (even-odd) from the font's real outlines and skeletonised (medial axis); short spurs are pruned.
  2. RECIPES below say, per glyph, which skeleton nodes each pen stroke runs through, in writing order and direction. The stroke
     is routed along the skeleton between those nodes, smoothed, and extended to the true tip of the glyph at free ends.
  3. The mask width of a stroke is the glyph's thickness along it, grown until the strokes together cover 100% of the glyph.
  4. Pen speed follows the two-thirds power law of handwriting (slower in tight curves) under a bell-shaped speed envelope
     (pen lands slowly, speeds up, slows to lift). Between strokes the pen travels in the air: lift pause + travel time.
  Dots (".", the dot of "!") are dabs: the marker is pressed down and the ink blooms outwards.
Usage:  pip install fonttools brotli numpy scipy scikit-image pillow opencv-python
        python3 scripts/gen-marker-strokes.py
"""
import json, math, os, sys
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi
from skimage.morphology import skeletonize
from skimage.graph import route_through_array
from fontTools.ttLib import TTFont
from fontTools.pens.basePen import BasePen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT = os.path.join(ROOT, "client/src/assets/fonts/marker-hand/MarkerHand-Regular.woff2")
OUT = os.path.join(ROOT, "client/src/components/markerWriteData.ts")
SC, PAD = 2, 60            # raster scale (px per font unit) and padding
PROGRESS_STEPS = 24        # keyframes per stroke

# Glyph names per phrase, as the browser shapes them with calt + kern on ("Hi!!": the 2nd "!" is the contextual alternate excl_alt).
PHRASES = {"Shifts.": ["S", "h", "i", "f", "t", "s", "period"], "Hi!!": ["H", "i", "exclam", "excl_alt"]}

# Pen strokes per glyph, in writing order. A list of skeleton node ids = a stroke routed through them; ("dab", node ids) = a dot
# pressed at the centre of those nodes. Node ids come from the pruned skeleton (run with --nodes to print and render them).
RECIPES = {
    "S": [[0, 1]],                           # top right, round the S, to the bottom left
    "h": [[0, 1, 3], [1, 2]],                # the stem, then the arch off it, over and down the leg to the flick
    "i": [[2, 3], [0, 1]],                   # the stem, then the dot as a short flick
    "f": [[0, 2, 3, 5], [4, 3, 2, 1]],       # the long stem from the hook down through the descender, then the bar left to right
    "t": [[0, 2, 4, 6], [3, 5, 4, 2, 1]],    # the stem down into its hook, then the bar left to right
    "s": [[0, 1, 3]],                        # top right, over, round the middle and out the bottom left
    "period": [("dab", [0, 1])],
    "H": [[1, 5, 7, 8], [0, 2, 4, 9], [6, 7, 5, 4]],  # left stem, right stem, then the bar
    "exclam": [[0, 1], ("dab", [2, 3])],
    "excl_alt": [[0, 1], ("dab", [2, 3])],
}

# ---------------------------------------------------------------------------------------------------------- font access
font = TTFont(FONT); font.flavor = None
gs = font.getGlyphSet()

class PolyPen(BasePen):
    def __init__(s, g): super().__init__(g); s.cs = []; s.c = None
    def _moveTo(s, p): s.c = [p]
    def _lineTo(s, p): s.c.append(p)
    def _curveToOne(s, a, b, c):
        p0 = s.c[-1]
        for t in np.linspace(0, 1, 12)[1:]:
            s.c.append(tuple((1-t)**3*np.array(p0)+3*(1-t)**2*t*np.array(a)+3*(1-t)*t*t*np.array(b)+t**3*np.array(c)))
    def _qCurveToOne(s, a, b):
        p0 = s.c[-1]
        for t in np.linspace(0, 1, 10)[1:]:
            s.c.append(tuple((1-t)**2*np.array(p0)+2*(1-t)*t*np.array(a)+t*t*np.array(b)))
    def _closePath(s): s.cs.append(s.c); s.c = None
    def _endPath(s): s.cs.append(s.c); s.c = None

def kern(a, b):
    gpos = font["GPOS"].table
    for l in gpos.LookupList.Lookup:
        for st in l.SubTable:
            if l.LookupType == 9: st = st.ExtSubTable
            if type(st).__name__ != "PairPos" or a not in st.Coverage.glyphs: continue
            cov = st.Coverage.glyphs
            if st.Format == 1:
                for r in st.PairSet[cov.index(a)].PairValueRecord:
                    if r.SecondGlyph == b: return getattr(r.Value1, "XAdvance", 0) if r.Value1 else 0
            else:
                v = st.Class1Record[st.ClassDef1.classDefs.get(a, 0)].Class2Record[st.ClassDef2.classDefs.get(b, 0)].Value1
                return getattr(v, "XAdvance", 0) if v else 0
    return 0

def raster(name):
    p = PolyPen(gs); gs[name].draw(p); cs = p.cs
    xs = [x for c in cs for x, y in c]; ys = [y for c in cs for x, y in c]
    x0, y1 = min(xs), max(ys)
    W = int((max(xs)-x0)*SC)+2*PAD; H = int((y1-min(ys))*SC)+2*PAD
    im = np.zeros((H, W), np.uint8)
    for c in cs:
        t = Image.new("L", (W, H), 0)
        ImageDraw.Draw(t).polygon([((x-x0)*SC+PAD, (y1-y)*SC+PAD) for x, y in c], fill=255)
        im ^= np.array(t)
    return im > 0, (x0, y1)

N8 = [(-1,-1),(-1,0),(-1,1),(0,-1),(0,1),(1,-1),(1,0),(1,1)]
def neigh(sk, y, x): return [(y+dy, x+dx) for dy, dx in N8 if 0 <= y+dy < sk.shape[0] and 0 <= x+dx < sk.shape[1] and sk[y+dy, x+dx]]
def degree(sk): return np.where(sk, ndi.convolve(sk.astype(int), np.ones((3, 3), int), mode="constant")-1, 0)
def trace(sk):
    nodes = {tuple(p) for p in np.argwhere((degree(sk) != 2) & sk)}; seen = set(); out = []
    for n in nodes:
        for nb in neigh(sk, *n):
            if (n, nb) in seen: continue
            path = [n, nb]; prev, cur = n, nb
            while cur not in nodes:
                nx = [q for q in neigh(sk, *cur) if q != prev and q not in path[-3:]]
                if not nx: break
                prev, cur = cur, nx[0]; path.append(cur)
            seen.add((n, nb)); seen.add((path[-1], path[-2])); out.append(path)
    return out
def prune(sk, dt, k=1.6):
    sk = sk.copy()
    for _ in range(6):
        ends = {tuple(p) for p in np.argwhere((degree(sk) == 1) & sk)}; changed = False
        for b in trace(sk):
            ea, ez = b[0] in ends, b[-1] in ends
            if ea == ez: continue
            free = b[0] if ea else b[-1]
            if len(b) < max(24, k*dt[free]):
                for (y, x) in (b[1:] if ea else b[:-1]): sk[y, x] = False
                sk[free] = False; changed = True
        sk = skeletonize(sk)
        if not changed: break
    return sk
def clusters(sk):
    cl = []
    for p in map(tuple, np.argwhere((degree(sk) != 2) & sk)):
        for c in cl:
            if abs(c[0][0]-p[0])+abs(c[0][1]-p[1]) < 10: c.append(p); break
        else: cl.append([p])
    return cl

def smooth(pts, step=5.0, sigma=3):
    d = np.r_[0, np.cumsum(np.hypot(*np.diff(pts, axis=0).T))]
    n = max(int(d[-1]/step), 4); u = np.linspace(0, d[-1], n)
    r = np.c_[np.interp(u, d, pts[:, 0]), np.interp(u, d, pts[:, 1])]
    pad = np.r_[2*r[0]-r[sigma*3:0:-1], r, 2*r[-1]-r[-2:-sigma*3-2:-1]]
    k = np.exp(-0.5*(np.arange(-sigma*3, sigma*3+1)/sigma)**2); k /= k.sum()
    s = np.c_[np.convolve(pad[:, 0], k, "valid"), np.convolve(pad[:, 1], k, "valid")]
    s[0], s[-1] = r[0], r[-1]
    return s
def resample(pts, step):
    d = np.r_[0, np.cumsum(np.hypot(*np.diff(pts, axis=0).T))]
    u = np.linspace(0, d[-1], max(int(d[-1]/step), 2))
    return np.c_[np.interp(u, d, pts[:, 0]), np.interp(u, d, pts[:, 1])]
def dp(pts, eps):
    if len(pts) < 3: return pts
    a, b = pts[0], pts[-1]; ab = b-a; L = np.hypot(*ab) or 1
    dist = np.abs(ab[0]*(pts[:, 1]-a[1])-ab[1]*(pts[:, 0]-a[0]))/L
    i = int(dist.argmax())
    if dist[i] > eps: return np.r_[dp(pts[:i+1], eps)[:-1], dp(pts[i:], eps)]
    return np.array([a, b])

# ---------------------------------------------------------------------------------------------------- stroke building
def build_glyph(name):
    m, o = raster(name); dt = ndi.distance_transform_edt(m); sk = prune(skeletonize(m), dt)
    cl = clusters(sk); deg = degree(sk)
    skpix = np.argwhere(sk)
    def snap(c):
        cy, cx = np.mean(c, axis=0); i = np.argmin(((skpix-[cy, cx])**2).sum(1)); return tuple(skpix[i])
    cost = np.where(sk, 1.0, 1e6)
    terminal = [any(deg[p] == 1 for p in c) for c in cl]
    to_units = lambda p: np.array([o[0]+(p[1]-PAD)/SC, o[1]-(p[0]-PAD)/SC])
    strokes = []
    for r in RECIPES[name]:
        if isinstance(r, tuple):
            ids = r[1]; c = np.mean([np.mean(cl[i], axis=0) for i in ids], axis=0)
            cy, cx = int(round(c[0])), int(round(c[1]))
            wd = 2*dt[max(cy-4, 0):cy+5, max(cx-4, 0):cx+5].max()/SC*1.08
            strokes.append(dict(dab=True, pts=np.array([to_units((cy, cx))]), w=wd, glyph_dt=wd)); continue
        path = []
        for a, b in zip(r, r[1:]):
            seg, _ = route_through_array(cost, snap(cl[a]), snap(cl[b]), fully_connected=True, geometric=True)
            path += seg if not path else seg[1:]
        px = np.array(path, float)[:, ::-1]                       # x, y in px
        dts = np.array([dt[int(y), int(x)] for x, y in px])
        px = smooth(px)
        for end in (0, -1):                                        # run out to the real tip at free (terminal) ends
            if terminal[r[end]]:
                t = px[end]-px[end+1 if end == 0 else end-1]; t /= np.hypot(*t) or 1
                tip = px[end]; ext = dt[int(tip[1]), int(tip[0])]*0.9
                px = np.r_[[tip+t*ext], px] if end == 0 else np.r_[px, [tip+t*ext]]
        u = np.c_[o[0]+(px[:, 0]-PAD)/SC, o[1]-(px[:, 1]-PAD)/SC]
        w = 2*np.percentile(dts, 92)/SC*1.07+6
        strokes.append(dict(pts=u, w=float(w)))
    return m, o, dt, strokes

def cover(m, o, strokes):
    """Rasterise the union of the stroke masks; returns the fraction of the glyph's pixels left uncovered."""
    img = Image.new("L", (m.shape[1], m.shape[0]), 0); d = ImageDraw.Draw(img)
    for s in strokes:
        r = s["w"]*SC/2
        for x, y in s["pts"]:
            px, py = (x-o[0])*SC+PAD, (o[1]-y)*SC+PAD; d.ellipse([px-r, py-r, px+r, py+r], fill=255)
        if len(s["pts"]) > 1:
            pts = [((x-o[0])*SC+PAD, (o[1]-y)*SC+PAD) for x, y in s["pts"]]; d.line(pts, fill=255, width=int(2*r))
    u = np.array(img) > 0
    return (m & ~u).sum()/m.sum()

# ---------------------------------------------------------------------------------------------------- pen kinematics
def profile(u):
    """Normalised times at PROGRESS_STEPS+1 equal steps of arc length along a stroke (two-thirds power law + bell envelope)."""
    p = resample(u, 2.0); ds = np.hypot(*np.diff(p, axis=0).T); s = np.r_[0, np.cumsum(ds)]; n = len(p)
    ang = np.unwrap(np.arctan2(np.gradient(p[:, 1]), np.gradient(p[:, 0])))
    k = 8; kap = np.zeros(n)
    for i in range(n):
        a, b = max(0, i-k), min(n-1, i+k); kap[i] = abs(ang[b]-ang[a])/max(s[b]-s[a], 1e-6)
    v = (kap+0.5*np.median(kap)+1e-4)**(-1/3)
    v = np.convolve(np.pad(v, 6, mode="edge"), np.ones(13)/13, "valid")
    uu = s/s[-1]; v *= 0.22+0.78*np.sin(np.pi*uu)**0.7
    t = np.r_[0, np.cumsum(ds/(0.5*(v[1:]+v[:-1])))]; t /= t[-1]
    grid = np.linspace(0, 1, PROGRESS_STEPS+1); tt = np.interp(grid, uu, t)
    for i in range(1, len(tt)): tt[i] = max(tt[i], tt[i-1]+1e-4)
    return list(tt/tt[-1]), float(s[-1])

def build_phrase(text, names):
    x = 0; glyph_d = []; items = []
    for gi, n in enumerate(names):
        m, o, dt, strokes = build_glyph(n)
        for _ in range(12):                                         # grow masks until the glyph is fully covered
            miss = cover(m, o, strokes)
            if miss < 0.0015: break
            for s in strokes: s["w"] *= 1.04
        print(f"  {text!r} {n}: {len(strokes)} strokes, uncovered {miss*100:.3f}%", file=sys.stderr)
        pen = SVGPathPen(gs, ntos=lambda v: ("%.1f" % v).rstrip("0").rstrip("."))
        gs[n].draw(TransformPen(pen, (1, 0, 0, -1, x, 0))); glyph_d.append(pen.getCommands())
        for si, s in enumerate(strokes):
            pts = s["pts"]+[x, 0]
            items.append(dict(s, pts=pts, letter=gi, first=si == 0))
        x += font["hmtx"][n][0] + (kern(n, names[gi+1]) if gi+1 < len(names) else 0)
    # timeline (natural milliseconds, rescaled to 0..1)
    t = 0.0; last = None; out = []
    for it in items:
        pts = it["pts"]
        if last is not None:
            dist = float(np.hypot(*(pts[0]-last)))
            t += 55+0.22*dist+(70 if it["first"] else 0)             # lift, travel through the air, settle at a new letter
        if it.get("dab"):
            dur = 55.0; kf = None; length = 0
        else:
            kf, length = profile(pts); dur = 60+0.42*length
        out.append(dict(it, t=t, dur=dur, kf=kf)); t += dur; last = pts[-1]
    total = t
    strokes = []
    for it in out:
        pts = it["pts"]
        if it.get("dab"):
            c = pts[0]; d = f"M{c[0]:.1f} {-c[1]:.1f}h.01"
        else:
            q = dp(pts, 0.6); d = "M"+"L".join(f"{a:.1f} {-b:.1f}" for a, b in q)
        e = dict(d=d, w=round(float(it["w"]), 1), t=round(it["t"]/total, 4), dur=round(it["dur"]/total, 4))
        if it.get("dab"): e["dab"] = True
        else: e["k"] = [round(v, 4) for v in it["kf"]]
        strokes.append(e)
    return dict(w=int(x), glyphs=" ".join(glyph_d), natural=int(total), strokes=strokes)

if __name__ == "__main__":
    data = {text: build_phrase(text, names) for text, names in PHRASES.items()}
    ts = ['// GENERATED by scripts/gen-marker-strokes.py from MarkerHand-Regular.woff2 - do not edit by hand.',
          '// Per phrase: `w` advance width in font units (1000 = 1em, kerning applied), `glyphs` the real outlines of its characters',
          '// (y down, baseline at y = 0), and `strokes`, the pen strokes in writing order: `d` the centre-line, `w` the mask width,',
          '// `t` / `dur` start and length as fractions of the whole write, `k` the normalised time at which each 1/24 of the stroke has',
          '// been drawn (the pen speed profile). `dab` strokes are dots: the marker is pressed down and the ink blooms outwards.',
          'export type MarkerStroke = { d: string; w: number; t: number; dur: number; k?: number[]; dab?: true };',
          'export type MarkerPhrase = { w: number; glyphs: string; natural: number; strokes: MarkerStroke[] };',
          'export const MARKER_PHRASES: Record<string, MarkerPhrase> = ' + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ';', '']
    open(OUT, "w").write("\n".join(ts)); print("wrote", OUT, os.path.getsize(OUT), "bytes", file=sys.stderr)
