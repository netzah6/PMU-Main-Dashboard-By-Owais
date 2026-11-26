# Builds the Quick Start Call deck from the main sales deck.
# usage: python3 build_deck.py <repo root> [start_slide_index]
import re, sys, os
root = sys.argv[1]
start = int(sys.argv[2]) if len(sys.argv) > 2 else None
src = open(os.path.join(root, "public/deck/index.html"), encoding="utf-8").read()
s = src

def cut(a, b, keep_b=True, repl=""):
    """remove everything from marker a up to marker b (b stays)"""
    global s
    assert s.count(a) == 1, ("start marker", a, s.count(a))
    i = s.index(a); j = s.index(b, i)
    assert j > i, ("end marker", b)
    s = s[:i] + repl + s[j:]

def sub(a, b, n=1):
    global s
    assert s.count(a) == n, ("replace", a, s.count(a))
    s = s.replace(a, b)

# --- page title
sub("<title>PMU Bookings On Demand</title>", "<title>Quick Start Call — PMU Bookings On Demand</title>")

# --- drop the selling slides 2-5, the map (13), the call script (15)
for line in ['orig(2,"Today…");\n', 'orig(3,"Meet the average PMU artist");\n', 'orig(4,"No reliable system");\n', 'orig(5,"Common problem");\n', 'orig(7,"Customized solution");\n']:
    sub(line, "")
# map (13), Setting Expectations (14) and the call script (15) sit together
cut('live(13,"Area Exclusivity",', 'live(16,"Bonus #2 — Educate Your Clients",')

# --- the program name slide: same look as the old "Easy Bookings On Demand" render,
#     but with the name the VSL uses (Deposit-First Booking System)
NAME = r'''/* ---- quick start: program name, matches the VSL ---- */
live(6,"Deposit-First Booking System",
LOGO+
'<div class="namewrap">'+CHEV+'<div class="namebox rv" style="animation-delay:.12s">Deposit-First Booking System</div></div>');
SLIDES[SLIDES.length-1].th="t-qs-name";
'''
sub('orig(6,"Easy Bookings On Demand");\n', NAME)

# --- drop guarantee (18), calculator (19), prices (20); put the two new slides there
NEW = r'''/* ---- quick start: everything included ---- */
live(21,"Everything you get",
head(10)+
'<h1 class="title rv" style="animation-delay:.06s;position:relative;z-index:2;margin-bottom:22px">Everything You Get With Us</h1>'+
'<div class="incl">'+
  '<div class="incl-card main rv" style="animation-delay:.14s"><h3>Your Deposit-First Booking System</h3><ul>'+
    [["Facebook &amp; Instagram ads","Built, monitored and optimized for you"],
     ["Lead qualification funnel","Only real buyers reach your phone"],
     ["Instant lead alerts","Every qualified lead lands on your phone"],
     ["Your CRM","Every lead and every answer in one place"],
     ["Smart AI PMU Assistant","Replies in 2 minutes and warms them up for you"]
    ].map(function(r,k){return '<li class="rx" style="animation-delay:'+(0.24+k*0.085)+'s"><i>'+CK+'</i><div><b>'+r[0]+'</b><span>'+r[1]+'</span></div></li>';}).join('')+
  '</ul></div>'+
  '<div class="incl-card side rv" style="animation-delay:.22s"><h3>Bonuses</h3><ul>'+
    [["Client education videos","Clients learn about PMU before they speak to you"],
     ["PMU Success Society","Our private group for PMU artists"]
    ].map(function(r,k){return '<li class="rx" style="animation-delay:'+(0.5+k*0.085)+'s"><i>'+CK+'</i><div><b>'+r[0]+'</b><span>'+r[1]+'</span></div></li>';}).join('')+
  '</ul></div>'+
'</div>');
SLIDES[SLIDES.length-1].th="t-qs-included2";

/* ---- quick start: next steps ---- */
live(22,"Let&rsquo;s get you started",
head(11)+
'<div class="row"><div class="col-copy">'+
  '<h1 class="title">Let&rsquo;s Get You<br>Started</h1>'+
  '<p class="lede">Two quick things today.<br>Then <b>we take it from here</b>.</p>'+
'</div><div class="col-visual"><div class="panel steps" style="width:100%">'+
  '<div class="num rv" style="animation-delay:.2s"><b>01</b><span><em>Today</em>Connect your Facebook so we can run your ads</span></div>'+
  '<div class="num rv" style="animation-delay:.32s"><b>02</b><span><em>Today</em>Fill out your onboarding form</span></div>'+
  '<div class="num rv" style="animation-delay:.44s"><b>03</b><span><em>Next</em>We build everything for you</span></div>'+
  '<div class="num rv" style="animation-delay:.56s"><b>04</b><span><em>Then</em>Launch Call &mdash; you go live</span></div>'+
'</div></div></div>');
SLIDES[SLIDES.length-1].th="t-qs-start";

'''
cut("/* ---- 18: guarantee ---- */", "/* ============ render ============ */", repl=NEW)

