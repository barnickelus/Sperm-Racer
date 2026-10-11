# Multiplayer

Racing with room codes. No backend and no accounts by default — it runs from the same
static GitHub Pages deploy as the rest of the game — with an optional twenty-line relay
server for networks that cannot do peer-to-peer (see `relay/`).

## Playing

1. **Multiplayer — race a friend** on the title screen.
2. One player hits **Host a race** and either reads out the four-letter code or taps
   **Share invite link** (the iOS share sheet; elsewhere the link is copied). The code
   itself is tappable too: it copies the link.
3. Everyone else hits **Join with code** — or just opens the link, which joins by itself.
4. **Choose your racer** picks your character; everyone in the lobby sees the choice.
5. The host decides **Fill empty slots with AI** and starts the race.
6. After the finish the room stays open: the host's **Rematch** starts the next race for
   everyone (same grid, fresh AI draw, same course); clients see *Waiting for host…* and
   follow automatically. **Main menu** / **Change racer** leave the room.

Codes avoid `I`, `O`, `0` and `1`, because they get read aloud over voice chat.

## Ownership model

**Each human simulates its own kart** and broadcasts a snapshot at 15 Hz; everyone else
plays that kart back, extrapolating along its last heading and turn rate (so a kart mid-corner
follows its arc) to cover the gap between packets. The drawn kart rides that extrapolated
position; when a packet corrects it, the gap between the old prediction and the new one is kept
as a residual that melts over ~100 ms, so a correction reads as a slide rather than a teleport
and the kart never trails the truth by an easing lag at speed. A spinning kart is stepped
through its whirl rather than extrapolated straight. Measured in the two-page test, the host's
AI karts sit about 4 units (mean; 95th percentile under 8) from their position on the client
at the same instant, against ~140 units (and different characters) before the host owned them. There is no rollback: your kart is
never yanked back by the server, which is what a kart racer on a phone wants to feel like.

**The host owns everything else**, so the race is one race on every screen:

