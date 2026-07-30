# Multiplayer

Peer-to-peer racing with room codes. No backend, no accounts — it runs from the same
static GitHub Pages deploy as the rest of the game.

## Playing

1. **Multiplayer — race a friend** on the title screen.
2. One player hits **Host a race** and reads out the four-letter code.
3. Everyone else hits **Join with code**.
4. **Choose your racer** picks your character; everyone in the lobby sees the choice.
5. The host decides **Fill empty slots with AI** and starts the race.

Codes avoid `I`, `O`, `0` and `1`, because they get read aloud over voice chat.

## Ownership model

Every peer simulates **its own kart** and broadcasts the result at 15 Hz; everyone else
plays that kart back from snapshots, extrapolating along the last known heading to cover
the gap between packets and easing onto corrections so they read as a slide rather than a
teleport.

There is no authority and no rollback, so it is **trivially cheatable**. That is a
deliberate trade for a friends-and-room-codes game. The transport is a star topology
(clients talk to the host, the host repeats) specifically so an authoritative host can be
dropped in later without rearranging anything.

If a player disappears, their kart is handed to the AI mid-race, or retired, depending on
the host's **Fill empty slots** setting. A clean exit is announced immediately; a crash or
a dead connection is caught by a 15-second liveness timeout.

## Transports

Selected with `?net=local|peer|relay`, or the **Connection** button in the lobby.

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

## Moving to a hosted relay

Set `NET_RELAY_URL` near the top of the multiplayer block and switch the default to
`relay`. Nothing else changes.

The server contract is as thin as it can be — whatever JSON a client sends to
`/room/<CODE>` is echoed to every **other** client in that room. A Cloudflare Durable
Object, a twenty-line `ws` server, or a Fly.io box all satisfy it.

Reasons you would bother:

- The free broker has no uptime guarantee.
- Roughly 10–15% of networks (strict corporate and some mobile NAT) cannot establish a
  direct peer connection without a paid TURN relay. A hosted relay sidesteps NAT entirely.
- Matchmaking, persistent lobbies, leaderboards and anti-cheat all need a server anyway,
  and the star topology is already the right shape for an authoritative one.

## Debugging a connection

The build ships a read-only `window.srNet`. Open the console:

```js
srNet.status   // transport, room, who is connected, how long each peer has been quiet
srNet.race     // every kart: who owns it, whether it is remote, where it is
```

`quietMs` is the one to watch — if it climbs past a few hundred milliseconds the packets
are not arriving, which points at the broker or NAT rather than at the game.

## Known limits

- **Cheatable by design** — see the ownership model above.
- **Items and hazards are local.** Each peer spawns and resolves its own, so pickups are
  not yet agreed between players. Making them host-authoritative is the natural next step
  and is the main reason the topology is a star.
- **Backgrounded tabs stall.** Browsers pause `requestAnimationFrame` and throttle timers
  in hidden tabs, so a player who switches away freezes until they come back. The liveness
  timeout is deliberately generous (15s) so this does not retire them instantly.
- Practical ceiling is about six players, which is also the size of the grid.
