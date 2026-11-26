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
# In their place: a real AI conversation, taken from the Launch Call presentation
# (slide 11 there). The lead's own photos are NOT copied; two brow close-ups from
# our own before/after content stand in (public/deck/assets/ai-brow1.jpg, ai-brow2.jpg).
AI = r'''/* ---- quick start: the AI in action (conversation from the Launch Call deck) ---- */
live(23,"The AI in action",
HEAD_NEW(8,true)+
'<div class="row"><div class="col-copy">'+
  '<h1 class="title" style="white-space:nowrap">See The AI In Action</h1>'+
  '<p class="lede">Watch it chat with a new lead. <b>The AI wrote every teal message.</b></p>'+
  bullets(["Based on thousands of successful conversations","Built to turn leads into booked appointments with a deposit"])+
'</div><div class="col-visual"><div class="phone ph-sms"><div class="notch"></div><div class="screen">'+
  '<div class="statusbar"><span>6:06</span><span>&#9679;&#9679;&#9679;&#9679; 5G</span></div>'+
  '<div class="ios-head"><span class="ios-back"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="m15 18-6-6 6-6"/></svg></span>'+
    '<span class="ios-av ai-av">V</span>'+
    '<span class="ios-name">Vikki <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="m9 18 6-6-6-6"/></svg></span>'+
    '<span class="ai-chip"><i></i>AI is replying</span></div>'+
  '<div class="ios-body" id="ai-body"></div>'+
  '<div class="ios-foot"><span class="plus">+</span><span class="inp">Text Message · SMS</span><span>&#9835;</span></div>'+
'</div></div></div></div>');
SLIDES[SLIDES.length-1].th="t-qs-ai3";

'''
cut('live(13,"Area Exclusivity",', 'live(16,"Bonus #2 — Educate Your Clients",', repl=AI)

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
live(21,"Everything you get",(function(){
  /* [name, line under it, value in dollars] — the values are what each piece
     would cost bought on its own; the total is added up here, never typed. */
  var MAIN=[["Facebook &amp; Instagram ads","Built, monitored and optimized for you",1497],
            ["Lead qualification funnel","Only real buyers reach your phone",997],
            ["Instant lead alerts","Every qualified lead lands on your phone",197],
            ["Your CRM","Every lead and every answer in one place",297],
            ["Smart AI PMU Assistant","Replies in 2 minutes and warms them up for you",997]],
      BONUS=[["Client education videos","Clients learn about PMU before they speak to you",497],
             ["PMU Success Society","Our private group for PMU artists",497]],
      /* what the artist pays (owner, 11/26/2026): [emoji, headline, line under it] */
      PAY=[["💵","$50 deposit","Paid by each new client when she books. It goes to PMU Bookings On Demand."],
           ["🤝","$80 per appointment","Only after you get paid."],
           ["✅","2nd treatments + upsells","100% yours."],
           ["📣","$20 a day on ads","Your ad budget, paid to Facebook."]],
      tot=0;
  function usd(n){return "$"+n.toLocaleString("en-US");}
  function row(base){return function(r,k){tot+=r[2];
    return '<li class="rx" style="animation-delay:'+(base+k*0.07)+'s"><i>'+CK+'</i><div><b>'+r[0]+'</b><span>'+r[1]+'</span></div>'+
      '<em class="val">'+usd(r[2])+'<small>value</small></em></li>';};}
  var main=MAIN.map(row(0.2)).join(''), bonus=BONUS.map(row(0.56)).join('');
  var pay=PAY.map(function(r,k){
    return '<li class="rx" style="animation-delay:'+(1.0+k*0.1)+'s"><i>'+r[0]+'</i><div><b>'+r[1]+'</b><span>'+r[2]+'</span></div></li>';}).join('');
  return HEAD_NEW(11)+
'<h1 class="title rv" style="animation-delay:.06s;position:relative;z-index:2;margin-bottom:16px">Everything You Get With Us</h1>'+
'<div class="incl">'+
  '<div class="incl-card main rv" style="animation-delay:.14s">'+
    '<h3>Your Deposit-First Booking System</h3><ul>'+main+'</ul>'+
    '<h3 class="bon">+ Bonuses</h3><ul>'+bonus+'</ul>'+
    '<div class="incl-total"><span>Total value</span><b id="incl-total" data-n="'+tot+'">'+usd(tot)+'</b></div>'+
  '</div>'+
  '<div class="incl-card pay rv" style="animation-delay:.8s">'+
    '<h3>What you pay</h3>'+
    '<div class="pay-zero"><b>$0</b><span>today</span></div>'+
    '<ul>'+pay+'</ul>'+
  '</div>'+
'</div>';
})());
SLIDES[SLIDES.length-1].th="t-qs-included6";

