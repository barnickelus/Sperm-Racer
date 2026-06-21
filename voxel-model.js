/* Shared voxel model for Sperm Racer previews.
 * Returns a flat list of {x,y,z,r,g,b} unit cubes — consumed by both the Node
 * software renderer (render-voxel.js -> PNG) and the WebGL preview page
 * (voxel-preview.html). One source of truth so what I render is what you play. */
(function(root, factory){
  if(typeof module!=='undefined' && module.exports) module.exports=factory();
  else root.VoxelModel=factory();
})(typeof self!=='undefined'?self:this, function(){

  // "Salty the Sailor" sperm racer + a small slice of track.
  function buildVoxels(){
    const V=[];
    const push=(x,y,z,c)=>V.push({x,y,z,r:c[0],g:c[1],b:c[2]});
    const ball=(cx,cy,cz,r,c)=>{ for(let x=-r;x<=r;x++)for(let y=-r;y<=r;y++)for(let z=-r;z<=r;z++)
      if(x*x+y*y+z*z<=r*r+0.5) push(cx+x,cy+y,cz+z,c); };

    const skin=[243,201,207], white=[244,244,244], navy=[27,55,102],
          dark=[44,30,32], gold=[255,210,74], track1=[233,152,180], track2=[214,126,160],
          blob=[224,84,150];

    // --- ground: checkered pink track slab ---
    for(let x=-17;x<=17;x++)for(let z=-26;z<=18;z++)
      push(x,0,z, ((x+z)&1)?track1:track2);
    // boost chevron stripe just ahead
    for(let x=-6;x<=6;x++)for(let z=-2;z<=1;z++) push(x,1,z,[255,168,70]);

    // --- head: forward-stretched ellipsoid (matches in-game head scale) ---
    const HX=6,HY=5,HZ=7, cy=11;
    for(let x=-HX;x<=HX;x++)for(let y=-HY;y<=HY;y++)for(let z=-HZ;z<=HZ;z++){
      if((x*x)/(HX*HX)+(y*y)/(HY*HY)+(z*z)/(HZ*HZ)<=1) push(x,cy+y,z,skin);
    }

    // --- big cartoon eyes + pupils ---
    ball(-3,13,6,2,white);  ball(3,13,6,2,white);
    ball(-3,13,8,1,dark);   ball(3,13,8,1,dark);
    push(-2,15,8,white);    push(4,15,8,white);          // catch-light sparkle
    // mouth
    for(let x=-2;x<=2;x++) push(x,9,7,dark);

    // --- sailor cap: white dome + navy band + gold badge ---
    for(let x=-6;x<=6;x++)for(let z=-6;z<=6;z++){
      const d=x*x+z*z;
      if(d<=32){ push(x,16,z,white); if(d<=22) push(x,17,z,white); if(d<=10) push(x,18,z,white); }
      if(d<=40 && d>=22) push(x,15,z,navy);              // band ring
    }
    push(0,16,7,gold); push(0,15,7,gold);                // anchor badge

    // --- wiggling tapered tail trailing back ---
    for(let t=1;t<=22;t++){
      const cz=-7-t, cx=Math.round(Math.sin(t*0.45)*2.4);
      ball(cx,11,cz, Math.max(0,3-Math.floor(t/6)), skin);
    }

    // --- a few magenta scenery cell-blobs at the edges ---
    ball(-14,4,-7,3,blob); ball(15,5,5,3,blob); ball(12,3,-15,2,blob);

    return V;
  }

  return { buildVoxels };
});
