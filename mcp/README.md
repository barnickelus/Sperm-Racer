# Sperm-Racer MCP server

Lets Claude **playtest** the game. It can set up a race, start it, drive it,
read the standings, photograph any racer up close, and read the console.

```
Claude ──MCP (stdio)──▶ mcp/server.mjs ──WebSocket──▶ index.html?mcp
                                       └── HTTP: serves this repo to that page
```

## Setup

```
cd mcp
npm install
```

**Claude Code:** the repo's `.mcp.json` registers the server as `sperm-racer`.
Start `claude` from the repo root and approve it when asked.

**Claude Desktop** (or any other MCP client) config:

```json
{ "mcpServers": { "sperm-racer": { "command": "node", "args": ["/absolute/path/to/Sperm-Racer/mcp/server.mjs"] } } }
```

## How driving works

A software-rendered browser draws a few frames a second. Driven in real time,
the race would run in slow motion, and how a run went would depend on the
machine. So `race_start` leaves the race **frozen on the grid**, and
`race_drive` advances it in **fixed 1/60 s steps** through `raceStep()`, the
same function the game's own loop calls. Every result is measured in game
seconds. A full four-lap race takes about 30 seconds of wall time.
While manual, the page also runs on a game-time clock (`SIM.t`), so timed
animation such as an expression held for 2 seconds lasts 2 game seconds, not
2 wall seconds.

Each step is a whole game frame without the drawing: the race, the racers, the
camera and the course's own world (Victoria's posters tearing, Eve's garden
answering the pack), so a drive leaves a course exactly as playing it would.

Your kart is driven through the game's own `keys` set, exactly as a keyboard
drives it. It runs either on **autopilot** (steers for the same look-ahead
point the AI uses, drifts the bends, fires items) or with **held keys**.

## Tools

