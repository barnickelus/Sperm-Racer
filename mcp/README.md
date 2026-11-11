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
| `race_state` | State, clock, and every racer's place, lap, speed, position, item, off-road and spin status |
| `race_realtime` | Hand the race back to the page's own clock, or freeze it again |
| `race_camera` | `photo`: orbit one racer (azimuth relative to its heading, elevation, distance, `along` its body). `chase`: the game's camera, settled at once |
| `race_select` | The character-select screen with a given racer on its 3D stage, plus the stage's build timings |
| `race_studio` | One racer alone on a plain backdrop, lit by the course's lights or a studio rig. It uses render layers, so nothing else in the scene can leak into frame |
| `race_pose` | List a character's expressions, or force one (held for N seconds) |
| `race_sheet` | **The engine draws a character reference sheet** and returns it as one image: an 8-view turnaround, every expression, or your own cells. Use it to compare a model against concept art |
| `race_film` | **A filmstrip:** N frames over game time in one image, so motion can be judged. `still:true` keeps the race frozen while the racers' own animation (smoke, cloth, faces) runs |
| `scene_profile` | **Render cost per racer** (draw calls, triangles, materials, textures), the track and the scene. `roster:true` builds every character off-screen and returns the whole table, build times included |
| `race_palette` | **Which parts of a racer blend together on screen.** It renders the frame and an ID pass from the same camera, then reports each part's share of the pixels, its real on-screen colour, and the closest pairs by CIE ΔE. Under about 10 reads as the same colour at racing distance |
| `scene_screenshot` / `scene_stats` / `scene_graph` / `page_logs` | Look, measure (draw calls and triangles per frame), inspect the object tree, read the console |

Try asking Claude: *"Race Tex Calloway on Ophelia at hard difficulty on
autopilot, then hold only the gas for 20 seconds. Where does each run lose
time?"*

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

## Test

```
npm test          # SHOTS=some/dir npm test  keeps the screenshots
```

The test covers 21 checks over stdio, including the real-time loop still
running the race, a page without `?mcp` staying inert, and Rusty Malone's
expression rig, studio and sheets.

The page-side bridge, `bridge.js`, is the same file as Tesserae-Engine's
`examples/lib/mcp-bridge.js`. Keep the two in step.
