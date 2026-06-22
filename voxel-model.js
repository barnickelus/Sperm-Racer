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

    // --- wiggling tapered tail trailing back ---
    const N=Math.round(44*R);
    for(let i=0;i<=N;i++){ const t=i/N;
      const z=-7*R - t*22*R, x=Math.sin(t*7)*2.4*R, rad=(3*R)*(1-t)*0.9+0.5;
      ellip(x,cy,z, rad,rad,rad, skin);
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

  return { buildVoxels, buildFace };
});
