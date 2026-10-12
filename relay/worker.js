/* Race Wars relay — a Cloudflare Worker + two Durable Objects.
 *
 * Rooms (the contract, MULTIPLAYER.md): whatever JSON text a client sends over its WebSocket
 * to /room/<CODE> is echoed, unchanged, to every OTHER client in that room. Nothing is parsed,
 * stored or authenticated: the game's host is the authority, this is only the wire.
 *
 * One Room object per room code, using the WebSocket Hibernation API, so an idle room costs
 * nothing and a room with nobody in it simply ceases to exist — there is no state to expire.
 * A reconnecting client just opens /room/<CODE> again.
 *
 * Open rooms (Quick Race): one Lobby object keeps the list of rooms waiting for strangers.
 *   GET  /open            -> {room, join}  join:true  = that room is open, join it
 *                                          join:false = nothing is open, host this fresh code
 *   POST /open/<CODE>     {humans, started} the host refreshes its entry (every 5 s); `started`,
 *                                          six humans or no humans removes it; 45 s without a
 *                                          POST expires it. Answers {ok:true}.
 * The registry is advisory: the room itself is still only an echo room, and a joiner that finds
 * it empty or already racing asks /open again. openRegistry() below is the whole behaviour and
 * is the same function, line for line, in the Node stand-in (scratchpad/mp_relay_srv.js).
 */
const OPEN_TTL=45000, OPEN_FULL=6, CODE_ALPHABET='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // the game's netRoomCode alphabet: no I/O/0/1
const CORS={'access-control-allow-origin':'*','access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'content-type'};

// open: {CODE:{humans,at}} (mutated); method GET with no code lists, POST with a code refreshes.
// Returns the JSON to answer with, or null for anything else (404).
function openRegistry(open, now, method, code, body){
  for(const c in open) if(now-open[c].at>OPEN_TTL) delete open[c];
  if(method==='POST' && code){
    const humans=Math.max(0,(body&&body.humans)|0);
    if((body&&body.started) || humans>=OPEN_FULL || humans===0) delete open[code]; else open[code]={humans, at:now};
    return {ok:true};
  }
  if(method==='GET' && !code){
    // the fullest room first, so people pool; the oldest of equals, so no room waits forever
    const best=Object.keys(open).sort((a,b)=>open[b].humans-open[a].humans || open[a].at-open[b].at)[0];
    if(best) return {room:best, join:true};
    let c; do{ c=''; for(let i=0;i<4;i++) c+=CODE_ALPHABET[Math.random()*CODE_ALPHABET.length|0]; }while(open[c]);
    return {room:c, join:false};
  }
  return null;
}

export default {
  async fetch(req, env){
    const url=new URL(req.url);
    if(/^\/open(\/|$)/.test(url.pathname)){
      if(req.method==='OPTIONS') return new Response(null, {status:204, headers:CORS});
      return env.LOBBY.get(env.LOBBY.idFromName('open')).fetch(req);   // one registry for the whole relay
    }
    const m=url.pathname.match(/^\/room\/([A-Za-z0-9]{2,12})\/?$/);
    if(!m) return new Response('Race Wars relay. Open a WebSocket to /room/<CODE>; GET /open for a Quick Race room.',
                               {status:url.pathname==='/'?200:404, headers:{'content-type':'text/plain'}});
    if((req.headers.get('Upgrade')||'').toLowerCase()!=='websocket')
      return new Response('expected a WebSocket upgrade', {status:426});
    const id=env.ROOM.idFromName(m[1].toUpperCase());   // codes are read aloud: case must not split a room
    return env.ROOM.get(id).fetch(req);
  }
};

export class Room {
  constructor(ctx, env){ this.ctx=ctx; this.env=env; }
  async fetch(req){
    if(this.ctx.getWebSockets().length>=12) return new Response('room is full', {status:409});
    const pair=new WebSocketPair();
    const [client, server]=Object.values(pair);
    this.ctx.acceptWebSocket(server);             // hibernation-aware: the DO sleeps between packets
    return new Response(null, {status:101, webSocket:client});
  }
  webSocketMessage(ws, msg){
    if(typeof msg!=='string' || msg.length>16384) return;   // JSON text only; a snapshot is ~200 bytes
    for(const o of this.ctx.getWebSockets()) if(o!==ws){ try{ o.send(msg); }catch(e){} }
  }
  webSocketClose(ws, code, reason, wasClean){ try{ ws.close(1000, 'bye'); }catch(e){} }
  webSocketError(ws){ try{ ws.close(1011, 'error'); }catch(e){} }
}

/* The open-room registry: a single SQLite-backed object (the kind the free plan allows) holding
 * one small map in its storage. Requests to one object run one at a time, so a GET never sees a
 * half-written list. Entries expire lazily, on the next request, so there is no alarm to keep. */
export class Lobby {
  constructor(ctx, env){ this.ctx=ctx; }
  async fetch(req){
    const url=new URL(req.url);
    const m=url.pathname.match(/^\/open\/([A-Za-z0-9]{2,12})\/?$/);
    let body=null; if(req.method==='POST'){ try{ body=await req.json(); }catch(e){} }
    const open=(await this.ctx.storage.get('open'))||{};
    const out=openRegistry(open, Date.now(), req.method, m?m[1].toUpperCase():(url.pathname==='/open'?'':'?'), body);
    if(!out) return new Response(JSON.stringify({error:'GET /open or POST /open/<CODE>'}), {status:404, headers:{'content-type':'application/json', ...CORS}});
    await this.ctx.storage.put('open', open);
    return new Response(JSON.stringify(out), {headers:{'content-type':'application/json', 'cache-control':'no-store', ...CORS}});
  }
}
