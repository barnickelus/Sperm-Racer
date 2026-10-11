/* Race Wars relay — a Cloudflare Worker + Durable Object.
 *
 * The contract (MULTIPLAYER.md): whatever JSON text a client sends over its WebSocket to
 * /room/<CODE> is echoed, unchanged, to every OTHER client in that room. Nothing is parsed,
 * stored or authenticated: the game's host is the authority, this is only the wire.
 *
 * One Durable Object per room code, using the WebSocket Hibernation API, so an idle room
 * costs nothing and a room with nobody in it simply ceases to exist — there is no state to
 * expire. A reconnecting client just opens /room/<CODE> again.
 */
export default {
  async fetch(req, env){
    const url=new URL(req.url);
    const m=url.pathname.match(/^\/room\/([A-Za-z0-9]{2,12})\/?$/);
    if(!m) return new Response('Race Wars relay. Open a WebSocket to /room/<CODE>.',
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
