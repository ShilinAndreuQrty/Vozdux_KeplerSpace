(()=>{
const c=document.getElementById("tb-canvas");if(!c)return;
const $=id=>document.getElementById(id),g=c.getContext("2d");
const AU_KM = 149597870.7;
const DAY_S = 86400;
const G = 2.959122082855911e-4;
const KM_S_TO_AU_DAY = DAY_S / AU_KM;
const SQRT_G = Math.sqrt(G);
const DT = 0.01;
const C = ["#8ddcff","#ffc58e","#c7a5ff"];
const P={
// Figure-eight: outer bodies are symmetric about the COM; central velocity is -2 times either outer velocity.
figure8:[[-.97000436,.24308753,.466203685,.43236573,1],[.97000436,-.24308753,.466203685,.43236573,1],[0,0,-.93240737,-.86473146,1]],
triangle:[[0,0,0,0,1],[1.2,0,0,0,1],[.6,1.0392304845,0,0,1]],
chaos:[[-1.05,.25,.12,.55,1],[.82,.52,-.28,-.12,1],[.12,-.82,.34,-.18,1]]};
let B=[],INITIAL=[],DRAFT={},DIRTY={},T=[[],[],[]],sel=-1,run=false,time=0,speed=1,acc=0,last=0,drag=-1,vectorDrag=false,V={x:0,y:0,s:100};
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x)),fmt=(x,n=3)=>Number(x).toFixed(n).replace(".",",");
function setV(b,v,a){ let q=a*Math.PI/180; let w=v*KM_S_TO_AU_DAY; b.vx=w*Math.cos(q); b.vy=w*Math.sin(q); };
const vel=b=>Math.hypot(b.vx,b.vy)/KM_S_TO_AU_DAY;
function preset(name){
    B=P[name].map(a=>({
        x:a[0],
        y:a[1],
        vx:a[2]*SQRT_G,
        vy:a[3]*SQRT_G,
        m:a[4]
    }));
    if(name==="triangle"){
        const side=1.2, m=B.reduce((s,b)=>s+b.m,0), cx=B.reduce((s,b)=>s+b.m*b.x,0)/m, cy=B.reduce((s,b)=>s+b.m*b.y,0)/m;
        const w=Math.sqrt(G*m/(side**3));
        B.forEach(b=>{const x=b.x-cx,y=b.y-cy;b.x=x;b.y=y;b.vx=-w*y;b.vy=w*x});
    }
    INITIAL=B.map(b=>({...b}));DRAFT={};DIRTY={};sel=-1;editor();resetAll();
}
function accels(s){return s.map((b,i)=>{let ax=0,ay=0;s.forEach((o,j)=>{if(i===j)return;let x=o.x-b.x,y=o.y-b.y,r2=x*x+y*y;if(r2<1e-12)return;let z=G*o.m/(r2*Math.sqrt(r2));ax+=x*z;ay+=y*z});return{ax,ay}})}
function deriv(s){let a=accels(s);return s.map((b,i)=>({x:b.vx,y:b.vy,vx:a[i].ax,vy:a[i].ay}))}
function shift(s,k,f){return s.map((b,i)=>({...b,x:b.x+k[i].x*f,y:b.y+k[i].y*f,vx:b.vx+k[i].vx*f,vy:b.vy+k[i].vy*f}))}
function step(){let a=deriv(B),b=deriv(shift(B,a,DT/2)),d=deriv(shift(B,b,DT/2)),e=deriv(shift(B,d,DT));B=B.map((p,i)=>({...p,x:p.x+DT/6*(a[i].x+2*b[i].x+2*d[i].x+e[i].x),y:p.y+DT/6*(a[i].y+2*b[i].y+2*d[i].y+e[i].y),vx:p.vx+DT/6*(a[i].vx+2*b[i].vx+2*d[i].vx+e[i].vx),vy:p.vy+DT/6*(a[i].vy+2*b[i].vy+2*d[i].vy+e[i].vy)}));time+=DT;B.forEach((b,i)=>{T[i].push({x:b.x,y:b.y});if(T[i].length>2000)T[i].shift()})}
function energy(){let e=0;B.forEach(b=>e+=.5*b.m*(b.vx*b.vx+b.vy*b.vy));for(let i=0;i<3;i++)for(let j=i+1;j<3;j++){let x=B[j].x-B[i].x,y=B[j].y-B[i].y;e-=G*B[i].m*B[j].m/Math.max(Math.sqrt(x*x+y*y),1e-9)}return e}
function resize(){let r=c.getBoundingClientRect(),d=Math.min(devicePixelRatio||1,2);c.width=r.width*d;c.height=r.height*d;g.setTransform(d,0,0,d,0,0);V.x=r.width/2;V.y=r.height/2;V.s=Math.min(r.width,r.height)/7}
const scr=p=>({x:V.x+p.x*V.s,y:V.y-p.y*V.s}),world=p=>({x:(p.x-V.x)/V.s,y:-(p.y-V.y)/V.s});
function arrow(ctx,x,y,dx,dy,col){let a=Math.atan2(dy,dx),L=12;ctx.strokeStyle=col;ctx.fillStyle=col;ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+dx,y+dy);ctx.stroke();ctx.beginPath();ctx.moveTo(x+dx,y+dy);ctx.lineTo(x+dx-L*Math.cos(a-.45),y+dy-L*Math.sin(a-.45));ctx.lineTo(x+dx-L*Math.cos(a+.45),y+dy-L*Math.sin(a+.45));ctx.fill()}
function grid(w,h){g.save();let st=V.s>190?.25:V.s>80?.5:1,l=-V.x/V.s,r=(w-V.x)/V.s,b=-(h-V.y)/V.s,t=V.y/V.s;g.strokeStyle="#9eb7d522";g.fillStyle="#9eb7d5";g.font="10px sans-serif";for(let x=Math.ceil(l/st)*st;x<=r;x+=st){let px=V.x+x*V.s;g.beginPath();g.moveTo(px,0);g.lineTo(px,h);g.stroke();if(x)g.fillText(String(+x.toFixed(2)),px+3,V.y+12)}for(let y=Math.ceil(b/st)*st;y<=t;y+=st){let py=V.y-y*V.s;g.beginPath();g.moveTo(0,py);g.lineTo(w,py);g.stroke();if(y)g.fillText(String(+y.toFixed(2)),V.x+5,py-3)}g.strokeStyle="#c4d5eb88";g.lineWidth=1.4;g.beginPath();g.moveTo(0,V.y);g.lineTo(w,V.y);g.moveTo(V.x,0);g.lineTo(V.x,h);g.stroke();g.fillStyle="#d3dfef";g.fillText("X, а.е.",w-48,V.y-7);g.fillText("Y, а.е.",V.x+7,13);g.restore()}
function draw(){let w=c.clientWidth,h=c.clientHeight;g.clearRect(0,0,w,h);grid(w,h);T.forEach((a,i)=>{if(a.length<2)return;g.beginPath();a.forEach((p,j)=>{let q=scr(p);j?g.lineTo(q.x,q.y):g.moveTo(q.x,q.y)});g.strokeStyle=C[i]+"99";g.lineWidth=1.5;g.stroke()});B.forEach((b,i)=>{let p=scr(b),rad=10+Math.min(7,Math.sqrt(b.m)*2);let glow=g.createRadialGradient(p.x,p.y,1,p.x,p.y,rad*3);glow.addColorStop(0,C[i]+"99");glow.addColorStop(1,C[i]+"00");g.fillStyle=glow;g.beginPath();g.arc(p.x,p.y,rad*3,0,7);g.fill();g.fillStyle=C[i];g.beginPath();g.arc(p.x,p.y,rad,0,7);g.fill();g.strokeStyle=sel===i?"white":"#ffffff99";g.lineWidth=sel===i?2.5:1;g.stroke();g.fillStyle="#e4edfa";g.font="11px sans-serif";g.fillText("Тело "+(i+1),p.x+11,p.y-11);let d=(sel===i&&DRAFT[i])?DRAFT[i]:b;let a=Math.atan2(d.vy,d.vx),len=clamp(vel(d)*2.0,16,90);arrow(g,p.x,p.y,Math.cos(a)*len,-Math.sin(a)*len,C[i])});$("tb-time").textContent=fmt(time,2)+" суток";$("tb-energy").textContent=fmt(energy(),7)}
function reset(){run=false;time=0;acc=0;T=B.map(b=>[{x:b.x,y:b.y}]);$("tb-start").disabled=false;$("tb-pause").disabled=true;$("tb-pause").textContent="Пауза";$("tb-status").textContent="Модель остановлена";draw()}
function resetAll(){B=INITIAL.map(b=>({...b}));DRAFT={};DIRTY={};reset();editor()}
function resetSelected(){if(sel<0)return;B[sel]={...INITIAL[sel]};delete DRAFT[sel];delete DIRTY[sel];reset();editor()}
function draftFor(i){if(!DRAFT[i])DRAFT[i]={vx:B[i].vx,vy:B[i].vy};return DRAFT[i]}
function editor(){let f=$("tb-fields"),h=$("tb-help");if(sel<0){f.hidden=true;h.hidden=false;$("tb-editor-title").textContent="Выбери тело";return}let b=B[sel],d=draftFor(sel);f.hidden=false;h.hidden=true;$("tb-editor-title").textContent="Тело "+(sel+1);$("tb-mass").value=b.m;$("tb-mass-range").value=clamp(b.m,.0001,10);$("tb-mass-out").textContent=fmt(b.m,5);$("tb-x").value=b.x.toFixed(5);$("tb-y").value=b.y.toFixed(5);$("tb-vel").value=(Math.hypot(d.vx,d.vy)/K).toFixed(3);$("tb-vel-range").value=clamp(Math.hypot(d.vx,d.vy)/K,0,100);$("tb-vel-out").textContent=fmt(Math.hypot(d.vx,d.vy)/K);$("tb-angle").value=(Math.atan2(d.vy,d.vx)*180/Math.PI).toFixed(2)}
function read(){return{m:+$("tb-mass").value,x:+$("tb-x").value,y:+$("tb-y").value,v:+$("tb-vel").value,a:+$("tb-angle").value}}
function applyMass(all){let m=+$("tb-mass").value;if(!Number.isFinite(m)||m<=0||m>1000){alert("Масса должна быть больше нуля и не превышать 1000 масс Солнца.");return}B.forEach((b,i)=>{if(all||i===sel)b.m=m});$("tb-status").textContent=all?"Масса применена ко всем телам":"Масса применена к телу";reset();editor()}
function applyVelocity(all){let p=read();if(![p.v,p.a].every(Number.isFinite)||p.v<0||p.v>10000||Math.abs(p.a)>360){alert("Проверь скорость и угол вектора.");return}B.forEach((b,i)=>{if(all||i===sel){let d=all?b:draftFor(i);setV(d,p.v,p.a);if(all){b.vx=d.vx;b.vy=d.vy;delete DRAFT[i]}}});if(!all){let d=draftFor(sel);setV(d,p.v,p.a)}$("tb-status").textContent=all?"Скорость применена ко всем телам":"Скорость применена к телу";reset();editor()}
function updateDraftFromInputs(){if(sel<0)return;let v=+$("tb-vel").value,a=+$("tb-angle").value;if(!Number.isFinite(v)||!Number.isFinite(a))return;setV(draftFor(sel),v,a);DIRTY[sel]=true;$("tb-vel-out").textContent=fmt(v);$("tb-vel-range").value=clamp(v,0,100);draw()}
c.addEventListener("pointerdown",e=>{let r=c.getBoundingClientRect(),p={x:e.clientX-r.left,y:e.clientY-r.top};
    if(sel>=0){
        let b=B[sel],d=draftFor(sel),q=scr(b),
            a=Math.atan2(d.vy,d.vx),
            len=clamp(vel(d)*1.0,16,90),
            tip={x:q.x+Math.cos(a)*len,y:q.y-Math.sin(a)*len};

        if(Math.hypot(tip.x-p.x,tip.y-p.y)<15){
            vectorDrag=true;
            c.setPointerCapture(e.pointerId);
            return;
        }
    }
    let i=B.findIndex(b=>{let q=scr(b);return Math.hypot(q.x-p.x,q.y-p.y)<19});
    if(i>=0){
        if(i!==sel && sel>=0){
            const hadChanges=!!DIRTY[sel];
            delete DRAFT[sel];
            delete DIRTY[sel];
            if(hadChanges){
            $("tb-status").textContent="Неподтверждённые изменения отменены";
            }
        }
        sel=i;
        editor();
        drag=i;
        c.setPointerCapture(e.pointerId);
        draw();
    }});
