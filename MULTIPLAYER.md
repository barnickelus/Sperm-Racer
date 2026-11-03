# Multiplayer

Racing with strangers through **Quick Race** (open rooms, no codes) or with friends through
room codes. No accounts. The game runs from the same static GitHub Pages deploy as the rest;
the relay in `relay/` (a small Cloudflare Worker) carries the packets and keeps the list of
open rooms.

## Quick Race (open rooms)

Tap **Quick Race** on the title screen (or in the lobby). *Finding racers…*, then the lobby
opens in open mode: no code, no Host/Join buttons — your name, the roster, the share-link
button so friends can pile in, and one line: *Open race · 3 racers · starting in 12 s*. The
race starts by itself. Nobody has to press anything, and the button always leads to a race:

- `GET /open` on the relay names a room that is waiting for people. If there is one you join
  it; if there is none you get a fresh code and you are the host — without noticing.
- **Auto-start, run by the host's client:** when a 2nd human arrives a 20 s countdown begins;
  each later arrival cuts the remaining time to at most 8 s; at 6 humans it starts at once; a
  host alone for 25 s starts anyway, against AI. Fill-with-AI is forced on.
- The host keeps the registry fresh (`POST /open/<CODE>` every 5 s with the human count) and
  marks the room `started` at lights-out, so nobody is sent to a race that has begun. If a
  joiner still finds a room racing or empty (its entry outlived its host), it asks `/open` once
  more, then opens a room of its own.
- **Host leaves before the start:** the earliest-joined remaining player — first in the roster
  order everyone has — becomes host, re-registers the room and carries the countdown on. Mid-race
  host loss keeps the local fallback below.
- Quick Race needs the relay transport (the registry lives there), so it uses it whatever the
  Connection button says. An old relay without `/open` answers 404: the game says *Open rooms
  need the updated relay (see relay/README.md)* and hosts a normal coded room instead.

## Playing with codes

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

## Challenge your friends (one link in the chat)

**Invite · Friends** on the home (the chip beside More) or **Challenge · Friends** in the lobby opens
the challenge sheet: a format (*Single race · Best of 3 · Best of 5 · Cup: 5 courses*), the deck's
course and difficulty, *AI racers* on or off (on by default for every format; AI never score), your
best run on the course as a ghost if you have one, your name, **Send**. Send puts the link on the
iOS share sheet (elsewhere it is copied), then opens the room for you, so you are first in.

The link is `index.html?c=CODE.META[.GHOST]` (plus `&net=` / `&relay=` like an invite link):
`CODE` is a fresh room code, `META` a base64url JSON `{v, n, f, t, d, ai, at, g?, s?}` (challenger,
format, course names, difficulty, AI fill, the minute it was made, the ghost's meta, a scorecard),
`GHOST` the packed run (see the GHOSTS block in `index.html`; about 1 KB a minute of racing, 3 KB
for a three-minute race). Only `A-Z a-z 0-9 - _ .` appear, so iMessage and WhatsApp never mangle
it. The room is coded and never listed on `/open`: it is the group's own, and the code never changes.

Opening the link joins `CODE`:

- **Someone is there, lobby open** — you are in their lobby. Row 03 shows *Chris's challenge ·
  Best of 3 · Felicity · medium* and the standings; the host's roster and start carry the rules
  (`chal`, `diff`) and the standings (`ser`), so every screen agrees.
- **Nobody there (yet)** — after about six seconds with no roster that lists you, *you* host that
  same code with the challenge's rules applied (course, difficulty, AI fill), and the lobby says
  *Waiting for Chris and friends — share the link again if you like*. Whoever is first in hosts.
  Two people who open the link in the same breath can both host the echo room for a moment: each
  hears the other's roster, and the one with the greater id steps down and says hello again.
- **A race is running** — the host answers your hello with `late` (track, lineup, maze, elapsed
  time, series) and you watch it: a hidden spectator kart (`spectator:true`, never on the wire, never
  scored, skipped by the physics, the ranking and the board) rides the kart you follow, so the
  camera, HUD, minimap and engine simply show that kart; a tap switches to the next human. The
  strip says *Watching · Alex · tap to switch · you're in the next race*; at the finish you see the
  results with everyone and the host's next start has you on the grid.

**Series.** The host keeps `SER`: a race goes to the first *human* across the line; Best of N to
the first with the majority; the Cup runs its five courses in order with Circuit Cup points by
place among the humans (6-4-2-1), most points taking it. After each race the results screen shows
*Best of 3 · Chris 1 – Alex 1 · next race in 12 s*: the host's **Next race →** starts it now, or it
starts by itself; clients wait for the host. Once decided, the card says who won the series and
the host's button becomes **New series**. Newcomers enter the standings with their first race.

**Nobody online? Race the ghost.** When the link carries a ghost and nobody answers, the lobby
also offers *Race Chris's ghost now*: a solo race with the challenger's run beside you. At the
finish, **Reply** makes a new link with the same code and rules, the scorecard so far (name,
course, time per player) and *your* ghost, to send back; opening a reply shows the scorecard and
lets the other side race the newest ghost.

Nothing here needs the relay to know anything: a challenge room is an ordinary echo room.

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

### Start sync

Each peer builds the course when `start` arrives, which takes seconds on a phone. The host
holds its lights until every human has sent `ready` (its build finished), up to 8 s, then
sends `go`; a peer that hears `go` before it is built starts the moment it is. So the grid
leaves together, and a slow phone no longer hands the host's AI a head start. A client that
never hears `go` (host gone, packet lost) starts on its own 12 s after it was ready.

### If the host disappears

A clean exit is announced immediately (`bye`); a crash or a dead connection is caught by a
15-second liveness timeout. In an open lobby the next player in roster order simply becomes
host (above). Mid-race, either way the clients show **Host left — racing locally**, take
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
| `hello` | anyone → all | `id,name,typeId` | I am here (and the answer to a newcomer; again on a rename) |
| `roster` | host → all | `players[],fillAI,track,host` + `open,openT` (open room: seconds to the start) + `on` (race running) | the lobby, the source of truth; once a second in an open lobby |
| `pick` | anyone → all | `id,typeId` | I changed my racer |
| `start` | host → all | `track,fillAI,lineup[{id,typeId,name,k,ai?}],host` | lights out; also the rematch |
| `ready` | client → host | — | my course is built |
| `go` | host → all | — | the lights: start now, or as soon as you are built |
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
| `late` | host → one | `to,track,maze,fillAI,lineup,host,elapsed,chal,diff,ser` | your hello landed mid-race: watch this one (a spectator kart, see *Challenge your friends*) |
| `ser` | host → all | `ser` | a challenge series' standings after a race (also carried in `roster` and `start` as `ser`, with the challenge's `chal` and `diff`) |