/* ---- quick start: next steps ---- */
live(22,"Let&rsquo;s get you started",
HEAD_NEW(12)+
'<div class="row"><div class="col-copy">'+
  '<h1 class="title" style="margin-bottom:18px;white-space:nowrap">Let&rsquo;s Get You Started <span class="rocket-in">🚀</span></h1>'+
  '<p class="lede">Two quick things today.<br>Then <b>we take it from here</b>.</p>'+
  '<div class="liftoff rv" style="animation-delay:.5s"><span class="rocket">🚀</span><span>Next stop: <b>you go live</b></span></div>'+
'</div><div class="col-visual"><div class="panel steps" style="width:100%">'+
  '<div class="num rv" style="animation-delay:.2s"><b>01</b><span><em>Today</em>🔗 Connect your Facebook so we can run your ads</span></div>'+
  '<div class="num rv" style="animation-delay:.32s"><b>02</b><span><em>Today</em>📝 Fill out your onboarding form</span></div>'+
  '<div class="num rv" style="animation-delay:.44s"><b>03</b><span><em>Next</em>🛠️ We build everything for you</span></div>'+
  '<div class="num go rv" style="animation-delay:.6s"><b>04</b><span><em>Then</em>🚀 Launch Call &mdash; you go live!</span></div>'+
'</div></div></div>');
SLIDES[SLIDES.length-1].th="t-qs-start3";

'''
cut("/* ---- 18: guarantee ---- */", "/* ============ render ============ */", repl=NEW)

# --- the calculator's code needs its slide; without the slide it must go too
cut("/* ---- slide 19: their real calculator ---- */", "show(0); window.focus();")

# --- "Slide N" labels follow the new order
MAP = {8:3, 9:4, 10:5, 11:6, 12:7, 16:9, 17:10}
seen = []
def renum(m):
    n = int(m.group(1)); seen.append(n)
    return "head(%d%s)" % (MAP[n], m.group(2) or "")
s = re.sub(r"(?<![A-Z_])head\((\d+)(,true)?\)", renum, s)
assert sorted(seen) == sorted(MAP), seen
s = s.replace("HEAD_NEW(", "head(")

# --- bonuses are now #1 and #2
sub('live(16,"Bonus #2 — Educate Your Clients",', 'live(16,"Bonus #1 — Educate Your Clients",')
sub('<span style="font-weight:400">Bonus #2:</span> Educate Your Clients', '<span style="font-weight:400">Bonus #1:</span> Educate Your Clients')
sub('live(17,"Bonus #3 — PMU Success Society",', 'live(17,"Bonus #2 — PMU Success Society",')
sub('<span style="font-weight:500">Bonus #3:</span><br>PMU Success Society', '<span style="font-weight:500">Bonus #2:</span><br>PMU Success Society')

# --- the AI conversation plays when its slide opens
AIJS = r'''/* ---- quick start: the AI conversation ---- */
/* the two photos are close-ups cut from the BEFORE half of one of our own
   before/after pictures; loaded up front so they do not pop in late */
