/* Character X-ray: run the REAL game makeCell() in Node (three.js needs no GPU
 * for geometry), then software-rasterize front + back views to a PNG so the
 * actual racers — and their accessories — can be inspected directly.
 *
 * Usage: node render-characters.js <typeId> [hue]
 *        node render-characters.js all          (contact sheet) */
const fs=require('fs'), zlib=require('zlib');
const T=require('three');

/* ---- stubs so the canvas/sprite helpers don't need a browser ---- */
const noctx=new Proxy({}, {get:()=>()=>{}});
global.document={ createElement:()=>({width:0,height:0,getContext:()=>noctx}) };
const glowSprite=()=> new T.Object3D();        // sprites are skipped by the rasterizer anyway

/* ---- pull the real GRAD/outline/tail/celShade/tailTex/makeCell out of index.html ---- */
const html=fs.readFileSync('index.html','utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/i)[1] || html;
function sliceBlock(src, startToken, fnEndToken){
  const s=src.indexOf(startToken); if(s<0) throw new Error('missing '+startToken);
  // brace-match from the first '{' after the token
  let i=src.indexOf('{', s), depth=0;
  for(;i<src.length;i++){ if(src[i]==='{')depth++; else if(src[i]==='}'){depth--; if(depth===0){i++;break;}} }
  return src.slice(s, i);
}
const gradStart=script.indexOf('const GRAD=');
const makeCellBlock=sliceBlock(script,'function makeCell');
const body=script.slice(gradStart, script.indexOf(makeCellBlock)+makeCellBlock.length);
const factory=new Function('T','glowSprite','document', body+'\nreturn { makeCell };');
const { makeCell }=factory(T, glowSprite, global.document);

/* ---- minimal software rasterizer (z-buffered triangles, flat lambert) ---- */
function renderView(group, camPos, look, W, H){
  group.updateMatrixWorld(true);
  const cam=new T.PerspectiveCamera(38, W/H, 1, 2000);
  cam.position.set(camPos.x,camPos.y,camPos.z); cam.up.set(0,1,0); cam.lookAt(look.x,look.y,look.z);
  cam.updateMatrixWorld(true); cam.updateProjectionMatrix();
  const vp=new T.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  const buf=new Uint8Array(W*H*3), zb=new Float32Array(W*H).fill(Infinity);
  // background gradient
  for(let y=0;y<H;y++){ const t=y/H, r=10+18*t, g=40-14*t, b=52-18*t;
    for(let x=0;x<W;x++){ const i=(y*W+x)*3; buf[i]=r; buf[i+1]=g; buf[i+2]=b; } }
  const L=new T.Vector3(0.4,0.8,0.6).normalize();
  const a=new T.Vector3(), b=new T.Vector3(), c=new T.Vector3();
  const sa=[0,0,0], sb=[0,0,0], sc=[0,0,0];
  const meshes=[];
  group.traverse(o=>{ if(o.isMesh && !o.userData.isOutline && o.geometry && o.geometry.attributes.position) meshes.push(o); });
  for(const m of meshes){
    const mat=m.material, col=(mat&&mat.color)?mat.color:{r:.8,g:.8,b:.8};
    const em=(mat&&mat.emissive)?mat.emissive:{r:0,g:0,b:0};
    const pos=m.geometry.attributes.position, idx=m.geometry.index;
    const n=idx?idx.count:pos.count;
    const tri=(i0,i1,i2)=>{
      a.fromBufferAttribute(pos,i0).applyMatrix4(m.matrixWorld);
      b.fromBufferAttribute(pos,i1).applyMatrix4(m.matrixWorld);
      c.fromBufferAttribute(pos,i2).applyMatrix4(m.matrixWorld);
      // world-space face normal for lighting (two-sided)
      const nx=(b.y-a.y)*(c.z-a.z)-(b.z-a.z)*(c.y-a.y);
      const ny=(b.z-a.z)*(c.x-a.x)-(b.x-a.x)*(c.z-a.z);
      const nz=(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
      let nl=Math.hypot(nx,ny,nz)||1; let d=(nx*L.x+ny*L.y+nz*L.z)/nl; d=Math.abs(d);
      const sh=0.32+0.68*d;
      const r=Math.min(255,(col.r*sh+em.r)*255), g=Math.min(255,(col.g*sh+em.g)*255), bl=Math.min(255,(col.b*sh+em.b)*255);
      // project (Vector3.applyMatrix4 does the perspective divide)
      for(const [v,s] of [[a,sa],[b,sb],[c,sc]]){ const p=v.clone().applyMatrix4(vp);
        s[0]=(p.x*0.5+0.5)*W; s[1]=(1-(p.y*0.5+0.5))*H; s[2]=p.z; }
      // bbox
      let x0=Math.max(0,Math.floor(Math.min(sa[0],sb[0],sc[0]))), x1=Math.min(W-1,Math.ceil(Math.max(sa[0],sb[0],sc[0])));
      let y0=Math.max(0,Math.floor(Math.min(sa[1],sb[1],sc[1]))), y1=Math.min(H-1,Math.ceil(Math.max(sa[1],sb[1],sc[1])));
      const area=(sb[0]-sa[0])*(sc[1]-sa[1])-(sb[1]-sa[1])*(sc[0]-sa[0]); if(Math.abs(area)<1e-6)return;
      for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
        const px=x+0.5, py=y+0.5;
        let w0=((sb[0]-px)*(sc[1]-py)-(sb[1]-py)*(sc[0]-px))/area;
        let w1=((sc[0]-px)*(sa[1]-py)-(sc[1]-py)*(sa[0]-px))/area;
        let w2=1-w0-w1;
        if(w0<0||w1<0||w2<0) continue;
        const z=w0*sa[2]+w1*sb[2]+w2*sc[2]; if(z<-1||z>1) continue;
        const zi=y*W+x; if(z>=zb[zi]) continue; zb[zi]=z;
        const i=zi*3; buf[i]=r; buf[i+1]=g; buf[i+2]=bl;
      }
    };
    if(idx){ for(let i=0;i<n;i+=3) tri(idx.getX(i),idx.getX(i+1),idx.getX(i+2)); }
    else { for(let i=0;i<n;i+=3) tri(i,i+1,i+2); }
  }
  return buf;
}

function bounds(group){
  group.updateMatrixWorld(true);
  const v=new T.Vector3(); const mn=new T.Vector3(1e9,1e9,1e9), mx=new T.Vector3(-1e9,-1e9,-1e9);
  group.traverse(o=>{ if(o.isMesh && !o.userData.isOutline && o.geometry){ const p=o.geometry.attributes.position;
    for(let i=0;i<p.count;i++){ v.fromBufferAttribute(p,i).applyMatrix4(o.matrixWorld); mn.min(v); mx.max(v); } } });
  return {mn,mx, c:mn.clone().add(mx).multiplyScalar(0.5), r:mx.distanceTo(mn)/2};
}

function png(w,h,rgb){
  const raw=Buffer.alloc((w*3+1)*h);
  for(let y=0;y<h;y++){ raw[y*(w*3+1)]=0; for(let x=0;x<w*3;x++) raw[y*(w*3+1)+1+x]=rgb[y*w*3+x]; }
  const idat=zlib.deflateSync(raw,{level:9});
  const tab=(()=>{const t=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();
  const crc=bb=>{let c=0xffffffff;for(const x of bb)c=tab[(c^x)&0xff]^(c>>>8);return(c^0xffffffff)>>>0;};
  const chunk=(ty,d)=>{const l=Buffer.alloc(4);l.writeUInt32BE(d.length,0);const td=Buffer.concat([Buffer.from(ty),d]);const cc=Buffer.alloc(4);cc.writeUInt32BE(crc(td),0);return Buffer.concat([l,td,cc]);};
  const ih=Buffer.alloc(13);ih.writeUInt32BE(w,0);ih.writeUInt32BE(h,4);ih[8]=8;ih[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ih),chunk('IDAT',idat),chunk('IEND',Buffer.alloc(0))]);
}

function paste(dst,DW,buf,W,H,ox,oy){ for(let y=0;y<H;y++)for(let x=0;x<W;x++){ const s=(y*W+x)*3,d=((oy+y)*DW+(ox+x))*3; dst[d]=buf[s];dst[d+1]=buf[s+1];dst[d+2]=buf[s+2]; } }

function shotOf(typeId, hue){
  const g=makeCell(hue!=null?hue:200, typeId);
  const bd=bounds(g); const d=bd.r*2.5, cy=bd.c.y;
  const W=300,H=380;
  const front=renderView(g, {x:0,y:cy+bd.r*0.4,z:bd.c.z+d}, {x:0,y:cy,z:bd.c.z}, W,H);
  const back =renderView(g, {x:0,y:cy+bd.r*0.4,z:bd.c.z-d}, {x:0,y:cy,z:bd.c.z}, W,H);
  return {front,back,W,H};
}

const arg=process.argv[2]||'guido';
if(arg==='all'){
  const types=['guido','irish','latin','dragon','king','chad','sailor','cholo','hillbilly','wall','korean','rick','french'];
  const W=300,H=380, DW=W*2, DH=H*types.length;
  const sheet=new Uint8Array(DW*DH*3);
  types.forEach((t,i)=>{ const s=shotOf(t,200); paste(sheet,DW,s.front,W,H,0,i*H); paste(sheet,DW,s.back,W,H,W,i*H);
    console.log('rendered',t); });
  fs.writeFileSync('characters.png', png(DW,DH,Buffer.from(sheet)));
  console.log('wrote characters.png',DW+'x'+DH);
}else{
  const s=shotOf(arg, process.argv[3]!=null?+process.argv[3]:200);
  const DW=s.W*2, sheet=new Uint8Array(DW*s.H*3);
  paste(sheet,DW,s.front,s.W,s.H,0,0); paste(sheet,DW,s.back,s.W,s.H,s.W,0);
  fs.writeFileSync('char-'+arg+'.png', png(DW,s.H,Buffer.from(sheet)));
  console.log('wrote char-'+arg+'.png  (left=front, right=back)');
}
