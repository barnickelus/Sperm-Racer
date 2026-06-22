/* Chuck Close-style voxel face -> PNG (CPU only, no GPU).
 * LEFT: frontal "voxel view" — each front voxel drawn as a tile with a small
 * colored shape (circle/square/diamond/triangle) that optically blends.
 * RIGHT: 3/4 isometric view of the relief so the 3D depth reads. */
const zlib=require('zlib'), fs=require('fs');
const {buildFace}=require('./voxel-model.js');
const V=buildFace(1.3);

let minx=1e9,maxx=-1e9,miny=1e9,maxy=-1e9;
for(const v of V){ if(v.x<minx)minx=v.x; if(v.x>maxx)maxx=v.x; if(v.y<miny)miny=v.y; if(v.y>maxy)maxy=v.y; }
const GW=maxx-minx+1, GH=maxy-miny+1;
const front={};
for(const v of V){ if(v.z===0) front[(v.x-minx)+','+(v.y-miny)]=[v.r,v.g,v.b]; }

const clamp=v=>v<0?0:v>255?255:v;
const hash=(x,y)=>{ let h=(x*73856093)^(y*19349663); return h>>>0; };
function accent(base,h){ const m=h%3;
  if(m===0) return [base[0]*0.42, base[1]*0.42, base[2]*0.42];                       // darker
  if(m===1) return [clamp(base[0]*0.4+165), clamp(base[1]*0.4+165), clamp(base[2]*0.4+165)]; // lighter
  return [base[2], base[0], base[1]];                                                // channel-rotate pop
}
function shapeHit(t,u,v){ const du=u-0.5, dv=v-0.5;
  if(t===0) return Math.hypot(du,dv)<0.30;
  if(t===1) return Math.max(Math.abs(du),Math.abs(dv))<0.27;
  if(t===2) return Math.abs(du)+Math.abs(dv)<0.33;
  return v>0.30 && v<0.76 && Math.abs(du)<(0.76-v)*0.75;
}

/* ---------- LEFT: frontal tile view ---------- */
const TS=16, pad=22;
const FW=GW*TS+pad*2, FH=GH*TS+pad*2;
const fb=new Uint8Array(FW*FH*3);
for(let i=0;i<FW*FH;i++){ fb[i*3]=198; fb[i*3+1]=198; fb[i*3+2]=200; }   // light-gray studio bg
for(let gy=0;gy<GH;gy++)for(let gx=0;gx<GW;gx++){
  const base=front[gx+','+(GH-1-gy)]; if(!base)continue;
  const h=hash(gx,gy), t=h%4, acc=accent(base,h);
  const x0=pad+gx*TS, y0=pad+gy*TS;
  for(let py=0;py<TS;py++)for(let px=0;px<TS;px++){
    const u=(px+0.5)/TS, v=(py+0.5)/TS;
    let col;
    if(u<0.09||u>0.91||v<0.09||v>0.91) col=[base[0]*0.5,base[1]*0.5,base[2]*0.5];   // grout
    else col = shapeHit(t,u,v)?acc:base;
    const X=x0+px,Y=y0+py,i=(Y*FW+X)*3; fb[i]=clamp(col[0]); fb[i+1]=clamp(col[1]); fb[i+2]=clamp(col[2]);
  }
}

/* ---------- RIGHT: 3/4 isometric relief ---------- */
const SS=2, c=5*SS, m2=10*SS;
const P=(x,y,z)=>[ (z-x)*c, (x+z)*0.5*c - y*c ];
let aX=1e9,bX=-1e9,aY=1e9,bY=-1e9;
for(const v of V) for(const[dx,dy,dz] of [[0,0,0],[1,1,1],[1,0,0],[0,0,1],[0,1,0]]){ const[px,py]=P(v.x+dx,v.y+dy,v.z+dz);
  if(px<aX)aX=px; if(px>bX)bX=px; if(py<aY)aY=py; if(py>bY)bY=py; }
const IW=Math.ceil(bX-aX)+m2*2, IH=Math.ceil(bY-aY)+m2*2, iox=m2-aX, ioy=m2-aY;
const ib=new Uint8Array(IW*IH*3);
for(let i=0;i<IW*IH;i++){ ib[i*3]=198; ib[i*3+1]=198; ib[i*3+2]=200; }
V.sort((p,q)=>(p.x+p.z-p.y)-(q.x+q.z-q.y));
const shade=(c0,k)=>[clamp(c0[0]*k),clamp(c0[1]*k),clamp(c0[2]*k)];
function quad(pts,col){ let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
  for(const p of pts){ if(p[0]<x0)x0=p[0]; if(p[0]>x1)x1=p[0]; if(p[1]<y0)y0=p[1]; if(p[1]>y1)y1=p[1]; }
  x0=Math.max(0,x0|0); y0=Math.max(0,y0|0); x1=Math.min(IW-1,Math.ceil(x1)); y1=Math.min(IH-1,Math.ceil(y1));
  const cr=(a,b,p)=>(b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]);
  for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){ const pt=[x+0.5,y+0.5]; let pos=false,neg=false;
    for(let k=0;k<4;k++){ const s=cr(pts[k],pts[(k+1)%4],pt); if(s>0)pos=true; else if(s<0)neg=true; }
    if(pos&&neg)continue; const i=(y*IW+x)*3; ib[i]=col[0]; ib[i+1]=col[1]; ib[i+2]=col[2]; } }
for(const v of V){ const {x,y,z}=v, col=[v.r,v.g,v.b];
  const o=(X,Y,Z)=>{ const[px,py]=P(x+X,y+Y,z+Z); return [px+iox,py+ioy]; };
  quad([o(0,1,0),o(1,1,0),o(1,1,1),o(0,1,1)], shade(col,1.0));
  quad([o(0,0,1),o(1,0,1),o(1,1,1),o(0,1,1)], shade(col,0.82));
  quad([o(1,0,0),o(1,1,0),o(1,1,1),o(1,0,1)], shade(col,0.58));
}
// downsample iso SSxSS
const DW=IW/SS|0, DH=IH/SS|0, idown=new Uint8Array(DW*DH*3);
for(let y=0;y<DH;y++)for(let x=0;x<DW;x++){ let r=0,g=0,b=0;
  for(let sy=0;sy<SS;sy++)for(let sx=0;sx<SS;sx++){ const i=((y*SS+sy)*IW+(x*SS+sx))*3; r+=ib[i]; g+=ib[i+1]; b+=ib[i+2]; }
  const n=SS*SS,o=(y*DW+x)*3; idown[o]=r/n; idown[o+1]=g/n; idown[o+2]=b/n; }

/* ---------- compose side by side ---------- */
const GAP=24, CW=FW+GAP+DW, CH=Math.max(FH,DH);
const out=new Uint8Array(CW*CH*3);
for(let i=0;i<CW*CH;i++){ out[i*3]=198; out[i*3+1]=198; out[i*3+2]=200; }
const blit=(src,sw,sh,ox,oy)=>{ for(let y=0;y<sh;y++)for(let x=0;x<sw;x++){ const s=(y*sw+x)*3,d=((oy+y)*CW+(ox+x))*3; out[d]=src[s];out[d+1]=src[s+1];out[d+2]=src[s+2]; } };
blit(fb,FW,FH,0,((CH-FH)/2|0));
blit(idown,DW,DH,FW+GAP,((CH-DH)/2|0));

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
fs.writeFileSync('voxel-face.png', png(CW,CH,Buffer.from(out)));
console.log('wrote voxel-face.png', CW+'x'+CH, 'front voxels:', Object.keys(front).length, 'total:', V.length);
