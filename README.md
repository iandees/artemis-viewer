# Artemis II Trajectory Viewer

A real-time 3D visualization of NASA's Artemis II mission, built with Three.js. Displays Orion's trajectory from Earth to the Moon using two data sources:

1. **JPL Horizons ephemeris** — pre-fetched predicted trajectory for the full ~9-day mission
2. **Live NASA AROW telemetry** — real-time spacecraft position, attitude, and systems data polled from NASA's Google Cloud Storage bucket

In live mode, the viewer dead-reckons Orion's position and attitude between telemetry updates using velocity vectors and angular rates for smooth motion.

## Running

```bash
npm install

# Local development
npm run dev

# Deploy to Cloudflare
npm run deploy
```

The site is deployed at [artemistracker.mapki.com](https://artemistracker.mapki.com).

## Controls

| Input | Action |
|-------|--------|
| Drag | Rotate camera |
| Scroll | Zoom |
| Right-drag | Pan |
| Space | Play/Pause |
| L | Toggle live mode |
| Left/Right arrows | Slower/Faster playback |
| 1/2/3/4 | Focus Earth/Orion/Moon/Free camera |
| U | Toggle imperial/metric units |
| T | Toggle local/UTC time |
| N | Jump to next milestone |
| P | Jump to previous milestone |
| ? | Show keyboard shortcuts |

## Architecture

```
public/                  # Static assets (served by Cloudflare Workers)
  index.html             # UI layout and styles
  js/
    main.js              # Three.js scene, animation loop, HUD, controls
    horizons.js          # Data loading and interpolation
    milestones.js        # Mission milestones, phases, and timeline helpers
  data/
    orion.json           # Orion trajectory (1,279 points, 10-min intervals)
    moon.json            # Moon ephemeris (same cadence)
    sun.json             # Sun ephemeris (same cadence)
    stars.json           # HYG star catalog (mag < 6.5, ~8,900 stars)
  models/
    orion.glb            # Orion spacecraft 3D model (extracted from NASA AROW)
  textures/
    earth.jpg            # Blue Marble day texture
    earth-night.jpg      # City lights night texture
    moon.jpg             # Lunar surface texture
src/
  worker.js              # Cloudflare Worker — proxies NASA AROW telemetry
server.py                # Local dev server (legacy)
fetch_data.py            # One-time script to download Horizons ephemeris
wrangler.toml            # Cloudflare Workers config
```

## Data Sources

### JPL Horizons (predicted trajectory)

Pre-fetched via `fetch_data.py` from the JPL Horizons API:

```
https://ssd.jpl.nasa.gov/api/horizons.api
```

- **Orion spacecraft ID:** `-1024`
- **Moon ID:** `301`
- **Sun ID:** `10`
- **Center:** `500@399` (Earth geocenter)
- **Coordinate frame:** Earth mean equator J2000 (`REF_PLANE=FRAME`)
- **Units:** km (position), km/s (velocity)
- **Coverage:** Apr 2 02:00 TDB through Apr 10 23:54 TDB (post-ICPS separation through mission end)
- **Resolution:** 10-minute intervals (1,279 data points per body)

**Note:** The Horizons ephemeris for Orion (`-1024`) is a pre-launch prediction and may diverge significantly from the actual trajectory. JPL updates the ephemeris with tracking data during the mission.

The API returns a JSON object with a `result` string field containing text-formatted state vectors. Data rows are bracketed by `$$SOE` / `$$EOE` markers. Each row contains: Julian Date, Calendar Date, X, Y, Z, VX, VY, VZ.

### NASA AROW Live Telemetry

The official AROW website (nasa.gov/missions/artemis-ii/arow/) uses a Unity WebGL app that polls two files on Google Cloud Storage:

| Object | Bucket | Description |
|--------|--------|-------------|
| `October/1/October_105_1.txt` | `p-2-cen1` | Orion spacecraft telemetry |
| `Io/2/Io_108_2.txt` | `p-2-cen1` | ICPS (upper stage) telemetry |

**Polling pattern:** Fetch object metadata to get generation number, then fetch content via `?alt=media&generation=<gen>`. Can also fetch directly with `?alt=media`.

**Update frequency:** NASA updates the files roughly every 60 seconds during the mission.

**Data format:** JSON with a `File` header and numbered `Parameter_NNNN` entries:

```json
{
  "File": {
    "Date": "2026/04/01 18:45:08",
    "Activity": "MIS",
    "Type": 4
  },
  "Parameter_2003": {
    "Number": "2003",
    "Length": "8",
    "Status": "Good",
    "Time": "2026:091:23:45:04.722",
    "Type": "2",
    "Value": "9229036.381258"
  }
}
```

**Key fields:**

- `File.Activity`: `"MIS"` = live mission data, `"SIM"` = simulation/test data
- `Parameter_NNNN.Time`: Day-of-year timestamp format `YYYY:DDD:HH:MM:SS.mmm`
- `Parameter_NNNN.Status`: `"Good"` when data is valid

### Telemetry Parameters

**Important:** Position and velocity values are in **feet** and **feet/second**, not meters. The viewer converts to km internally.

| Parameter | Description | Units |
|-----------|-------------|-------|
| 2003, 2004, 2005 | Position (X, Y, Z) | feet, Earth-centered J2000 equatorial |
| 2009, 2010, 2011 | Velocity (VX, VY, VZ) | ft/s |
| 2012, 2013, 2014, 2015 | Attitude quaternion (w, x, y, z) | unitless |
| 2016 | Status flag | hex |
| 2026 | Unknown | — |
| 2038 | Unknown | — |
| 2040, 2041, 2042 | Thruster state | flags |
| 2048–2065 | Solar array wing data (angles, gimbal) | radians (estimated) |
| 2066–2089 | Additional attitude/orientation data | various |
| 2090 | Unknown | — |
| 2091–2098 | Reaction control system | radians (estimated) |
| 2099 | Status flag | hex |
| 2101, 2102, 2103 | Angular rates (roll, pitch, yaw) | deg/s |
| 5002–5009 | Attitude angles (4 sets of 2) | degrees (estimated) |
| 5010–5013 | Timestamps | Unix-like |

Parameters 2048–2065 appear to describe the four solar array wings (SAW1–4), with each wing having multiple values that likely correspond to gimbal angles and deployment state. Parameters 2091–2098 appear to be RCS jet gimbal angles (4 pairs near ±π).

### Mission Timeline (milestones and phases)

Mission milestone times come from two official NASA sources:

- **Past events (Launch through TLI):** Actual times from NASA Artemis II mission blog posts
  - [Launch day updates](https://www.nasa.gov/blogs/missions/2026/04/01/live-artemis-ii-launch-day-updates/)
  - [Flight Day 2 / TLI](https://www.nasa.gov/blogs/missions/2026/04/02/artemis-ii-flight-day-2-orion-completes-tli-burn-crew-begins-journey-to-the-moon/)
- **Future events (OTC-1 through Splashdown):** Planned times from the [NASA Artemis II Press Kit](https://www.nasa.gov/wp-content/uploads/2026/01/artemis-ii-press-kit.pdf), pages 13-15

Mission phase boundaries (LEO, Trans-Lunar Coast, Lunar Flyby, Trans-Earth Coast, Entry & Splashdown) are derived from these milestone times.

### Coordinate Systems

Both the Horizons ephemeris and the AROW telemetry use **Earth-centered J2000 equatorial** coordinates. The Horizons data is explicitly fetched with `REF_PLANE=FRAME`. The viewer uses the same `toScene()` mapping for both sources:

- J2000 X → Scene X
- J2000 Z → Scene Y (up)
- J2000 -Y → Scene Z

The telemetry attitude quaternion is mapped from equatorial to scene coordinates using the same axis swizzle. The Orion 3D model is rotated to align with the body frame convention where -X points along the spacecraft nose.

### 3D Model

The Orion spacecraft model was extracted from the NASA AROW Unity WebGL application:

1. **Unity data bundle** downloaded from `Build/WebBuildMar27.data`
2. **Meshes extracted** using UnityPy: crew module (`UnifiedCMV2`), heat shield (`UnifiedCMV2_Face`), service module (`UnifiedSM.001`), and solar array wings (`BodyComponents.004–007`)
3. **Materials** mapped from Unity material properties (colors from `_Color`, textures from `_MainTex`)
4. **Solar panel texture** (`SM_0710_Solar Panels_BaseColor`) applied via UV mapping
5. **Assembly** using Unity scene hierarchy transforms (CM, SM, SAW parent positions/rotations/scales)
6. **SAW positioning** manually aligned using a custom Three.js positioning tool, since the panels use skinned mesh renderers with bone chains for fold/unfold animation that couldn't be fully extracted

The SAW meshes are rigged with 4-bone chains (for the unfolding animation in AROW) but the skin weights weren't accessible through UnityPy, so the panels are positioned statically in their deployed configuration.

## CORS

The JPL Horizons API and NASA's GCS bucket do not set CORS headers, so direct browser fetches fail. The Cloudflare Worker (`src/worker.js`) proxies the GCS telemetry requests. The Worker fetches both object metadata (for generation tracking) and content, returning combined JSON at `/api/telemetry`.