| Tool | What it does |
|---|---|
| `scene_open` | Launch the game headless and connect to it |
| `scene_pages` / `scene_close` | List connected pages (and the URL for a live tab) / close a headless one |
| `race_options` | Every course, character and difficulty |
| `race_setup` | Course (index or name), character id, difficulty for the next race. `seed` makes the race repeatable — the same scenery, field, AI and effects on a fixed clock — for exact before/after comparisons |
| `race_start` | Start a solo race and wait out the countdown. `manual:true` (default) freezes it for `race_drive` |
| `race_drive` | Drive N game seconds on autopilot or held keys. Returns distance, speeds, off-road and airborne time, laps and splits, spins, boosts, place changes, items, **seconds spent in each expression** (for characters with a face rig), and the standings. `untilFinish:true` drives to the line |
| `race_season` | **Balance and trouble spots from many headless races.** AI rivals don't use character stats, so each character races as you, on the same autopilot, against the same five rivals on the same seeded course. Per character: finishing time against the course median, place, wins. Per course: **hotspots**, where on the lap racers spun, got stuck, hit something solid or ran off the road |
| `race_state` | State, clock, and every racer's place, lap, speed, position, item, off-road and spin status. `music` is the race song's beat clock (bpm, phase in the beat and the bar) when a produced song is playing |
| `race_realtime` | Hand the race back to the page's own clock, or freeze it again |
| `race_camera` | `photo`: orbit one racer (azimuth relative to its heading, elevation, distance, `along` its body). `chase`: the game's camera, settled at once. `free`: from any world point to another, or framing a hazard by index |
| `race_warp` | **Jump the race to any point**: laps on a lap course, a fraction of the way to the egg on a point-to-point one. You go at the back of the field, so the chase camera sees the pack, with laps and checkpoints set as if driven. Eased course state, such as Ophelia's hour, snaps to it. Check a late part of a course without driving there. `jump`/`pad` put you a `lead` short of a jump pad or boost pad, so a shot catches the launch |
| `race_framing` | **Is the racer well shot?** Without returning a picture, it reports how much of the frame the racer fills, how much is hidden behind solid scenery or rivals, its box and centre, whether the edge cuts it, and ok/why. It works from two flat passes, the racer alone and the racer against the scene's depth |
| `race_select` | The character-select screen with a given racer on its 3D stage, plus the stage's build timings |
| `race_studio` | One racer alone on a plain backdrop, lit by the course's lights or a studio rig. It uses render layers, so nothing else in the scene can leak into frame |
| `race_pose` | List a character's expressions, or force one (held for N seconds) |
| `race_sheet` | **The engine draws a character reference sheet** and returns it as one image: an 8-view turnaround, every expression, or your own cells. Use it to compare a model against concept art. `rest:true` draws a fresh build in its rest pose at a fixed heading instead of the live racer, so the same character gives the same pixels every time |
| `race_film` | **A filmstrip:** N frames over game time in one image, so motion can be judged. `still:true` keeps the race frozen while the racers' own animation (smoke, cloth, faces) runs |
| `scene_profile` | **Render cost per racer** (draw calls, triangles, materials, textures), the track and the scene. `trackTop` names the course's heaviest pieces and rolls identical ones together. `inView:true` counts only what the camera draws right now, by the piece it belongs to. `roster:true` builds every character off-screen and returns the whole table, build times included. It also counts **shader programs** per racer, for the track and in all: each is a compile the first time it is seen, a cost that does not depend on how fast the machine is |
| `race_palette` | **Which parts of a racer blend together on screen.** It renders the frame and an ID pass from the same camera (wind lines, glows and sprites sit out, and only the parts actually seen count, not what is behind a rival or smoke), then reports each part's share of the pixels, its real on-screen colour, and the closest pairs by CIE ΔE. Under about 10 reads as the same colour at racing distance. `vision` adds the closest pairs as a colour-blind player sees them (protanopia, deuteranopia, tritanopia) |
| `race_motion` | **How fluidly a racer moves.** It steps the race at 1/60 s and tracks the head, the neck's turn, the tail tip and every swaying part in the racer's own space. Per probe it reports RMS speed, acceleration and jerk, and *snaps*: frames whose jerk is far above that probe's median. Low jerk with few snaps reads as fluid; high jerk reads as popping. For a racer on the flow body it also reports the skin as drawn: the gap at the join, the spine's length against its rest length, and the sharpest bend between two rings. `series:true` adds the per-frame speed and the frames each snap fell on |
| `race_regress` | **Visual regression.** It draws a rest-pose turnaround (or the expressions) in studio light and compares it with that character's golden sheet: the share of pixels changed, a heat map of where, and pass/fail. The first run, or `update:true`, saves the golden. `course` snapshots a **course** instead: a seeded race warped to fixed points of the lap, the course alone (no racers, particles or effects) in the chase camera's frame, against its goldens |
| `scene_page` | The whole page as a player sees it (HUD, menus, overlays), not only the canvas. Headless pages only |
| `race_perf` | **Where the frame time goes.** It runs whole frames at a fixed step (or on the page's own clock) and reports: the frame by segment (sim, racers, camera, minimap, world, particles, render) with p50/p95/p99 and the worst frame; the browser's layout and style work; Chrome's CPU profile (top functions, and game functions with their callees); its allocation profile; and every shader compiled mid-race, with the frame it hit. `draw:false` measures the JavaScript alone |
| `race_record` | **Film a shot at an exact frame rate**, however slow the machine. The game is stepped 1/fps of game time per frame, the camera is placed for each frame (the chase cam, the game's own **first-person** lens, or a photo camera eased from one framing to another), and each frame is saved as a JPEG. `encode:true` adds an MP4. Each frame's telemetry (place, speed, boost, air, spin, slingshots) goes to `<name>.events.json`, and the result lists the shot's **moments**: boosts, take-offs and landings, slingshots, overtakes, spins, the finish, by frame, so an edit can cut on them. `qa:true` checks every frame (subject hidden, out of frame, tiny or cut by the edge; blown out, crushed, sudden flashes) and lists the frame ranges with a problem |
| `race_surface` | **What reads as plastic.** An ID pass by material over one racer, the course or the whole view: each material's share of the pixels and what it is made of (relief, colour map, vertex colours or no texture; roughness, clear coat; lit or unlit). An untextured smooth surface is flagged plastic |
| `race_alias` | **Where the picture will shimmer.** The frame at 1x against the same frame supersampled: the difference is detail finer than a pixel, which crawls in motion. Returns the materials responsible and a heat map |
| `race_hud` | **Can the HUD be read here?** Every visible piece of HUD text, as a WCAG contrast ratio against its glass panel blended over the frame (median and worst tenth), against the 4.5:1 or 3:1 minimum |
| `race_soak` | **Memory soak.** Race the courses round and round, seeded, with a garbage collection between races, and record GPU geometries, textures, shader programs, scene objects and the JS heap. Growth from the second round on is a leak |
| `race_audio` | Record the game's music for N seconds as a .webm, with the engine hum muted, for a soundtrack. `style` (and `bar`) plays any produced song from any bar, and the result gives the first downbeat's time in the file, so cuts land on the bar. **It analyses what it records**: loudness, peak and clipping, loudness range, gaps, the low/high balance, and how tightly the onsets sit on the beat grid. `sfxProbe` fires every sound effect over the music and reports how many dB each sits above it |
| `race_features` | **Where the course's set pieces are**: jump pads, boost pads, item boxes, breakables and hazards, each by course position (laps, or the fraction of the way on a point-to-point), lateral offset and heading, and the course's **outline** seen from above (96 points in a unit box), for drawing it. Plan a shot, or warp to one |
| `race_audit` | **Scenery in the wrong place.** Every piece whose actual vertices reach into the driving corridor (with how far in, and where), and pieces that overlap one another, near-identical twins and clumps of the same thing skipped. Flat decals are ignored, and boost strips and jump wedges are listed apart as the course's own surfaces |
| `race_fx` | Hold a racing effect up on your kart for a look or a film (the slipstream's wind lines), switch Eve's living light off and on for an A/B look, or choose who is built on the flow body (`flowBody`: `false` nobody, `"all"` everybody, to audit) |
| `scene_screenshot` / `scene_stats` / `scene_graph` / `page_logs` | Look, measure (draw calls and triangles per frame), inspect the object tree, read the console |

Try asking Claude: *"Race Tex Calloway on Ophelia at hard difficulty on
autopilot, then hold only the gas for 20 seconds. Where does each run lose
time?"* or *"Which racer's neck snaps the most? Measure the roster with
race_motion."*

## The flow body (the avatar template)

The stock racer is three parts that meet: a ball for a head, a tube stuck into
the back of it and a ball joint for a neck. The flow body (`FLOW KIT` in
index.html) is one swimmer:

- **one skin** from the nose to the tail's tip, so there is no seam where the
  tail leaves the head;
- **one spine** under it. The head turns about the back of the skull and the
  neck bends with it. The tail keeps its rest length through a swim, a turn
  and a lash, so no skin is pulled long or folded;
- **a sprung head**: the game's look and a kit's own nod are requests that are
  eased and sprung, so a glance starts from rest and settles;
- **follow-through** from what the kart does: the tail tracks round a corner,
  streams out in a drift and trails a jump.

Three racers wear it: `Proto` (the template with no costume, the one to look at
when the body changes), `Kasi` and `Chad Brody`. Everyone else is on the stock
body until moved.

Two 8 s runs of the same seeded race on each body, measured by `race_motion`:

| | neck jerk | neck snaps | gap at the join | tail length vs rest |
|---|---|---|---|---|
| Proto, stock body | 1648, 3120 | 80, 72 | two parts | stretches |
| Proto, flow body | 97, 126 | 1, 0 | 0 | 0.9997 to 1.0004 |
| Kasi, stock body | 1640, 2377 | 80, 110 | two parts | stretches |
| Kasi, flow body | 110, 104 | 0, 0 | 0 | 0.9997 to 1.0004 |

**To move a racer onto it**, add its id to `FLOW_IDS`: `{}` for the template's
teardrop neck, `{neck:null}` if its collar was built round the old junction.
Its kit gets the same handles as before (`head`, `tailMesh`, the neck group),
and the head and tail keep the old UVs, so textures still fit. A kit may need
one of these and nothing else:

- it re-seats a part on a ring of the tail every frame: pin it once with
  `flowRide(g, part, z)` (the Viking's bracer does this);
- it paints the skin: `flowPaint(g, f)` writes vertex colours;
- it re-sculpts the head's surface: call `flowSeal(g)` after (clay does);
- it has a body of its own (the dragons, Tex, the bead, voxel and wire
  racers): it is left as it is.

**To check one before moving it**, `race_fx {flowBody:"all"}` builds every
racer on the flow body and `{flowBody:false}` builds none, so the same seeded
race can be measured both ways. `race_motion` reports the skin as drawn
(`skin.seamGap`, `lengthMin`, `lengthMax`, `maxBendDeg`) beside the jerk and
snaps. Fitted that way, 34 of the 48 racers take the body (the other 14 have
bodies of their own): the neck's median jerk falls from 1171 to 98 and its
snaps from 773 to 29 across them, with no gap and the tail within 0.04% of its
length on every one. Rick is the one to leave: his head twirl is a gag for a
ball on a stick, and a neck only bends so far (`FLOW.BEND`).

## Fluid copies

`Guido Tony · Fluid` and `Sid Spitfire · Fluid` are the same racers with a
motion layer on top (`fluidify()` in index.html). The originals are
unchanged. The layer adds:

- a damped spring in the neck, so a glance eases in and settles;
- springs in every swaying part, driven by what the body actually does, with
  their inputs smoothed so a boost or a bump bends them without a jolt;
- a lagged bank into turns, squash and stretch on boosts and landings, and
  breathing at rest;
- a swim that glides between speeds.

Over four races of 6 s each, `race_motion` measures:

| | neck jerk | neck snaps | sway jerk | sway snaps |
|---|---|---|---|---|
| Guido Tony | 5622 | 60 | 22835 | 485 |
| Guido Tony · Fluid | 91 | 2 | 426 | 15 |
| Sid Spitfire | 3778 | 52 | 9092 | 348 |
| Sid Spitfire · Fluid | 80 | 1 | 254 | 3 |

To give another racer the layer, add `['<newId>', '<originalId>']` to
`FLUID_COPIES`, plus a roster entry, and its `SR_BASE` and `SEL_VARIANTS`
entries.

## A live tab

Open `http://localhost:7458/index.html?mcp` while Claude Code runs on the same
machine. You get real GPU timings, and a small `● MCP :7458` badge appears. The
tools then drive your tab instead of a headless one.

## Safety

- The server binds to `127.0.0.1` only.
- The WebSocket only accepts pages served from localhost. Add more origins
  with `SPERM_RACER_MCP_ORIGINS`.
- The page never dials the bridge without `?mcp`, so the deployed game is
  untouched.
- There is no `eval` tool. An agent gets the verbs the page exposes.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `SPERM_RACER_MCP_PORT` | `7458` | HTTP and WebSocket port. If it's busy, the next 9 ports are tried. `0` picks any free port. Tesserae-Engine's server uses 7457, so both can run at once |
| `SPERM_RACER_MCP_ORIGINS` | none | Extra page origins allowed on the bridge |
| `CHROMIUM_PATH` | auto | Browser for `scene_open`. Otherwise Playwright's own browser, then your installed Chrome |
| `SPERM_RACER_MCP_IMAGE_MAX` | `800` | Width of the pictures tools return (0 = full size). Pictures cost the agent that looks at them in proportion to their pixels, so tools return a working size; files on disk keep full size. Most image tools also take `maxWidth` |
| `SPERM_RACER_MCP_BASELINES` | `mcp/baselines` | Where `race_regress` keeps golden sheets. They are per machine (a GPU and a software renderer draw differently), so the folder is git-ignored |

## Test

```
npm test          # SHOTS=some/dir npm test  keeps the screenshots
```

The test covers 27 checks over stdio. Among them: the real-time loop still
running the race, a page without `?mcp` staying inert, Rusty Malone's
expression rig, studio and sheets, Guido's Fluid copy measuring smoother
than Guido, and a rest-pose sheet coming out pixel-identical between runs.

The page-side bridge, `bridge.js`, is the same file as Tesserae-Engine's
`examples/lib/mcp-bridge.js`. Keep the two in step.