| thing | owner | how it reaches the others |
|---|---|---|
| a human's kart (position, heading, speed, lap, finish time) | that human | `s` snapshot, 15 Hz |
| its shield / mega / glue / spin state | that human | flags on the same snapshot |
| the AI karts (and a dropped human's kart, once handed over) | host | `S` batch, 15 Hz, one entry per kart |
| the AI padding of the grid (which five characters) | host | drawn once, sent with `start` |
| item boxes: who got one, when it comes back | host | `box` → `boxst` + `item` |
| the item you receive from a box | host (knows the places for the catch-up luck) | `item` |
| cysts, dams, slicks, spores, signature shots, glue shots, the clap | host | `spawn` → every peer runs the same builder |
| whether any of those hit anyone, and the whip's verdict | host | `hit` to all, applied by the victim's owner |
| when an entity is spent or expires | host | `gone` |

A kart is addressed on the wire by `nk`, its slot in the host's lineup, the same number on
every peer (the local reorder that puts *you* first is only local).

The game code was not forked for this. Each hit site in the existing collision code asks
`netVictim()` first and gets back *settle it here as single player does* (solo, or the host for
a kart it simulates), *the host has told the owner* (do the entity's side, skip the kart's), or
*a client, the host will say*. `useItem` is wrapped: clients send `use` and keep nothing, the
host runs the real `useItem`, and `spawn` feeds the same function a proxy carrying the owner's
pose on every other peer, so the visuals are the ones the game already has. Boost, shield and
mega only change your own kart and never leave your machine except as flags.

Solo play does not touch any of this: every networked branch is gated on `NET.on`, and the
smoke test and racer hash are identical before and after.

### If the host disappears

A clean exit is announced immediately (`bye`); a crash or a dead connection is caught by a
15-second liveness timeout. Either way the clients show **Host left — racing locally**, take
the AI karts back into local simulation, resolve items locally, and the race can be
finished. It stops being the same race on every screen at that point, but nobody is stranded.
The results screen then offers the ordinary *Race again* instead of a rematch. A non-host
player who disappears is handed to the AI (host-simulated from then on) or retired, per the
host's **Fill empty slots** setting.

Cheating is still trivial for whoever hosts, and a client can lie about its own kart. That is
the trade for a friends-and-room-codes game with no server-side simulation.

## Messages

All messages are small JSON objects with a `t` and a `from` (added by `netSend`). On the
star transport (`peer`) clients talk only to the host and the host repeats every packet to
the other clients; on mesh transports (`local`, `relay`) everyone hears everyone.

| `t` | who → whom | payload | purpose |
|---|---|---|---|
| `hello` | anyone → all | `id,name,typeId` | I am here (and the answer to a newcomer) |
| `roster` | host → all | `players[],fillAI,track,host` | the lobby, the source of truth |
| `pick` | anyone → all | `id,typeId` | I changed my racer |
| `start` | host → all | `track,fillAI,lineup[{id,typeId,name,k,ai?}],host` | lights out; also the rematch |
| `s` | each human → all | `k,x,y,z,h,sp,sl,bk,lap,tot,prog,bo,dr,fin,ft,wh` + flags `sh,mg,gl,sn` | my kart |
| `S` | host → all | `a:[snapshot…], pj:[{id,x,z,h}]` | every host-simulated kart, and the projectiles' positions |
| `box` | client → host | `k` | I touched box `k` (hidden locally at once) |
| `boxst` | host → all | `k,live,rs` | box `k` is taken (back in `rs` s) / is back |
| `item` | host → one | `to,item` | your roll (`null`: someone beat you to it) |
| `use` | client → host | `item,x,y,z,h,idx` | I fired this, from here |
| `spawn` | host → all | `id,kind,o,x,y,z,h,idx` | build this entity (owner `o`'s pose); `kind:'clap'` is the burst only |
| `whip` | client → host | `lock` | I threw a whip (at `lock`, if any) |
| `hit` | host → all | `id?,v,fx,sp?,sl?,gl?,px?,pz?,bk?,cd?,by?,pop?` | kart `v` is hit: spin `sp` s, speed ×`sl`, glue `gl` s, push, cooldown; `fx` picks the burst/toast |
| `gone` | host → all | `id` | entity retired (spent or expired) |
| `hb` | anyone → all | — | liveness, once a second |
| `bye` | anyone → all | `id` | leaving (also sent on `pagehide`) |

Cost: a snapshot is ~190 bytes. With six karts the host sends its own `s` plus an `S` with
four or five entries, about 12 KB/s out at 15 Hz; a client sends about 2.5 KB/s. The host's
extra CPU is the four AI karts it was already simulating in single player, plus JSON encode
of ~1 KB per tick — not measurable against the renderer.

## Transports

Selected with `?net=local|peer|relay`, or the **Connection** button in the lobby. The invite
link carries the host's choice (`&net=`, and `&relay=` for a non-default relay URL).

| id | what it is | use |
|----|-----------|-----|
| `peer` *(default)* | WebRTC via a free public broker | real online play |
| `local` | `BroadcastChannel` | two tabs on one machine — testing, and the only transport an automated test can drive |
| `relay` | WebSocket to your own server | the upgrade path, see below |

A transport is any object with this shape:

```js
{ id, label, mesh,
  open(room, isHost, selfId, handlers) -> Promise<bool>,
  send(msg), close() }
```

`mesh:true` means every peer hears every message and nobody repeats (BroadcastChannel,
and a relay that fans out). `mesh:false` is the star: clients talk only to the host and
the host repeats to everyone else.

## The relay

`relay/` holds a Cloudflare Worker + Durable Object that implements the contract — whatever
JSON text a client sends to `/room/<CODE>` is echoed to every **other** client in that room;
a room exists only while someone is connected — plus `wrangler.toml` and a README with the
three deploy commands. Afterwards set `NET_RELAY_DEFAULT` near the top of the multiplayer
block and switch the default transport to `relay`. Nothing else changes.

For a local run, `wrangler dev` (or the test's own `scratchpad/mp_relay_srv.js`) plus
`?net=relay&relay=ws://localhost:8787/room`. `relayTransport` has been exercised end to end
this way (`scratchpad/mp_relay_local.js`).

Reasons you would bother:

- The free broker has no uptime guarantee.
- Roughly 10–15% of networks (strict corporate and some mobile NAT) cannot establish a
  direct peer connection without a paid TURN relay. A hosted relay sidesteps NAT entirely.
- Matchmaking, persistent lobbies, leaderboards and anti-cheat all need a server anyway.

## Debugging a connection

The build ships a read-only `window.srNet`. Open the console:

```js
srNet.status   // transport, room, who is connected, how long each peer has been quiet
srNet.race     // every kart (owner, remote?, key, position, item, status timers), the boxes, the live entities
```

`quietMs` is the one to watch — if it climbs past a few hundred milliseconds the packets
are not arriving, which points at the broker or NAT rather than at the game.

## Known limits

- **No host migration.** If the host leaves, everyone finishes locally; the next race needs
  a new room.
- **No reconnect.** A client that drops is handed to the AI; it cannot rejoin the running race.
- **No lag compensation on hits.** The host judges a hit against the victim's last snapshot
  (up to one packet plus one way of latency old). On a 100 ms link a projectile can miss a
  kart you saw it touch, or clip one that had just moved. Your own shield is honoured on your
  side even if the host had not seen it yet.
- **Start offset.** Each peer builds the course when `start` arrives, so a slow device
  starts its countdown later and the host's AI have a head start on it.
- **Backgrounded tabs stall.** Browsers pause `requestAnimationFrame` and throttle timers
  in hidden tabs, so a player who switches away freezes until they come back. The liveness
  timeout is deliberately generous (15s) so this does not retire them instantly.
- The rematch keeps the course the host picked before the room was opened.
- Practical ceiling is about six players, which is also the size of the grid.