["ai-brow1","ai-brow2"].forEach(function(n){var im=new Image();im.src="/deck/assets/"+n+".jpg";});
var AICHAT=[
  {o:1,t:"Hi, this is Megan"},
  {o:1,t:"I just got a request from that number for permanent makeup eyebrows, is it Vikki?"},
  {o:0,t:"Yes! \ud83d\ude0a"},
  {o:1,t:"Great! I\u2019d love to see how we can help. We customise our services based on your goals. Can you let me know what made you reach out? That way, I can see if we\u2019re a good fit. :)"},
  {o:1,t:"If you could also send me some pictures of your eyebrows, that would be really helpful!"},
  {o:0,t:"My eyebrows are thinning. I\u2019ve always had full brows but this year noticeably thinning. I don\u2019t want to have to pencil in daily for sure. I\u2019m 54 \ud83d\ude4c"},
  {o:0,pics:2}
];
/* "Everything you get": the total counts up from $0 each time the slide opens */
var totEl=document.getElementById("incl-total"),totT=[];
function runTotal(){
  totT.forEach(clearTimeout);totT=[];
  var n=+totEl.dataset.n,steps=36;
  totEl.textContent="$0";totEl.classList.remove("cut");
  for(var k=1;k<=steps;k++)(function(k){
    totT.push(setTimeout(function(){
      var e=1-Math.pow(1-k/steps,3);   // ease out
      totEl.textContent="$"+Math.round(n*e).toLocaleString("en-US");
    },1100+k*34));
  })(k);
  /* then cross it out in red: they pay $0 today */
  totT.push(setTimeout(function(){totEl.classList.add("cut");},1100+steps*34+450));
}
var aiBody=document.getElementById("ai-body"),aiT=[];
function aiTrim(){while(aiBody.scrollHeight>aiBody.clientHeight&&aiBody.children.length>1) aiBody.removeChild(aiBody.children[0]);}
function runAi(){
  aiT.forEach(clearTimeout);aiT=[];
  aiBody.innerHTML='<div class="ios-stamp"><b>Today</b> 6:06 PM</div>';
  var at=600;
  AICHAT.forEach(function(m){
    var cls="ios-row in"+(m.o?" out":""), wait=m.o?1300:1000;
    aiT.push(setTimeout(function(){
      var t=document.createElement("div");t.className=cls;t.id="ai-typing";
      t.innerHTML='<div class="typing"><i></i><i></i><i></i></div>';aiBody.appendChild(t);aiTrim();
    },at));
    aiT.push(setTimeout(function(){
      var t=document.getElementById("ai-typing");if(t)t.remove();
      var d=document.createElement("div");d.className=cls;
      d.innerHTML=m.pics?'<div class="ai-pics"><img src="/deck/assets/ai-brow1.jpg" alt=""><img src="/deck/assets/ai-brow2.jpg" alt=""></div>':'<div class="ios-bub">'+m.t+'</div>';
      aiBody.appendChild(d);aiTrim();
    },at+wait));
    at+=wait+((m.t||"").length>90?2800:1500);   // long messages stay on screen longer
  });
}

'''
sub("/* ---- slide 11: draggable pipeline ---- */", AIJS + "/* ---- slide 11: draggable pipeline ---- */")
sub("  if(num===11) runCrm();\n", "  if(num===11) runCrm();\n  if(num===23) runAi();\n  if(num===21) runTotal();\n")

# --- "all slides" grid: own thumbnails for the new slides, position instead of the old slide number
sub("""<img src="/deck/assets/thumbs/t-'+pad(s.n)+'.jpg" alt="" loading="lazy">""", """<img src="/deck/assets/thumbs/'+(s.th||('t-'+pad(s.n)))+'.jpg" alt="" loading="lazy">""")
sub("""'<em>'+s.n+'</em>'""", """'<em>'+(k+1)+'</em>'""")
sub('id="pos" title="All slides (O)">1 / 22</span>', 'id="pos" title="All slides (O)">1 / 12</span>')

# --- styles for the two new slides
CSS = '''
/* ---------- quick start deck: what's included + next steps ---------- */
.incl{position:relative;z-index:2;flex:1;min-height:0;display:flex;gap:26px;align-items:stretch;padding-bottom:26px}
.incl-card{background:#fff;border:1px solid var(--line);border-radius:18px;padding:30px 34px;
  box-shadow:0 18px 40px -26px rgba(20,25,35,.45);display:flex;flex-direction:column}
