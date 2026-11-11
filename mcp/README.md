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
| `race_setup` | Course (index or name), character id, difficulty for the next race |
| `race_start` | Start a solo race and wait out the countdown. `manual:true` (default) freezes it for `race_drive` |
| `race_drive` | Drive N game seconds on autopilot or held keys. Returns distance, speeds, off-road and airborne time, laps and splits, spins, boosts, place changes, items, **seconds spent in each expression** (for characters with a face rig), and the standings. `untilFinish:true` drives to the line |
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
| `scene_profile` | **Render cost per racer** (draw calls, triangles, materials, textures), the track and the scene. `trackTop` names the course's heaviest pieces and rolls identical ones together. `inView:true` counts only what the camera draws right now, by the piece it belongs to. `roster:true` builds every character off-screen and returns the whole table, build times included |
| `race_palette` | **Which parts of a racer blend together on screen.** It renders the frame and an ID pass from the same camera, then reports each part's share of the pixels, its real on-screen colour, and the closest pairs by CIE ΔE. Under about 10 reads as the same colour at racing distance |
| `race_motion` | **How fluidly a racer moves.** It steps the race at 1/60 s and tracks the head, the neck's turn, the tail tip and every swaying part in the racer's own space. Per probe it reports RMS speed, acceleration and jerk, and *snaps*: frames whose jerk is far above that probe's median. Low jerk with few snaps reads as fluid; high jerk reads as popping. `series:true` adds the per-frame speed and the frames each snap fell on |
| `race_regress` | **Visual regression.** It draws a rest-pose turnaround (or the expressions) in studio light and compares it with that character's golden sheet: the share of pixels changed, a heat map of where, and pass/fail. The first run, or `update:true`, saves the golden |
| `scene_page` | The whole page as a player sees it (HUD, menus, overlays), not only the canvas. Headless pages only |
| `race_perf` | **Where the frame time goes.** It runs whole frames at a fixed step (or on the page's own clock) and reports: the frame by segment (sim, racers, camera, minimap, world, particles, render) with p50/p95/p99 and the worst frame; the browser's layout and style work; Chrome's CPU profile (top functions, and game functions with their callees); its allocation profile; and every shader compiled mid-race, with the frame it hit. `draw:false` measures the JavaScript alone |
| `race_record` | **Film a shot at an exact frame rate**, however slow the machine. The game is stepped 1/fps of game time per frame, the camera is placed for each frame (the chase cam, or a photo camera eased from one framing to another), and each frame is saved as a JPEG. `encode:true` adds an MP4. Each frame's telemetry (place, speed, boost, air, spin, slingshots) goes to `<name>.events.json`, and the result lists the shot's **moments**: boosts, take-offs and landings, slingshots, overtakes, spins, the finish, by frame, so an edit can cut on them |
| `race_audio` | Record the game's music for N seconds as a .webm, with the engine hum muted, for a soundtrack. `style` (and `bar`) plays any produced song from any bar, and the result gives the first downbeat's time in the file, so cuts land on the bar |
| `race_features` | **Where the course's set pieces are**: jump pads, boost pads, item boxes, breakables and hazards, each by course position (laps, or the fraction of the way on a point-to-point), lateral offset and heading. Plan a shot, or warp to one |
| `race_audit` | **Scenery in the wrong place.** Every piece whose actual vertices reach into the driving corridor (with how far in, and where), and pieces that overlap one another, near-identical twins skipped. Flat decals are ignored |
| `race_fx` | Hold a racing effect up on your kart for a look or a film (the slipstream's wind lines), or switch Eve's living light off and on for an A/B look |
| `scene_screenshot` / `scene_stats` / `scene_graph` / `page_logs` | Look, measure (draw calls and triangles per frame), inspect the object tree, read the console |

Try asking Claude: *"Race Tex Calloway on Ophelia at hard difficulty on
autopilot, then hold only the gas for 20 seconds. Where does each run lose
time?"* or *"Which racer's neck snaps the most? Measure the roster with
race_motion."*

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