c.addEventListener("pointermove",e=>{
  let r=c.getBoundingClientRect(),
      p={x:e.clientX-r.left,y:e.clientY-r.top};

  if(vectorDrag&&sel>=0&&!run){
    let b=scr(B[sel]),
        dx=p.x-b.x,
        dy=b.y-p.y,
        d=draftFor(sel),
        v=Math.hypot(d.vx,d.vy)/K,
        a=Math.atan2(dy,dx)*180/Math.PI;

    setV(d,v,a);
    DIRTY[sel]=true;
    editor();
    draw();
    return;
  }

  if(drag<0||run)return;
  let q=world(p);
  B[drag].x=q.x;
  B[drag].y=q.y;
  T[drag]=[{...q}];
  editor();
  draw();
});
function end(){drag=-1;vectorDrag=false}c.addEventListener("pointerup",end);c.addEventListener("pointercancel",end);
$("tb-mass").oninput=()=>{$("tb-mass-range").value=clamp(+$("tb-mass").value||.0001,.0001,10);$("tb-mass-out").textContent=fmt(+$("tb-mass").value||0,5)};
$("tb-mass-range").oninput=e=>{$("tb-mass").value=e.target.value;$("tb-mass-out").textContent=fmt(+e.target.value,5)};
$("tb-vel").oninput=updateDraftFromInputs;
$("tb-vel-range").oninput=e=>{$("tb-vel").value=e.target.value;updateDraftFromInputs()};
$("tb-angle").oninput=updateDraftFromInputs;
$("tb-apply").onclick=()=>{let p=read();if(![p.m,p.x,p.y].every(Number.isFinite)||p.m<=0||p.m>1000||Math.abs(p.x)>10000||Math.abs(p.y)>10000){alert("Проверь массу и координаты.");return}B[sel].m=p.m;B[sel].x=p.x;B[sel].y=p.y;let d=draftFor(sel);B[sel].vx=d.vx;B[sel].vy=d.vy;delete DRAFT[sel];delete DIRTY[sel];$("tb-status").textContent="Параметры тела применены";reset();editor()};
$("tb-reset-selected").onclick=resetSelected;
$("tb-mass-all").onclick=()=>applyMass(true);$("tb-velocity-all").onclick=()=>applyVelocity(true);
$("tb-preset").onchange=e=>preset(e.target.value);
$("tb-start").onclick=()=>{if(Object.keys(DIRTY).length){$("tb-status").textContent="Сначала примени или сбрось изменённый черновой вектор";return}run=true;$("tb-start").disabled=true;$("tb-pause").disabled=false;$("tb-status").textContent="Симуляция выполняется"};
$("tb-pause").onclick=()=>{run=!run;$("tb-pause").textContent=run?"Пауза":"Продолжить";$("tb-start").disabled=run;$("tb-status").textContent=run?"Симуляция выполняется":"Пауза"};
$("tb-reset").onclick=resetAll;$("tb-speed").oninput=e=>{speed=+e.target.value;$("tb-speed-out").textContent=speed+"×"};
function frame(n){if(!last)last=n;let dt=Math.min((n-last)/1000,.05);last=n;if(run){acc+=dt*speed*2;let z=0;while(acc>=DT&&z++<500){step();acc-=DT}}draw();requestAnimationFrame(frame)}
B=P.figure8.map(a=>({ x:a[0], y:a[1], vx:a[2]*SQRT_G, vy:a[3]*SQRT_G, m:a[4] })); INITIAL=B.map(b=>({...b}));resize();editor();reset();window.addEventListener("resize",()=>{resize();draw()});requestAnimationFrame(frame);
})();