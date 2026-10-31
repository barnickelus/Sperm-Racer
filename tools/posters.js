// Makes posters/<course>.jpg: a still of each course as the Horizon home window shows it. The home's tuning card shows the
// poster the moment a course is picked, while the live course is built. Run again whenever a course's look changes.
//
//   python3 -m http.server 8765 --directory .      (serve the game)
//   node tools/posters.js [port]                    (needs Playwright with Chromium: npm i -D playwright)
//
// Each course is opened on a fresh page at iPad landscape (1180x820 at 1.5x), picked by its card in the strip, and the
// window is captured once the live course is up, with the window's own text, racer card and scanlines hidden.
const {chromium}=require('playwright'); const fs=require('fs'), path=require('path');
const port=process.argv[2]||8765, out=path.join(__dirname,'..','posters');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const seen=()=>{ try{ localStorage.setItem('sr_seen_home','1'); localStorage.setItem('sr_sel3d','0'); }catch(_){} };
(async()=>{
  fs.mkdirSync(out,{recursive:true});
  const b=await chromium.launch({args:['--use-gl=swiftshader','--enable-webgl','--ignore-gpu-blocklist','--mute-audio']});
  const c0=await b.newContext({viewport:{width:1180,height:820}}); const p0=await c0.newPage(); await p0.addInitScript(seen);
  await p0.goto(`http://localhost:${port}/index.html`); await p0.waitForFunction(()=>{const s=document.getElementById('start');return s&&!s.classList.contains('hidden');},null,{timeout:120000});
  const names=await p0.evaluate(()=>[...document.querySelectorAll('#trackpick .trk')].map(e=>e.textContent)); await c0.close();
  for(const name of names){
    const ctx=await b.newContext({viewport:{width:1180,height:820},deviceScaleFactor:1.5,hasTouch:true}); await ctx.addInitScript(seen);
    const p=await ctx.newPage();
    await p.goto(`http://localhost:${port}/index.html`);
    await p.waitForFunction(()=>{const s=document.getElementById('start');return s&&!s.classList.contains('hidden');},null,{timeout:120000});
    await p.evaluate(n=>{ [...document.querySelectorAll('#trackpick .trk')].find(e=>e.textContent===n).click(); },name);
    await p.waitForFunction(()=>document.getElementById('hzwin').classList.contains('tuning'),null,{timeout:20000}).catch(()=>{});
    await p.waitForFunction(()=>!document.getElementById('hzwin').classList.contains('tuning'),null,{timeout:120000});
    await sleep(2500);
    await p.addStyleTag({content:'.hz-nm,.hz-pip,.hz-tune{visibility:hidden!important} body.hz .hzdeck::after,.hz-screen::before{display:none!important}'});
    await sleep(1500);
    const clip=await p.evaluate(()=>{ const r=document.getElementById('hzscreen').getBoundingClientRect(); return {x:r.left,y:r.top,width:r.width,height:r.height}; });
    const file=path.join(out,name.toLowerCase()+'.jpg');
    await p.screenshot({path:file,type:'jpeg',quality:82,clip});
    console.log(name, Math.round(clip.width*1.5)+'x'+Math.round(clip.height*1.5), (fs.statSync(file).size/1024).toFixed(0)+' KB');
    await ctx.close();
  }
  await b.close();
})().catch(e=>{ console.error(e); process.exit(1); });
