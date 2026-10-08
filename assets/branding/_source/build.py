from gen import *
import cairosvg, io, os
from PIL import Image
OBS="#0A0D14"; GOLD="#D4AF37"; PLAT="#F4F4F6"; GOLD_D="#A8842A"
PHI=(1+5**.5)/2
# ---- mark geometry (512 grid) ----
R=166; SW=30
H=2*R/PHI - SW          # S visual height x phi = ring diameter
WREATH=wreath2(inner=False, n=7, L=100, W=32, tilt=18, R=R, a0=104, a1=234, taper=0.7)
NODES=diamond(256,428,15)+" "+diamond(256,84,11)
SP,_,_=S_path(top=256-H/2, H=H)
def mark_groups(fg):
    return (f'<g id="laurel" fill="{fg}"><path d="{WREATH}"/></g>'
            f'<g id="nodes" fill="{fg}"><path d="{NODES}"/></g>'
            f'<g id="monogram"><path d="{SP}" fill="none" stroke="{fg}" stroke-width="{SW}"/></g>')
def svg(vb, body, title):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" role="img" aria-label="{title}"><title>{title}</title>{body}</svg>\n'
def bbox(s, w):
    im=Image.open(io.BytesIO(cairosvg.svg2png(bytestring=s.encode(), output_width=w))); return im.getbbox()
# ---- wordmark: geometric monoline capitals, drawn as geometry (no fonts) ----
CAP=150; WT=21; TRACK=0.30*CAP
def rect(x,y,w,h): return f"M{P(x,y)}h{w:.2f}v{h:.2f}h{-w:.2f}Z"
def L_S(x,y):
    Hs=CAP-WT; ratio=54/46; a=Hs/2/(1+ratio); b=Hs/2-a; wdt=2*b+WT
    p,_,_=S_path(cx=x+wdt/2, top=y+WT/2, H=Hs); return ("stroke",p), wdt
def L_E(x,y,wd=0.58*CAP):
    return ("fill", rect(x,y,WT,CAP)+rect(x,y,wd,WT)+rect(x,y+CAP/2-WT/2,wd*0.86,WT)+rect(x,y+CAP-WT,wd,WT)), wd
def L_L(x,y,wd=0.54*CAP):
    return ("fill", rect(x,y,WT,CAP)+rect(x,y+CAP-WT,wd,WT)), wd
def L_C(x,y):
    r=CAP/2-WT/2; cx=x+CAP/2; cy=y+CAP/2; t=math.radians(42)
    p0=(cx+r*math.cos(-t), cy+r*math.sin(-t)); p1=(cx+r*math.cos(t), cy+r*math.sin(t))
    # optical width: right side is open, so advance = full circle minus a bit
    return ("stroke", f"M{P(*p0)}A{r:.2f} {r:.2f} 0 1 0 {P(*p1)}"), CAP*0.88
def L_T(x,y,wd=0.66*CAP):
    return ("fill", rect(x,y,wd,WT)+rect(x+wd/2-WT/2,y,WT,CAP)), wd
def wordmark(x,y,fg):
    fills=[];strokes=[]; cx=x
    for fn in (L_S,L_E,L_L,L_E,L_C,L_T):
        (kind,d),w=fn(cx,y); (fills if kind=="fill" else strokes).append(d); cx+=w+TRACK
    body=(f'<g id="wordmark"><path fill="{fg}" d="{" ".join(fills)}"/>'
          f'<path fill="none" stroke="{fg}" stroke-width="{WT}" d="{" ".join(strokes)}"/></g>')
    return body, cx-TRACK-x
os.makedirs("out",exist_ok=True)
files={}
# icon (avatar / favicon) with obsidian field
files["select-icon.svg"]=svg("0 0 512 512", f'<rect id="field" width="512" height="512" fill="{OBS}"/>'+mark_groups(GOLD), "Select Infrastructure")
# transparent marks, tight square viewBox
tmp=svg("0 0 512 512", mark_groups("#000"),"m"); bx=bbox(tmp,512)
side=max(bx[2]-bx[0], bx[3]-bx[1])+24; mx=(bx[0]+bx[2])/2; my=(bx[1]+bx[3])/2
mvb=f"{mx-side/2:.0f} {my-side/2:.0f} {side:.0f} {side:.0f}"
for name,fg in [("gold",GOLD),("white","#FFFFFF"),("black","#000000")]:
    files[f"select-mark-{name}.svg"]=svg(mvb, mark_groups(fg), "Select Infrastructure")
# horizontal lockup
MS=0.62  # mark scale
mark_h=(bx[3]-bx[1])*MS
VH=400; cy=VH/2
mtx=-bx[0]*MS+40; mty=cy-((bx[1]+bx[3])/2)*MS
gap=0.62*CAP
wx=40+(bx[2]-bx[0])*MS+gap; wy=cy-CAP/2
def lockup(mfg,wfg):
    wm,ww=wordmark(wx,wy,wfg)
    W=wx+ww+40
    body=f'<g id="icon" transform="translate({mtx:.2f} {mty:.2f}) scale({MS})">{mark_groups(mfg)}</g>'+wm
    return svg(f"0 0 {W:.0f} {VH}", body, "Select Infrastructure")
files["select-logo-horizontal.svg"]=lockup(GOLD,PLAT)          # for dark backgrounds
files["select-logo-horizontal-light.svg"]=lockup(GOLD_D,OBS)    # for light backgrounds
files["select-logo-horizontal-white.svg"]=lockup("#FFFFFF","#FFFFFF")
files["select-logo-horizontal-black.svg"]=lockup("#000000","#000000")
for k,v in files.items(): open("out/"+k,"w").write(v)
print(mvb, round(H,1), round((H+SW)*PHI,1), 2*R)
# simplified favicon (<=32px): laurel reduced to two solid arcs, heavier monogram
def arc_pts(t0,t1,r):
    a,b=math.radians(t0),math.radians(t1)
    return (CX+r*math.cos(a),CY+r*math.sin(a)),(CX+r*math.cos(b),CY+r*math.sin(b))
FR=196; FW=40
(l0,l1)=arc_pts(102,238,FR); r0=(2*CX-l0[0],l0[1]); r1=(2*CX-l1[0],l1[1])
arcs=f"M{P(*l0)}A{FR} {FR} 0 0 1 {P(*l1)}M{P(*r0)}A{FR} {FR} 0 0 0 {P(*r1)}"
FH=2*FR/PHI-56; FS,_,_=S_path(top=256-FH/2,H=FH)
fav=(f'<rect id="field" width="512" height="512" fill="{OBS}"/>'
     f'<g id="laurel"><path d="{arcs}" fill="none" stroke="{GOLD}" stroke-width="{FW}"/></g>'
     f'<g id="monogram"><path d="{FS}" fill="none" stroke="{GOLD}" stroke-width="56"/></g>')
open("out/select-favicon.svg","w").write(svg("0 0 512 512",fav,"Select Infrastructure"))
