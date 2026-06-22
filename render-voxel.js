/* CPU software voxel renderer -> PNG (no GPU). Isometric, painter's algorithm.
 * Applies the Chuck-Close "colored shape per voxel" treatment to our character
 * (Salty): every voxel face is a tile with grout + a small shape in a
 * contrasting accent, so the cubes optically blend. Lets me SEE the look. */
const zlib=require('zlib'), fs=require('fs');
const {buildVoxels, buildFace, buildGoddess}=require('./voxel-model.js');

const which=process.argv[2]||'salty';
const SS=2;
const c=(which==='goddess'?9:18)*SS;   // goddess is tall — smaller voxels to fit
const margin=16*SS;
const BG_TOP=[8,42,54], BG_BOT=[3,18,26];

// isometric: +Z -> right+down (toward viewer), +X -> left+down, +Y -> up
const P=(x,y,z)=>[ (z - x)*c, (x + z)*0.5*c - y*c ];
const V = which==='goddess' ? buildGoddess(1.3) : which==='face' ? buildFace(1.3) : buildVoxels(1.5);
const OUT = 'voxel-'+which+'.png';

const clamp=v=>v<0?0:v>255?255:v;
const hash=(x,y,z)=>{ let h=(x*73856093)^(y*19349663)^(z*83492791); return h>>>0; };
const clampf=(v,a,b)=>v<a?a:v>b?b:v;
function rgb2hsl(r,g,b){ r/=255;g/=255;b/=255; const mx=Math.max(r,g,b),mn=Math.min(r,g,b); let h,s,l=(mx+mn)/2;
  if(mx===mn){h=s=0;} else { const d=mx-mn; s=l>0.5?d/(2-mx-mn):d/(mx+mn);
    if(mx===r)h=(g-b)/d+(g<b?6:0); else if(mx===g)h=(b-r)/d+2; else h=(r-g)/d+4; h/=6; }
  return [h,s,l]; }
function hsl2rgb(h,s,l){ let r,g,b; if(s===0){r=g=b=l;} else {
  const f=(p,q,t)=>{ if(t<0)t+=1; if(t>1)t-=1; if(t<1/6)return p+(q-p)*6*t; if(t<1/2)return q; if(t<2/3)return p+(q-p)*(2/3-t)*6; return p; };
  const q=l<0.5?l*(1+s):l+s-l*s, p=2*l-q; r=f(p,q,h+1/3); g=f(p,q,h); b=f(p,q,h-1/3); }
  return [r*255,g*255,b*255]; }
// Chuck-Close optical blend: jitter each tile's base + pair it with a hue-rotated
// (complementary) accent and a pale highlight, so every face is a mini composition.
function tile(rgb, h){
  const r1=(h&255)/255, r2=((h>>>8)&255)/255, r3=((h>>>16)&255)/255, r4=((h>>>24)&255)/255;
  const [H,S,L]=rgb2hsl(rgb[0],rgb[1],rgb[2]);
  const base=hsl2rgb((H+(r1-0.5)*0.05+1)%1, clampf(S+(r3-0.5)*0.18,0,1), clampf(L+(r2-0.5)*0.24,0.06,0.95));
  const acc =hsl2rgb((H+0.33+r4*0.34)%1, clampf(S*0.5+0.4,0.25,1), clampf(0.92-L*0.7+(r1-0.5)*0.18,0.12,0.92));
  const acc2=hsl2rgb((H+0.15+r2*0.1)%1, clampf(S*0.4,0,0.7), clampf(0.86+(r3-0.5)*0.12,0.6,0.97));
  return [base, acc, acc2];
}
function shapeHit(t,u,v){ const du=u-0.5, dv=v-0.5;
  if(t===0) return Math.hypot(du,dv)<0.30;
  if(t===1) return Math.max(Math.abs(du),Math.abs(dv))<0.27;
  if(t===2) return Math.abs(du)+Math.abs(dv)<0.33;
  return v>0.30 && v<0.76 && Math.abs(du)<(0.76-v)*0.75;
}

// --- bounds over every voxel corner ---
let minX=1e9,maxX=-1e9,minY=1e9,maxY=-1e9;
for(const v of V) for(const [dx,dy,dz] of [[0,0,0],[1,0,0],[0,1,0],[0,0,1],[1,1,0],[1,0,1],[0,1,1],[1,1,1]]){
  const [px,py]=P(v.x+dx,v.y+dy,v.z+dz);
  if(px<minX)minX=px; if(px>maxX)maxX=px; if(py<minY)minY=py; if(py>maxY)maxY=py;
}
const W=Math.ceil(maxX-minX)+margin*2, H=Math.ceil(maxY-minY)+margin*2;
const ox=margin-minX, oy=margin-minY;

const buf=new Uint8Array(W*H*3);
for(let y=0;y<H;y++){ const t=y/H;
  const r=BG_TOP[0]+(BG_BOT[0]-BG_TOP[0])*t, g=BG_TOP[1]+(BG_BOT[1]-BG_TOP[1])*t, b=BG_TOP[2]+(BG_BOT[2]-BG_TOP[2])*t;
  for(let x=0;x<W;x++){ const i=(y*W+x)*3; buf[i]=r; buf[i+1]=g; buf[i+2]=b; }
}

