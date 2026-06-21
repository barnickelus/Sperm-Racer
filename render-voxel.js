/* CPU software voxel renderer -> PNG.  No browser, no GPU, no WebGL.
 * Isometric projection, per-face flat shading, painter's algorithm, 2x
 * supersampled then box-downsampled.  Lets me SEE the voxel look directly. */
const zlib=require('zlib'), fs=require('fs');
const {buildVoxels}=require('./voxel-model.js');

const SS=2;                 // supersample factor
const c=11*SS;             // voxel pixel size
const margin=18*SS;
const BG_TOP=[8,42,54], BG_BOT=[3,18,26];

// isometric: +Z -> right+down (the bright face, toward viewer), +X -> left+down, +Y -> up
const P=(x,y,z)=>[ (z - x)*c, (x + z)*0.5*c - y*c ];

const V=buildVoxels();

// --- bounds over every voxel corner ---
let minX=1e9,maxX=-1e9,minY=1e9,maxY=-1e9;
for(const v of V) for(const [dx,dy,dz] of [[0,0,0],[1,0,0],[0,1,0],[0,0,1],[1,1,0],[1,0,1],[0,1,1],[1,1,1]]){
  const [px,py]=P(v.x+dx,v.y+dy,v.z+dz);
  if(px<minX)minX=px; if(px>maxX)maxX=px; if(py<minY)minY=py; if(py>maxY)maxY=py;
}
const W=Math.ceil(maxX-minX)+margin*2, H=Math.ceil(maxY-minY)+margin*2;
const ox=margin-minX, oy=margin-minY;

// --- framebuffer with vertical gradient background ---
const buf=new Uint8Array(W*H*3);
for(let y=0;y<H;y++){ const t=y/H;
  const r=BG_TOP[0]+(BG_BOT[0]-BG_TOP[0])*t, g=BG_TOP[1]+(BG_BOT[1]-BG_TOP[1])*t, b=BG_TOP[2]+(BG_BOT[2]-BG_TOP[2])*t;
  for(let x=0;x<W;x++){ const i=(y*W+x)*3; buf[i]=r; buf[i+1]=g; buf[i+2]=b; }
}

function fillQuad(pts, col){
  let bx0=1e9,by0=1e9,bx1=-1e9,by1=-1e9;
  for(const p of pts){ if(p[0]<bx0)bx0=p[0]; if(p[0]>bx1)bx1=p[0]; if(p[1]<by0)by0=p[1]; if(p[1]>by1)by1=p[1]; }
  bx0=Math.max(0,Math.floor(bx0)); by0=Math.max(0,Math.floor(by0));
  bx1=Math.min(W-1,Math.ceil(bx1)); by1=Math.min(H-1,Math.ceil(by1));
  const cr=(a,b,c2)=>(b[0]-a[0])*(c2[1]-a[1])-(b[1]-a[1])*(c2[0]-a[0]);
  for(let y=by0;y<=by1;y++)for(let x=bx0;x<=bx1;x++){
    const pt=[x+0.5,y+0.5];
    let pos=false,neg=false;
    for(let k=0;k<4;k++){ const s=cr(pts[k],pts[(k+1)%4],pt); if(s>0)pos=true; else if(s<0)neg=true; }
    if(pos&&neg) continue;                 // outside convex quad
    const i=(y*W+x)*3; buf[i]=col[0]; buf[i+1]=col[1]; buf[i+2]=col[2];
  }
}

// painter's order: draw far (small x+z-y) first
V.sort((a,b)=>(a.x+a.z-a.y)-(b.x+b.z-b.y));

const shade=(c0,k)=>[Math.min(255,c0[0]*k)|0,Math.min(255,c0[1]*k)|0,Math.min(255,c0[2]*k)|0];
for(const v of V){
  const {x,y,z}=v, col=[v.r,v.g,v.b];
  const o=(X,Y,Z)=>{ const [px,py]=P(x+X,y+Y,z+Z); return [px+ox,py+oy]; };
  // top (+Y) brightest, +Z face (right, toward viewer) mid, +X face (left) darkest
  fillQuad([o(0,1,0),o(1,1,0),o(1,1,1),o(0,1,1)], shade(col,1.0));
  fillQuad([o(0,0,1),o(1,0,1),o(1,1,1),o(0,1,1)], shade(col,0.82));
  fillQuad([o(1,0,0),o(1,1,0),o(1,1,1),o(1,0,1)], shade(col,0.58));
}

// --- box downsample SS x SS ---
const OW=W/SS|0, OH=H/SS|0, out=new Uint8Array(OW*OH*3);
for(let y=0;y<OH;y++)for(let x=0;x<OW;x++){
  let r=0,g=0,b=0;
  for(let sy=0;sy<SS;sy++)for(let sx=0;sx<SS;sx++){ const i=((y*SS+sy)*W+(x*SS+sx))*3; r+=buf[i]; g+=buf[i+1]; b+=buf[i+2]; }
  const n=SS*SS, o=(y*OW+x)*3; out[o]=r/n; out[o+1]=g/n; out[o+2]=b/n;
}

// --- encode PNG (RGB, filter 0 per scanline) ---
function png(w,h,rgb){
  const raw=Buffer.alloc((w*3+1)*h);
  for(let y=0;y<h;y++){ raw[y*(w*3+1)]=0; rgb.copy?0:0;
    for(let x=0;x<w*3;x++) raw[y*(w*3+1)+1+x]=rgb[y*w*3+x]; }
  const idat=zlib.deflateSync(raw,{level:9});
  const crcTable=(()=>{ const t=[]; for(let n=0;n<256;n++){ let c2=n; for(let k=0;k<8;k++) c2=c2&1?0xedb88320^(c2>>>1):c2>>>1; t[n]=c2>>>0; } return t; })();
  const crc=b=>{ let c2=0xffffffff; for(const x of b) c2=crcTable[(c2^x)&0xff]^(c2>>>8); return (c2^0xffffffff)>>>0; };
  const chunk=(type,data)=>{ const len=Buffer.alloc(4); len.writeUInt32BE(data.length,0);
    const td=Buffer.concat([Buffer.from(type),data]); const cc=Buffer.alloc(4); cc.writeUInt32BE(crc(td),0);
    return Buffer.concat([len,td,cc]); };
  const ihdr=Buffer.alloc(13); ihdr.writeUInt32BE(w,0); ihdr.writeUInt32BE(h,4);
  ihdr[8]=8; ihdr[9]=2; ihdr[10]=0; ihdr[11]=0; ihdr[12]=0;   // 8-bit, RGB
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR',ihdr), chunk('IDAT',idat), chunk('IEND',Buffer.alloc(0))]);
}

fs.writeFileSync('voxel-preview.png', png(OW,OH,Buffer.from(out)));
console.log('wrote voxel-preview.png', OW+'x'+OH, 'voxels:', V.length);
