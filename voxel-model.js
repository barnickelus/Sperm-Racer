/* Shared voxel model for Sperm Racer previews.
 * Shapes are defined in continuous space and voxelized on an integer grid, so
 * `res` is a smoothness knob (higher = more, smaller voxels = crisper curves).
 * Consumed by the Node software renderer (render-voxel.js -> PNG) and the WebGL
 * preview page (voxel-preview.html) — one source of truth.
 * Voxels tagged {env:true} are scenery (ground/scenery) so the preview can
 * frame + pivot on the character alone. */
(function(root, factory){
  if(typeof module!=='undefined' && module.exports) module.exports=factory();
  else root.VoxelModel=factory();
})(typeof self!=='undefined'?self:this, function(){

  // "Salty the Sailor" sperm racer + a small slice of track.
  function buildVoxels(res){
    const R = res || 2.2;                 // resolution scale
    const V=[];
    const push=(x,y,z,c,env)=>V.push({x,y,z,r:c[0],g:c[1],b:c[2],env:!!env});
    const seen=new Set();
    const put=(x,y,z,c,env)=>{ const k=x+','+y+','+z; if(seen.has(k))return; seen.add(k); push(x,y,z,c,env); };

    // voxelize a (possibly clipped) ellipsoid
    const ellip=(cx,cy,cz,rx,ry,rz,c,env,yMin)=>{
      for(let x=Math.floor(cx-rx);x<=Math.ceil(cx+rx);x++)
      for(let y=Math.floor(cy-ry);y<=Math.ceil(cy+ry);y++)
      for(let z=Math.floor(cz-rz);z<=Math.ceil(cz+rz);z++){
        if(yMin!=null && y<yMin) continue;
        const dx=(x-cx)/rx, dy=(y-cy)/ry, dz=(z-cz)/rz;
        if(dx*dx+dy*dy+dz*dz<=1) put(x,y,z,c,env);
      }
    };
    // voxelize a vertical ring (annulus extruded in y) — for the cap band
    const ring=(cx,cz,r0,r1,y0,y1,c,env)=>{
      for(let x=Math.floor(cx-r1);x<=Math.ceil(cx+r1);x++)
      for(let z=Math.floor(cz-r1);z<=Math.ceil(cz+r1);z++){
        const d=Math.hypot(x-cx,z-cz); if(d<r0||d>r1) continue;
        for(let y=Math.round(y0);y<=Math.round(y1);y++) put(x,y,z,c,env);
      }
    };
    // voxelize a box
    const box=(x0,x1,y0,y1,z0,z1,c,env)=>{
      for(let x=Math.round(x0);x<=Math.round(x1);x++)
      for(let y=Math.round(y0);y<=Math.round(y1);y++)
      for(let z=Math.round(z0);z<=Math.round(z1);z++) put(x,y,z,c,env);
    };

    const skin=[243,201,207], white=[244,244,244], navy=[27,55,102],
          dark=[44,30,32], gold=[255,210,74], track1=[233,152,180], track2=[214,126,160],
          blob=[224,84,150];

    // --- ground: checkered pink track slab (env) ---
    const gt=Math.max(1,Math.round(R*0.8));            // slab thickness
    for(let x=Math.round(-11*R);x<=Math.round(11*R);x++)
    for(let z=Math.round(-16*R);z<=Math.round(9*R);z++){
      const c=(((x+z)>>1)&1)?track1:track2;            // chunkier checker at high res
      for(let y=0;y<gt;y++) put(x,y,z,c,true);
    }
    // boost chevron stripe
    box(-5*R,5*R, gt,gt, -2*R,1*R, [255,168,70], true);

    // --- head: forward-stretched ellipsoid ---
    const cy=11*R;
    // anchor tattoo snapped to the left cheek surface (pushed BEFORE the head so it
    // occupies the surface voxels; the head then fills in around it)
    {
      const ink=[36,58,110], rx=6*R, ry=5*R, rz=7*R;
      const A=[[0,0],[0,1],[0,2],[0,-1],[0,-2],[-1,1],[1,1],[-1,2],[1,2],[-2,-2],[-1,-3],[1,-3],[2,-2]];
      for(const [dz,dy] of A){
        const yy=cy+Math.round(dy*0.95*R), zz=Math.round(2.0*R)+Math.round(dz*0.95*R);
        const rem=1-((yy-cy)/ry)*((yy-cy)/ry)-(zz/rz)*(zz/rz);
        if(rem<=0) continue;
        put(-Math.floor(rx*Math.sqrt(rem)), yy, zz, ink);   // leftmost (surface) voxel
      }
    }
    ellip(0,cy,0, 6*R,5*R,7*R, skin);

    // --- big cartoon eyes + pupils + sparkle (sit on the exposed front face) ---
    ellip(-3*R,cy+1.4*R,6.1*R, 2*R,2.3*R,1.6*R, white);
    ellip( 3*R,cy+1.4*R,6.1*R, 2*R,2.3*R,1.6*R, white);
    ellip(-3*R,cy+1.2*R,7.4*R, 1*R,1.4*R,1*R, dark);
    ellip( 3*R,cy+1.2*R,7.4*R, 1*R,1.4*R,1*R, dark);
    ellip(-2.2*R,cy+2.4*R,7.5*R, 0.6*R,0.6*R,0.5*R, white);  // catch-light
    ellip( 3.8*R,cy+2.4*R,7.5*R, 0.6*R,0.6*R,0.5*R, white);
    // mouth
    ellip(0,cy-2.4*R,6.8*R, 2.4*R,0.8*R,0.9*R, dark);

    // --- sailor cap: smaller white dome (sits on top, leaves the face open) ---
    ellip(0,cy+5.2*R,-0.4*R, 4.9*R,3.0*R,4.9*R, white, false, Math.round(cy+4.0*R));
    ring(0,-0.4*R, 4.3*R,5.1*R, cy+3.4*R, cy+4.0*R, navy, false);
    ellip(0,cy+3.8*R,4.9*R, 0.7*R,0.7*R,0.6*R, gold);        // badge ring
    box(-0.4*R,0.4*R, cy+4.4*R,cy+4.8*R, 4.6*R,5.0*R, gold); // badge bar

    // --- wiggling tapered tail trailing back, tattooed with navy/white sailor stripes ---
    const N=Math.round(44*R);
    for(let i=0;i<=N;i++){ const t=i/N;
      const z=-7*R - t*22*R, x=Math.sin(t*7)*2.4*R, rad=(3*R)*(1-t)*0.9+0.5;
      const stripe = (Math.floor(t*11)%2)===0;        // banded blue/white stripes
      ellip(x,cy,z, rad,rad,rad, stripe ? navy : white);
    }

    // --- a few magenta scenery cell-blobs (env) ---
    ellip(-9*R,3*R,-6*R, 3*R,3*R,3*R, blob, true);
    ellip( 10*R,4*R,4*R, 3*R,3*R,3*R, blob, true);
    ellip( 8*R,2.5*R,-12*R, 2*R,2*R,2*R, blob, true);

    return V;
  }

  // ---------------------------------------------------------------------------
  // CHUCK CLOSE-style voxel face: a frontal relief portrait (bald man + glasses)
  // built on a grid. Each column is extruded back in -z; the front (z=0) layer
  // carries the portrait color. Renderers add a small shape per voxel face so
  // the colored tiles optically blend into a face from a distance.
  // ---------------------------------------------------------------------------
  function buildFace(res){
    const R = res || 1.2;
    const V=[];
    const push=(x,y,z,c)=>V.push({x,y,z,r:c[0]|0,g:c[1]|0,b:c[2]|0,face:true});
    const HW=Math.round(15*R), TOP=Math.round(38*R), CY=Math.round(21*R), SX=15*R, SY=18*R;
    const nz=(x,y)=>{ const n=Math.sin(x*12.9898+y*78.233)*43758.5453; return (n-Math.floor(n))-0.5; };
    const mix=(a,b,t)=>[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t];
    const tone=(c,d)=>[c[0]+d,c[1]+d,c[2]+d];
    const SKIN=[223,168,134], WARM=[205,134,107], HI=[241,206,171], SH=[150,104,84],
          BEARD=[168,158,156], DARK=[34,30,33], LIP=[171,99,93], SHIRT=[46,48,62],
          FRAME=[24,21,26], LENS=[122,140,160];

    for(let iy=0; iy<=TOP; iy++){
      for(let ix=-HW; ix<=HW; ix++){
        const nx=ix/SX, ny=(iy-CY)/SY;                 // ny>0 = up
        const headR=(nx*nx)/(0.95*0.95)+(ny*ny)/(1.12*1.12);
        const inHead = headR<=1;
        const inNeck = (ny<-0.80) && Math.abs(nx) < 0.34;
        const inShoulder = (ny<-0.96) && Math.abs(nx) < 0.98;
        if(!inHead && !inNeck && !inShoulder) continue;

        // relief depth
        let depth;
        if(inHead){
          depth = 2 + 6*Math.sqrt(Math.max(0,1-headR));
          if(ny>-0.36 && ny<0.18 && Math.abs(nx)<0.16) depth += 2.6*(1-Math.abs(nx)/0.16); // nose
          if(ny>0.14 && ny<0.30 && Math.abs(nx)<0.5) depth += 1.0;                          // brow
          for(const ex of [-0.38,0.38]) if(Math.hypot(nx-ex,ny-0.05)<0.22) depth -= 1.0;    // sockets
        } else depth = inShoulder?4:3;
        depth = Math.max(1, Math.round(depth*R*0.7));

        // portrait color at the front
        let col;
        if(inShoulder || inNeck){ col = tone(SHIRT, nz(ix,iy)*14); }
        else {
          const t=(ny+1)/2;
          col = mix(WARM, HI, Math.max(0,Math.min(1,t*0.85+0.12)));
          for(const cx of [-0.5,0.5]){ const d=Math.hypot(nx-cx,ny+0.05); if(d<0.3) col=mix(col,WARM,(0.3-d)/0.3*0.45); }
          col = mix(col, SH, Math.max(0,headR-0.45)*0.7);
          if(ny>0.55) col=mix(col,HI,(ny-0.55)/0.45*0.5);                 // bald crown highlight
          if(ny<-0.10 && headR<0.95) col=mix(col,BEARD,Math.min(1,(-0.10-ny)/0.5)*0.5); // stubble
          if(ny>-0.62 && ny<-0.18 && Math.abs(nx)<0.30) col=mix(col,tone(BEARD,-46),0.5); // goatee
          for(const ex of [-0.38,0.38]){ const d=Math.hypot((nx-ex)/1.12, ny-0.05);
            if(d<0.13) col=LENS; else if(d<0.205) col=FRAME; }                // lenses + frames
          if(Math.abs(nx)<0.17 && Math.abs(ny-0.06)<0.045) col=FRAME;        // bridge
          if(ny<0.10&&ny>-0.02 && Math.abs(nx)>0.55&&Math.abs(nx)<0.93) col=FRAME; // temple arms
          for(const ex of [-0.38,0.38]) if(Math.abs(nx-ex)<0.17 && Math.abs(ny-0.27)<0.05) col=mix(col,DARK,0.45); // brows
          for(const ex of [-0.09,0.09]) if(Math.hypot(nx-ex,ny+0.33)<0.05) col=mix(col,SH,0.7); // nostrils
          if(Math.abs(ny+0.5)<0.055 && Math.abs(nx)<0.22) col=LIP;          // lips
          col = tone(col, nz(ix*1.7,iy*1.3)*22);                            // optical-blend speckle
        }
        for(let dz=0; dz<depth; dz++) push(ix, iy, -dz, col);
      }
    }
    return V;
  }

  // ---------------------------------------------------------------------------
  // Golden warrior-goddess: a standing voxel figure (sunburst crown, gold armor,
  // fringed skirt). Last-write-wins layering so armor/details sit over the skin.
  // ---------------------------------------------------------------------------
  function buildGoddess(res){
    const R = res || 1.3, s=n=>n*R;
    const M=new Map();
    const put=(x,y,z,c)=>{ M.set((Math.round(x))+'|'+(Math.round(y))+'|'+(Math.round(z)), c); };
    const e=(cx,cy,cz,rx,ry,rz,c)=>{ for(let x=Math.floor(cx-rx);x<=Math.ceil(cx+rx);x++)for(let y=Math.floor(cy-ry);y<=Math.ceil(cy+ry);y++)for(let z=Math.floor(cz-rz);z<=Math.ceil(cz+rz);z++){ const a=(x-cx)/rx,b=(y-cy)/ry,d=(z-cz)/rz; if(a*a+b*b+d*d<=1) put(x,y,z,c); } };
    const bx=(x0,x1,y0,y1,z0,z1,c)=>{ for(let x=Math.round(x0);x<=Math.round(x1);x++)for(let y=Math.round(y0);y<=Math.round(y1);y++)for(let z=Math.round(z0);z<=Math.round(z1);z++) put(x,y,z,c); };

    const skin=[224,172,142], gold=[212,166,54], goldHi=[244,210,120], goldDk=[150,112,30],
          hair=[58,40,26], dark=[28,26,30], lip=[170,96,92];

    // ===== SKIN (built first; armor/details overwrite) =====
    for(const sx of [-1,1]){
      e(s(sx*2.6), s(13), 0, s(2.3), s(6), s(2.4), skin);   // thigh
      e(s(sx*2.6), s(4),  0, s(1.9), s(5), s(2.0), skin);   // shin
      e(s(sx*6.2), s(33), 0, s(1.7), s(4.6), s(1.7), skin); // upper arm
      e(s(sx*6.7), s(25), 0, s(1.5), s(4.6), s(1.5), skin); // forearm
      e(s(sx*6.9), s(20), 0, s(1.5), s(1.8), s(1.4), skin); // hand
    }
    e(0, s(20), 0, s(5.2), s(3), s(3), skin);               // hips
    e(0, s(26), 0, s(3.4), s(3), s(2.6), skin);             // waist
    e(0, s(33), 0, s(4.4), s(4), s(2.8), skin);             // chest
    e(0, s(41), 0, s(1.8), s(1.9), s(1.8), skin);           // neck
    e(0, s(45.5), 0, s(3.0), s(3.6), s(3.0), skin);         // head

    // ===== HAIR (behind/around the head) =====
    e(0, s(46.5), s(-1.2), s(3.4), s(3.5), s(3.2), hair);
    e(0, s(45.5), s(1.2), s(2.9), s(3.3), s(2.2), skin);    // re-expose the face

    // ===== GOLD ARMOR =====
    for(const sx of [-1,1]) bx(s(sx*2.6-1.6), s(sx*2.6+1.6), 0, s(1.2), s(-0.5), s(4.5), gold); // sandals
    e(s(2.6), s(4), s(1.2), s(2.0), s(4.5), s(1.2), gold);  // right shin guard (front)
    for(const sx of [-1,1]) e(s(sx*2.6), s(8.5), s(1.4), s(1.7), s(1.7), s(1.2), goldHi); // knee guards
    e(0, s(20), s(2.0), s(5.3), s(3.2), s(1.6), gold);      // pelvic plate
    bx(s(-5.4), s(5.4), s(22.5), s(24), s(-3), s(3.2), goldHi); // belt
    e(0, s(26.5), s(1.9), s(3.6), s(3.3), s(1.5), gold);    // waist cuirass
    e(0, s(35.5), s(2.1), s(4.1), s(2.4), s(1.5), gold);    // upper chest plate
    for(const sx of [-1,1]) e(s(sx*1.8), s(33), s(2.6), s(2.1), s(2.1), s(1.6), goldHi); // bust cups
    e(0, s(30), s(3.0), s(0.9), s(2.6), s(0.7), goldDk);    // center filigree
    bx(s(-4.2), s(4.2), s(26), s(37), s(-2.9), s(-2.1), gold); // back plate
    for(const sx of [-1,1]){
      e(s(sx*5.7), s(38.7), 0, s(3.2), s(2.6), s(3.0), gold);     // pauldron
      e(s(sx*5.7), s(39.6), s(0.6), s(2.6), s(1.5), s(2.6), goldHi);
      e(s(sx*6.2), s(33), s(1.2), s(1.8), s(2.6), s(1.0), gold);  // shoulder guard
      e(s(sx*6.7), s(24.5), 0, s(1.7), s(3.6), s(1.7), goldDk);   // vambrace
    }
    e(0, s(41), 0, s(2.0), s(0.9), s(2.0), goldHi);         // choker
    // fringed gold skirt (1-wide strands with gaps)
    for(let i=-6;i<=6;i++){ const fx=s(i*0.95), len=s(13-Math.abs(i)*0.7);
      bx(fx, fx, s(22)-len, s(22), s(2.5), s(3.1), i%2?gold:goldDk); }
    bx(s(-5), s(5), s(11), s(22), s(-3.2), s(-2.6), goldDk); // back of skirt

    // ===== FACE =====
    for(const sx of [-1,1]) e(s(sx*1.1), s(46), s(2.7), s(0.5), s(0.6), s(0.4), dark); // eyes
    e(0, s(43.9), s(2.8), s(0.8), s(0.4), s(0.4), lip);     // lips

    // ===== SUNBURST CROWN =====
    e(0, s(49.6), 0, s(2.6), s(1.4), s(2.6), gold);         // crown band
    const spikes=18;
    for(let i=0;i<spikes;i++){ const a=Math.PI*2*i/spikes, dx=Math.sin(a), dz=Math.cos(a);
      for(let r=0;r<5;r++){ const rr=2.6+r*0.95; put(s(dx*rr), s(50.2+r*0.6), s(dz*rr), r>3?goldHi:gold); } }

    const V=[];
    for(const [k,c] of M){ const p=k.split('|'); V.push({x:+p[0],y:+p[1],z:+p[2],r:c[0]|0,g:c[1]|0,b:c[2]|0}); }
    return V;
  }

  // Drop fully-buried voxels (all 6 face-neighbours present) — they're never seen,
  // so this cuts the count a lot and lets the density go higher for the same cost.
  function surfaceOnly(vox){
    const occ=new Set();
    for(const v of vox) occ.add(v.x+'|'+v.y+'|'+v.z);
    const has=(x,y,z)=>occ.has(x+'|'+y+'|'+z);
    const out=[];
    for(const v of vox){
      if(has(v.x+1,v.y,v.z)&&has(v.x-1,v.y,v.z)&&has(v.x,v.y+1,v.z)&&
         has(v.x,v.y-1,v.z)&&has(v.x,v.y,v.z+1)&&has(v.x,v.y,v.z-1)) continue;
      out.push(v);
    }
    return out;
  }

  return { buildVoxels, buildFace, buildGoddess, surfaceOnly };
});