// fill a parallelogram face as a MINI Chuck-Close composition: rounded-tile grout,
// a central shape (accent), and four corner dots (highlight), over the base.
function fillFace(pts, base, acc, acc2, type, k){
  const p0=pts[0], e1=[pts[1][0]-p0[0],pts[1][1]-p0[1]], e2=[pts[3][0]-p0[0],pts[3][1]-p0[1]];
  const det=e1[0]*e2[1]-e2[0]*e1[1] || 1e-6;
  let bx0=1e9,by0=1e9,bx1=-1e9,by1=-1e9;
  for(const p of pts){ if(p[0]<bx0)bx0=p[0]; if(p[0]>bx1)bx1=p[0]; if(p[1]<by0)by0=p[1]; if(p[1]>by1)by1=p[1]; }
  bx0=Math.max(0,Math.floor(bx0)); by0=Math.max(0,Math.floor(by0));
  bx1=Math.min(W-1,Math.ceil(bx1)); by1=Math.min(H-1,Math.ceil(by1));
  for(let y=by0;y<=by1;y++)for(let x=bx0;x<=bx1;x++){
    const dx=x+0.5-p0[0], dy=y+0.5-p0[1];
    const u=(dx*e2[1]-e2[0]*dy)/det, v=(e1[0]*dy-dx*e1[1])/det;
    if(u<0||u>1||v<0||v>1) continue;
    const cu=u-0.5, cv=v-0.5, qx=Math.abs(cu), qy=Math.abs(cv);
    let col;
    const grout = (qx>0.40||qy>0.40) || (qx>0.32&&qy>0.32&&Math.hypot(qx-0.32,qy-0.32)>0.09);
    if(grout){ col=[base[0]*0.45,base[1]*0.45,base[2]*0.45]; }
    else {
      let central;
      if(type===0) central=Math.hypot(cu,cv)<0.18;
      else if(type===1) central=Math.max(qx,qy)<0.16;
      else if(type===2) central=qx+qy<0.21;
      else central=(cv>-0.16&&cv<0.16&&qx<(0.16-cv)*0.9);
      const dot = Math.hypot(u-0.30,v-0.30)<0.10||Math.hypot(u-0.70,v-0.30)<0.10
               || Math.hypot(u-0.30,v-0.70)<0.10||Math.hypot(u-0.70,v-0.70)<0.10;
      col = central?acc:(dot?acc2:base);
    }
    const i=(y*W+x)*3; buf[i]=clamp(col[0]*k); buf[i+1]=clamp(col[1]*k); buf[i+2]=clamp(col[2]*k);
  }
}

V.sort((a,b)=>(a.x+a.z-a.y)-(b.x+b.z-b.y));    // painter's: far first
for(const v of V){
  const {x,y,z}=v;
  const h=hash(x,y,z), type=h%4, [base,acc,acc2]=tile([v.r,v.g,v.b], h);
  const o=(X,Y,Z)=>{ const [px,py]=P(x+X,y+Y,z+Z); return [px+ox,py+oy]; };
  fillFace([o(0,1,0),o(1,1,0),o(1,1,1),o(0,1,1)], base, acc, acc2, type, 1.0);   // top
  fillFace([o(0,0,1),o(1,0,1),o(1,1,1),o(0,1,1)], base, acc, acc2, type, 0.82);  // +Z (toward viewer)
  fillFace([o(1,0,0),o(1,1,0),o(1,1,1),o(1,0,1)], base, acc, acc2, type, 0.58);  // +X
}

// downsample SS x SS
const OW=W/SS|0, OH=H/SS|0, out=new Uint8Array(OW*OH*3);
for(let y=0;y<OH;y++)for(let x=0;x<OW;x++){ let r=0,g=0,b=0;
  for(let sy=0;sy<SS;sy++)for(let sx=0;sx<SS;sx++){ const i=((y*SS+sy)*W+(x*SS+sx))*3; r+=buf[i]; g+=buf[i+1]; b+=buf[i+2]; }
  const n=SS*SS, o=(y*OW+x)*3; out[o]=r/n; out[o+1]=g/n; out[o+2]=b/n; }

function png(w,h,rgb){
  const raw=Buffer.alloc((w*3+1)*h);
  for(let y=0;y<h;y++){ raw[y*(w*3+1)]=0; for(let x=0;x<w*3;x++) raw[y*(w*3+1)+1+x]=rgb[y*w*3+x]; }
  const idat=zlib.deflateSync(raw,{level:9});
  const tab=(()=>{const t=[];for(let n=0;n<256;n++){let c2=n;for(let k=0;k<8;k++)c2=c2&1?0xedb88320^(c2>>>1):c2>>>1;t[n]=c2>>>0;}return t;})();
  const crc=b=>{let c2=0xffffffff;for(const x of b)c2=tab[(c2^x)&0xff]^(c2>>>8);return(c2^0xffffffff)>>>0;};
  const chunk=(type,data)=>{const len=Buffer.alloc(4);len.writeUInt32BE(data.length,0);const td=Buffer.concat([Buffer.from(type),data]);const cc=Buffer.alloc(4);cc.writeUInt32BE(crc(td),0);return Buffer.concat([len,td,cc]);};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',idat),chunk('IEND',Buffer.alloc(0))]);
}
fs.writeFileSync(OUT, png(OW,OH,Buffer.from(out)));
console.log('wrote', OUT, OW+'x'+OH, 'voxels:', V.length);