Cost: a snapshot is ~190 bytes. With six karts the host sends its own `s` plus an `S` with
four or five entries, about 12 KB/s out at 15 Hz; a client sends about 2.5 KB/s. The host's
extra CPU is the four AI karts it was already simulating in single player, plus JSON encode
of ~1 KB per tick — not measurable against the renderer.

## Transports

Selected with `?net=local|peer|relay`, or the **Connection** button in the lobby. The invite
link carries the host's choice (`&net=`, and `&relay=` for a non-default relay URL).

| id | what it is | use |
|----|-----------|-----|
| `relay` *(default)* | WebSocket to the deployed worker | real online play, and the only transport Quick Race can use |
| `peer` | WebRTC via a free public broker | the serverless fallback (`?net=peer`) |
| `local` | `BroadcastChannel` | two tabs on one machine — testing (`?net=local`); the open-room tests run `relay` against the Node stand-in instead, because open rooms need a server |

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

`relay/` holds the Cloudflare Worker that implements the contract — whatever JSON text a
client sends to `/room/<CODE>` is echoed to every **other** client in that room; a room exists
only while someone is connected — and the open-room registry (`GET /open`, `POST /open/<CODE>`,
documented in `relay/README.md`), plus `wrangler.toml` and the deploy commands. It is deployed
at `race-wars-relay.cjbarnickel.workers.dev` (`NET_RELAY_DEFAULT`); after a change to
`worker.js`, `wrangler deploy` from `relay/` again.

For a local run, `wrangler dev` (or the test's own `scratchpad/mp_relay_srv.js`, which serves
`/open` too) plus `?net=relay&relay=ws://localhost:8787/room`; the game derives the registry's
`http://…/open` from that URL. Tests: `scratchpad/mp_two.js` (the coded path),
`scratchpad/mpo_open.js` (open rooms: pooling, the alone timer, host handover, the 404 fallback).

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

- **No host migration mid-race.** Host handover happens only in an open lobby; once the race
  is on, a lost host means everyone finishes locally and the next race needs a new room.
- **No reconnect.** A client that drops is handed to the AI; it cannot rejoin the running race.
- **Open rooms trust the host's client** for the countdown and the registry, like everything
  else. A seventh human can still arrive through a share link in the last moment before the
  start; the registry stops sending strangers at six.
- **Two strangers who tap within the same second** can each be given a fresh code and host
  separate rooms; the next arrivals pool onto the fuller one, and a lone host races AI after 25 s.
- **No lag compensation on hits.** The host judges a hit against the victim's last snapshot
  (up to one packet plus one way of latency old). On a 100 ms link a projectile can miss a
  kart you saw it touch, or clip one that had just moved. Your own shield is honoured on your
  side even if the host had not seen it yet.
- **Start offset, bounded.** The host waits up to 8 s for the others' builds (start sync
  above); a device slower than that still starts late, with the host's AI already moving.
- **Backgrounded tabs stall.** Browsers pause `requestAnimationFrame` and throttle timers
  in hidden tabs, so a player who switches away freezes until they come back. The liveness
  timeout is deliberately generous (15s) so this does not retire them instantly.
- The rematch keeps the course the host picked before the room was opened.
- Practical ceiling is about six players, which is also the size of the grid.
