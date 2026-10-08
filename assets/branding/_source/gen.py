import math, sys
CX, CY = 256, 256
def P(x,y): return f"{x:.2f} {y:.2f}"
def rot(u,v,ang):
    c,s=math.cos(ang),math.sin(ang); return (u*c-v*s, u*s+v*c)

def lens(x,y,ang,L,W):
    # vesica from two circular arcs, base at (x,y), pointing along ang
    h=W/2; r=(L*L/4+h*h)/(2*h)
    ex,ey=x+L*math.cos(ang), y+L*math.sin(ang)
    return f"M{P(x,y)}A{r:.2f} {r:.2f} 0 0 1 {P(ex,ey)}A{r:.2f} {r:.2f} 0 0 1 {P(x,y)}Z"

def facet(x,y,ang,L,W,k=0.38):
    pts=[(0,0),(L*k,W/2),(L,0),(L*k,-W/2)]
    return "M"+"L".join(P(x+u*math.cos(ang)-v*math.sin(ang), y+u*math.sin(ang)+v*math.cos(ang)) for u,v in pts)+"Z"

def wreath(R=162, n=6, a0=112, a1=246, L=72, W=26, tilt=28, style="lens"):
    d=[]
    for i in range(n):
        t=math.radians(a0+(a1-a0)*i/(n-1))
        for side in (1,-1):
            # left branch angle t ; right branch mirrored
            x=CX+R*math.cos(t); y=CY+R*math.sin(t)
            tang=t+math.pi/2  # direction of increasing angle (left side goes up)
            ang=tang+math.radians(tilt)  # outward tilt for left side
            if side==-1:
                x=2*CX-x; ang=math.pi-ang
            f=lens if style=="lens" else facet
            d.append(f(x,y,ang,L,W))
    return " ".join(d)

def S_path(cx=256, top=156, H=200, ratio=54/46, t0=-35, t1=145):
    a=H/2/(1+ratio); b=H/2-a
    c1=(cx, top+a); c2=(cx, top+2*a+b)
    def pt(c,r,deg): return (c[0]+r*math.cos(math.radians(deg)), c[1]+r*math.sin(math.radians(deg)))
    p0=pt(c1,a,t0); pm=(cx, top+2*a); p1=pt(c2,b,t1)
    return f"M{P(*p0)}A{a:.2f} {a:.2f} 0 1 0 {P(*pm)}A{b:.2f} {b:.2f} 0 1 1 {P(*p1)}", a, b

def diamond(x,y,s):
    return f"M{P(x,y-s)}L{P(x+s,y)}L{P(x,y+s)}L{P(x-s,y)}Z"

def wreath2(R=170, n=7, a0=100, a1=236, L=90, W=30, tilt=20, inner=True, taper=0.65, style="lens", iL=0.72, itilt=-24, off=0.5):
    d=[]
    f=lens if style=="lens" else facet
    def leaf(t,Lx,Wx,tl):
        x=CX+R*math.cos(t); y=CY+R*math.sin(t)
        ang=t+math.pi/2+math.radians(tl)
        return [(x,y,ang),(2*CX-x,y,math.pi-ang)]
    for i in range(n):
        u=i/(n-1); sc=1-(1-taper)*u
        t=math.radians(a0+(a1-a0)*u)
        for (x,y,ang) in leaf(t,0,0,tilt): d.append(f(x,y,ang,L*sc,W*sc))
        if inner and i<n-1:
            u2=(i+off)/(n-1); sc2=(1-(1-taper)*u2)*iL
            t2=math.radians(a0+(a1-a0)*u2)
            for (x,y,ang) in leaf(t2,0,0,itilt): d.append(f(x,y,ang,L*sc2,W*sc2))
    return " ".join(d)
