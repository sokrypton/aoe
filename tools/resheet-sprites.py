#!/usr/bin/env python3
# One-shot that produced the current sprites.png layout (grouped by type, age
# progressions on adjacent cells, icons content-centered, 9 free placeholder
# slots). Kept for the record / future re-layouts.
#
# It maps each cell from OLD (the layout it was RUN FROM) to NEW (the layout it
# PRODUCED — i.e. today's sheet), trimming each icon to its opaque bbox and
# re-centering it in the 205px cell. IMPORTANT: it is NOT idempotent — running
# it again on the current sheet would scramble it, because OLD no longer
# matches. To re-lay-out: set OLD = the CURRENT js/page-shell.js SPRITE_CELLS,
# set NEW = the desired layout, and run once against a copy.
#
#   python3 tools/resheet-sprites.py sprites.png out.png
import sys
from PIL import Image, ImageDraw
src_path = sys.argv[1] if len(sys.argv) > 1 else 'sprites.png'
out_path = sys.argv[2] if len(sys.argv) > 2 else 'sprites.out.png'
src = Image.open(src_path).convert('RGBA'); W, H = src.size; N = 8; C = W // N
OLD = {  # layout BEFORE this remap (pre-regroup)
 'villager':(0,0),'militia':(1,0),'spearman':(2,0),'archer':(3,0),'scout':(4,0),'knight':(5,0),'sheep':(6,0),'tradecart':(7,0),
 'militia-feudal':(0,1),'militia-castle':(1,1),'spearman-castle':(2,1),'archer-castle':(3,1),'scout-castle':(4,1),'bear':(5,1),'pop':(6,1),'compass':(7,1),
 'TC-castle':(0,2),'HOUSE':(1,2),'BARRACKS':(2,2),'MILL':(3,2),'LCAMP':(4,2),'MCAMP':(5,2),'FARM':(6,2),'PTOWER':(7,2),
 'WT-castle':(0,3),'WALL':(1,3),'GATE':(2,3),'SWALL':(3,3),'SGATE':(4,3),'gate-lock':(5,3),'gate-unlock':(6,3),'TC-dark':(7,3),
 'food':(0,4),'wood':(1,4),'gold':(2,4),'stone':(3,4),'cancel':(4,4),'econ':(5,4),'mil':(6,4),'TC-feudal':(7,4),
 'back':(0,5),'reseed':(1,5),'research':(2,5),'logo':(3,5),'ram':(4,5),'MARKET':(5,5),'bell':(6,5),'WT-feudal':(7,5),
 'age-dark':(0,6),'age-feudal':(1,6),'age-castle':(2,6),'idle':(3,6),'rally':(4,6),'map':(5,6),'home':(6,6),
}
NEW = {  # layout AFTER (matches js/page-shell.js SPRITE_CELLS)
 'villager':(0,0),'militia':(1,0),'militia-feudal':(2,0),'militia-castle':(3,0),'spearman':(4,0),'spearman-castle':(5,0),'archer':(6,0),'archer-castle':(7,0),
 'scout':(0,1),'scout-castle':(1,1),'knight':(2,1),'ram':(3,1),'tradecart':(4,1),'sheep':(5,1),'bear':(6,1),'pop':(7,1),
 'TC-dark':(0,2),'TC-feudal':(1,2),'TC-castle':(2,2),'HOUSE':(3,2),'MILL':(4,2),'FARM':(5,2),'LCAMP':(6,2),'MCAMP':(7,2),
 'BARRACKS':(0,3),'MARKET':(1,3),'PTOWER':(2,3),'WT-feudal':(3,3),'WT-castle':(4,3),'WALL':(5,3),'SWALL':(6,3),'GATE':(7,3),
 'SGATE':(0,4),'gate-lock':(1,4),'gate-unlock':(2,4),'food':(3,4),'wood':(4,4),'gold':(5,4),'stone':(6,4),
 'back':(0,5),'cancel':(1,5),'rally':(2,5),'idle':(3,5),'bell':(4,5),'home':(5,5),'map':(6,5),'compass':(7,5),
 'econ':(0,6),'mil':(1,6),'research':(2,6),'reseed':(3,6),'logo':(4,6),'age-dark':(5,6),'age-feudal':(6,6),'age-castle':(7,6),
}
assert set(OLD) == set(NEW)
out = Image.new('RGBA', (W, H), (0, 0, 0, 0))
for key, (oc, orow) in OLD.items():
    im = src.crop((oc*C, orow*C, oc*C+C, orow*C+C))
    bb = im.getbbox()
    if bb:
        cnt = im.crop(bb); cw, chh = cnt.size
        tile = Image.new('RGBA', (C, C), (0, 0, 0, 0))
        tile.paste(cnt, ((C-cw)//2, (C-chh)//2), cnt)
    else:
        tile = im
    nc, nrow = NEW[key]; out.paste(tile, (nc*C, nrow*C))
occupied = set(NEW.values())
for r in range(N):
    for c in range(N):
        if (c, r) in occupied: continue
        m = 26
        ImageDraw.Draw(out).rounded_rectangle((c*C+m, r*C+m, c*C+C-m, r*C+C-m), radius=22, outline=(120,120,130,120), width=3)
out.save(out_path); print('wrote', out_path)