.incl-card.main{flex:1.32;padding:22px 30px 22px}
.incl-card.main ul{flex:none;gap:11px}
.incl-card.main h3{margin-bottom:12px}
.incl-card.main h3.bon{margin:16px 0 12px;padding-top:14px;border-top:1px dashed #cfd6de}
.incl-card.main li i{width:30px;height:30px;margin-top:3px}
.incl-card.main li b{font-size:24px}
.incl-card.main li span{font-size:18px;margin-top:1px}
.incl-card li>div{min-width:0}
.incl-card li .val{margin-left:auto;padding-left:18px;flex:none;text-align:right;font-style:normal;white-space:nowrap;
  font-family:Poppins,sans-serif;font-weight:700;font-size:26px;line-height:1.15;color:var(--teal-dark)}
.incl-card li .val small{display:block;font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#8a94a0}
.incl-total{margin-top:auto;flex:none;display:flex;align-items:center;justify-content:space-between;gap:18px;background:var(--teal);color:#fff;
  border-radius:14px;padding:13px 24px;box-shadow:0 18px 40px -22px rgba(46,196,198,.9)}
.incl-total span{font-family:Poppins,sans-serif;font-weight:700;font-size:18px;letter-spacing:.14em;text-transform:uppercase}
.incl-total b{position:relative;font-family:Poppins,sans-serif;font-weight:800;font-size:50px;line-height:1;font-variant-numeric:tabular-nums}
.incl-total b::after{content:"";position:absolute;left:-10px;right:-10px;top:50%;height:7px;margin-top:-2px;background:#ff3b30;border-radius:4px;
  box-shadow:0 1px 5px rgba(0,0,0,.28);transform-origin:center;
  /* tilted around the MIDDLE of the number (so it sits on the digits), drawn in from its left end */
  transform:rotate(-7deg) translateX(-50%) scaleX(0) translateX(50%);transition:transform .5s cubic-bezier(.2,.8,.3,1)}
.incl-total b.cut::after{transform:rotate(-7deg) translateX(-50%) scaleX(1) translateX(50%)}
.incl-card.pay{flex:1;border:2px solid var(--teal);background:var(--teal-soft);padding:26px 30px}
.incl-card.pay ul{gap:20px;justify-content:flex-start}
.pay-zero{display:flex;align-items:baseline;gap:14px;margin:2px 0 22px;padding-bottom:20px;border-bottom:1px dashed #9fdcdc}
.pay-zero b{font-family:Poppins,sans-serif;font-weight:800;font-size:112px;line-height:.9;color:var(--teal-dark)}
.pay-zero span{font-family:Poppins,sans-serif;font-weight:700;font-size:40px;color:var(--ink)}
.incl-card.pay li i{background:#fff;font-style:normal;font-size:21px;width:42px;height:42px;margin-top:0;box-shadow:0 2px 8px rgba(20,25,35,.12)}
.incl-card.pay li b{font-size:26px}
.incl-card.pay li span{font-size:19px}
.incl-card h3{margin:0 0 20px;font-family:Poppins,sans-serif;font-size:18px;font-weight:700;letter-spacing:.14em;
  text-transform:uppercase;color:var(--teal-dark)}
.incl-card ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:20px;flex:1;justify-content:center}
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
.ios-row.out{align-items:flex-end}
.ios-row.out .ios-bub{background:var(--teal);color:#fff}
.ios-row.out .ios-bub::before{left:auto;right:-5px;background:var(--teal);border-bottom-right-radius:0;border-bottom-left-radius:17px}
.ios-row.out .ios-bub::after{left:auto;right:-10px;border-bottom-right-radius:0;border-bottom-left-radius:13px}
.ios-row.out .typing{background:var(--teal)}
.ios-row.out .typing i{background:#fff}
.ai-av{font-family:var(--ios);font-weight:600;font-size:18px;color:#fff;background:linear-gradient(160deg,#b9bcc6,#8d9099);border:0}
.ai-chip{display:inline-flex;align-items:center;gap:5px;font-family:var(--ios);font-size:10.5px;font-weight:600;color:var(--teal-dark);
  background:var(--teal-soft);border-radius:999px;padding:2px 9px}
.ai-chip i{width:6px;height:6px;border-radius:50%;background:var(--teal);animation:blink 1.4s infinite}
.ai-pics{display:flex;gap:6px}
.ai-pics img{width:108px;height:108px;border-radius:14px;object-fit:cover;display:block;background:#eee}
.panel.steps .num{margin-bottom:26px}
.panel.steps .num.go{background:#fff;color:var(--ink);border-radius:18px;padding:14px 18px;margin:0 -18px;
  box-shadow:0 14px 30px -14px rgba(0,0,0,.35)}
.panel.steps .num.go b{background:var(--teal);color:#fff}
.panel.steps .num.go span em{color:var(--teal-dark);opacity:1}
.liftoff{display:inline-flex;align-items:center;gap:16px;margin-top:6px;background:var(--teal-soft);border:2px solid var(--teal);
  border-radius:18px;padding:14px 26px 14px 18px;font-family:Poppins,sans-serif;font-size:26px;color:#2b3340}
.liftoff b{font-weight:700;color:var(--teal-dark)}
.liftoff .rocket{font-size:46px;line-height:1;display:inline-block;animation:lift 2.6s ease-in-out infinite}
@keyframes lift{0%,100%{transform:translate(0,0) rotate(0)}50%{transform:translate(5px,-9px) rotate(-6deg)}}
.rocket-in{display:inline-block}
.slide.on .rocket-in{animation:fly .9s cubic-bezier(.2,.8,.3,1) .25s both}
@keyframes fly{from{opacity:0;transform:translate(-70px,60px) scale(.5)}to{opacity:1;transform:none}}
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