# --- the calculator's code needs its slide; without the slide it must go too
cut("/* ---- slide 19: their real calculator ---- */", "show(0); window.focus();")

# --- "Slide N" labels follow the new order
MAP = {8:3, 9:4, 10:5, 11:6, 12:7, 16:8, 17:9}
seen = []
def renum(m):
    n = int(m.group(1))
    if n in (10, 11) and m.start() >= s.index("/* ---- quick start: everything included ---- */"):
        return m.group(0)           # the two new slides are already numbered
    seen.append(n)
    return "head(%d%s)" % (MAP[n], m.group(2) or "")
s = re.sub(r"head\((\d+)(,true)?\)", renum, s)
assert sorted(seen) == sorted(MAP), seen

# --- bonuses are now #1 and #2
sub('live(16,"Bonus #2 — Educate Your Clients",', 'live(16,"Bonus #1 — Educate Your Clients",')
sub('<span style="font-weight:400">Bonus #2:</span> Educate Your Clients', '<span style="font-weight:400">Bonus #1:</span> Educate Your Clients')
sub('live(17,"Bonus #3 — PMU Success Society",', 'live(17,"Bonus #2 — PMU Success Society",')
sub('<span style="font-weight:500">Bonus #3:</span><br>PMU Success Society', '<span style="font-weight:500">Bonus #2:</span><br>PMU Success Society')

# --- "all slides" grid: own thumbnails for the new slides, position instead of the old slide number
sub("""<img src="/deck/assets/thumbs/t-'+pad(s.n)+'.jpg" alt="" loading="lazy">""", """<img src="/deck/assets/thumbs/'+(s.th||('t-'+pad(s.n)))+'.jpg" alt="" loading="lazy">""")
sub("""'<em>'+s.n+'</em>'""", """'<em>'+(k+1)+'</em>'""")
sub('id="pos" title="All slides (O)">1 / 22</span>', 'id="pos" title="All slides (O)">1 / 11</span>')

# --- styles for the two new slides
CSS = '''
/* ---------- quick start deck: what's included + next steps ---------- */
.incl{position:relative;z-index:2;flex:1;min-height:0;display:flex;gap:26px;align-items:stretch;padding-bottom:26px}
.incl-card{background:#fff;border:1px solid var(--line);border-radius:18px;padding:30px 34px;
  box-shadow:0 18px 40px -26px rgba(20,25,35,.45);display:flex;flex-direction:column}
.incl-card.main{flex:1.45}
.incl-card.side{flex:1;border-color:var(--teal);background:var(--teal-soft)}
.incl-card h3{margin:0 0 20px;font-family:Poppins,sans-serif;font-size:18px;font-weight:700;letter-spacing:.14em;
  text-transform:uppercase;color:var(--teal-dark)}
.incl-card ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:24px;flex:1;justify-content:center}
.incl-card li{display:flex;gap:18px;align-items:flex-start}
.incl-card li i{flex:none;width:36px;height:36px;border-radius:50%;background:var(--teal);color:#fff;
  display:grid;place-items:center;margin-top:2px;box-shadow:0 2px 8px rgba(46,196,198,.35)}
.incl-card li i svg{width:54%;height:54%}
.incl-card li b{display:block;font-family:Poppins,sans-serif;font-weight:600;font-size:28px;line-height:1.25;color:var(--ink)}
.incl-card li span{display:block;font-family:Poppins,sans-serif;font-size:22px;line-height:1.35;color:var(--muted);margin-top:3px}
.namewrap{position:relative;z-index:2;flex:1;display:flex;align-items:center;justify-content:center;gap:22px;padding-bottom:30px}
.namewrap .chev{width:62px;height:62px}
.namebox{border:2px solid var(--teal);border-radius:22px;padding:30px 70px;background:#fff;white-space:nowrap;
  font-family:Poppins,sans-serif;font-weight:600;font-size:62px;line-height:1.15;color:#111}
.panel.steps .num{margin-bottom:26px}
.panel.steps .num span em{display:block;font-style:normal;font-size:15px;font-weight:700;letter-spacing:.14em;
  text-transform:uppercase;opacity:.85;margin-bottom:2px}
</style>'''
sub("</style>", CSS)

if start is not None:           # only for making thumbnails
    sub("show(0); window.focus();", "show(%d); window.focus();" % start)
    sub("</style>", "#nav,.hint,#bar{display:none!important}</style>")
    out = os.path.join(root, "public/deck/quick-start/_shot.html")
else:
    out = os.path.join(root, "public/deck/quick-start/index.html")
os.makedirs(os.path.dirname(out), exist_ok=True)
open(out, "w", encoding="utf-8").write(s)
print("wrote", out, len(s), "bytes;", s.count("\nlive(") , "live +", s.count("\norig("), "image slides")
