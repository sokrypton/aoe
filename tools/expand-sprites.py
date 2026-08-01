#!/usr/bin/env python3
# One-shot: grow sprites.png from 8x8 to 8x10 (2048x2048 -> 2048x2560), keeping
# every existing cell in place (rows 0-7 verbatim), and lay out the two new rows
# as FULL-CELL research (tech upgrade) icons — one 256px cell each, grouped by
# host building (keep in sync with the `up-*` entries in js/page-shell.js
# SPRITE_CELLS + BLDGS.researches):
#   row 8: forging, iron_casting, scale_armor, chain_mail, fletching, masonry,
#          fortified_wall (Barracks), horse_collar (Mill)
#   row 9: heavy_plow (Mill), double_bit_axe, bow_saw (Lumber), gold_mining
#          (Mining), guilds (Market), wheelbarrow (TC), + 2 spare
# Full-size (not quarter) so they read clearly; a parchment button frame (CSS
# .research-btn) sits BEHIND these in the HUD, so the art is just the object on a
# transparent background. Placeholders are dashed labeled boxes to draw over.
# Run only against the pre-expansion 8x8 sheet.
#
#   python3 tools/expand-sprites.py [sprites.png]
import sys
from PIL import Image, ImageDraw, ImageFont

path = sys.argv[1] if len(sys.argv) > 1 else 'sprites.png'
src = Image.open(path).convert('RGBA')
C = 256                       # cell size
COLS, ROWS = 8, 10            # new grid (two added rows)
W, H = COLS * C, ROWS * C     # 2048 x 2560
assert src.size == (COLS * C, 8 * C), f'expected an 8x8 {COLS*C}px sheet, got {src.size}'

out = Image.new('RGBA', (W, H), (0, 0, 0, 0))
out.paste(src, (0, 0))        # rows 0-7 verbatim
d = ImageDraw.Draw(out)

def font(sz):
    for p in ('/System/Library/Fonts/Supplemental/Arial Bold.ttf',
              '/System/Library/Fonts/Helvetica.ttc'):
        try: return ImageFont.truetype(p, sz)
        except Exception: pass
    return ImageFont.load_default()

def box(x, y, w, h, label, tint):
    m = 8
    d.rounded_rectangle([x + m, y + m, x + w - m, y + h - m], radius=12,
                        fill=tint, outline=(255, 235, 173, 190), width=3)
    f = font(30)
    words = label.replace('_', ' ').split()
    lines, cur = [], ''
    for wd in words:
        t = (cur + ' ' + wd).strip()
        if d.textlength(t, font=f) > w - 2 * m - 12 and cur:
            lines.append(cur); cur = wd
        else:
            cur = t
    if cur: lines.append(cur)
    lh = (f.getbbox('Ag')[3] - f.getbbox('Ag')[1]) + 6
    ty = y + h / 2 - lh * len(lines) / 2
    for ln in lines:
        tw = d.textlength(ln, font=f)
        d.text((x + w / 2 - tw / 2, ty), ln, font=f, fill=(255, 245, 210, 240))
        ty += lh

# rows 8-9: 14 tech full-cells (grouped by building) + 2 spare, per host-building tint.
RED, GRN, OLV, GLD, PUR, BLU = ((90,60,60,80),(60,90,60,80),(70,80,50,80),(90,80,50,80),(80,70,90,80),(60,80,95,80))
CELLS = [  # (col, row, techkey, tint)
    (0,8,'forging',RED),(1,8,'iron_casting',RED),(2,8,'scale_armor',RED),(3,8,'chain_mail',RED),
    (4,8,'fletching',RED),(5,8,'masonry',RED),(6,8,'fortified_wall',RED),(7,8,'horse_collar',GRN),
    (0,9,'heavy_plow',GRN),(1,9,'double_bit_axe',OLV),(2,9,'bow_saw',OLV),(3,9,'gold_mining',GLD),
    (4,9,'guilds',PUR),(5,9,'wheelbarrow',BLU),
]
for col, row, key, tint in CELLS:
    box(col * C, row * C, C, C, key, tint)
for col in (6, 7):  # spare full cells
    box(col * C, 9 * C, C, C, 'spare', (60, 60, 60, 60))

out.save(path)
print(f'wrote {path} {out.size} (8x10); rows 8-9 = 14 full-cell tech icons (grouped by building) + 2 spare')
