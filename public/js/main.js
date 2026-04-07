import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { fetchTrajectoryData, interpolate, LAUNCH_TIME } from './horizons.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { PHASES, MILESTONES, getPhaseColor, isNearMilestone, getPhaseAtMet, getNearestMilestone } from './milestones.js';

// --- Constants ---
// Scale: 1 unit = 1000 km
const SCALE = 1 / 1000;
const EARTH_RADIUS = 6371 * SCALE;
const MOON_RADIUS = 1737 * SCALE;

// --- Reusable temp objects (avoid per-frame allocations) ---
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _origin = new THREE.Vector3(0, 0, 0);
// orion state at max distance
// x: -133683.65588711537
// y: -340739.71055814304
// z: -187913.97695150267
const _system = new THREE.Vector3(-133683/2, -340739/2, -187913/2);
const _up = new THREE.Vector3(0, 1, 0);
const _forward = new THREE.Vector3(1, 0, 0);
let needsRender = true;

// --- Scene setup ---
const canvas = document.getElementById('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 50000);
camera.position.set(0, 300, 400);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 1;
controls.maxDistance = 5000;
controls.addEventListener('start', () => {
  focusTarget = 'free';
  needsRender = true;
  document.querySelectorAll('#focus-btns .btn').forEach(b => b.classList.remove('active'));
  document.getElementById('focus-free').classList.add('active');
});
controls.addEventListener('change', () => { needsRender = true; });

// --- Lighting ---
const ambientLight = new THREE.AmbientLight(0x222244, 0.3);
scene.add(ambientLight);

const sunLight = new THREE.DirectionalLight(0xffffff, 2.0);
sunLight.position.set(500, 200, 300);
scene.add(sunLight);

// --- Starfield (real star positions from HYG catalog) ---
async function createStarfield() {
  const resp = await fetch('data/stars.json');
  const stars = await resp.json(); // [[ra_hours, dec_deg, mag, ci], ...]
  const count = stars.length;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const R = 9000;

  for (let i = 0; i < count; i++) {
    const [raH, decDeg, mag, ci] = stars[i];
    // RA (hours -> radians), Dec (degrees -> radians)
    const ra = raH * (Math.PI / 12);
    const dec = decDeg * (Math.PI / 180);

    // Equatorial to cartesian (J2000)
    const x = R * Math.cos(dec) * Math.cos(ra);
    const y = R * Math.cos(dec) * Math.sin(ra);
    const z = R * Math.sin(dec);

    // Same mapping as toScene: equatorial X->scene X, Z->scene Y, -Y->scene Z
    positions[i * 3]     = x;
    positions[i * 3 + 1] = z;
    positions[i * 3 + 2] = -y;

    // Brightness from magnitude (lower mag = brighter)
    const brightness = Math.pow(10, -0.4 * (mag - (-1.46))) * 0.8; // normalized to Sirius
    const b = Math.min(1.0, Math.max(0.15, brightness));

    // Color from B-V color index: blue stars (ci < 0) -> white -> red stars (ci > 1.5)
    let r2, g, b2;
    if (ci < 0) {
      r2 = 0.7; g = 0.8; b2 = 1.0;
    } else if (ci < 0.4) {
      r2 = 0.9; g = 0.95; b2 = 1.0;
    } else if (ci < 0.8) {
      r2 = 1.0; g = 1.0; b2 = 0.9;
    } else if (ci < 1.2) {
      r2 = 1.0; g = 0.85; b2 = 0.6;
    } else {
      r2 = 1.0; g = 0.7; b2 = 0.4;
    }
    colors[i * 3]     = r2 * b;
    colors[i * 3 + 1] = g * b;
    colors[i * 3 + 2] = b2 * b;

    // Size from magnitude
    sizes[i] = Math.max(0.5, 4.0 - mag * 0.5);
  }

  // Group stars by brightness tier for different point sizes
  const tiers = [
    { maxMag: 1.5, size: 4.0 },
    { maxMag: 3.0, size: 2.5 },
    { maxMag: 4.5, size: 1.5 },
    { maxMag: 6.5, size: 0.8 },
  ];

  for (const tier of tiers) {
    const tierPositions = [];
    const tierColors = [];
    for (let i = 0; i < count; i++) {
      const mag = stars[i][2];
      const prevMax = tiers[tiers.indexOf(tier) - 1]?.maxMag ?? -999;
      if (mag > prevMax && mag <= tier.maxMag) {
        tierPositions.push(positions[i*3], positions[i*3+1], positions[i*3+2]);
        tierColors.push(colors[i*3], colors[i*3+1], colors[i*3+2]);
      }
    }
    if (tierPositions.length === 0) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(tierPositions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(tierColors, 3));
    const mat = new THREE.PointsMaterial({ size: tier.size, vertexColors: true, sizeAttenuation: false });
    scene.add(new THREE.Points(geo, mat));
  }
}

// --- Texture loader ---
const textureLoader = new THREE.TextureLoader();

// --- Earth ---
const earthGeo = new THREE.SphereGeometry(EARTH_RADIUS, 32, 32);
const earthMat = new THREE.MeshPhongMaterial({
  color: 0x2244aa,
  emissive: 0x112244,
  emissiveIntensity: 0.15,
  shininess: 25,
});
textureLoader.load('textures/earth.jpg', (tex) => {
  earthMat.map = tex;
  earthMat.color.set(0xffffff);
  earthMat.needsUpdate = true;
});
textureLoader.load('textures/earth-night.jpg', (tex) => {
  earthMat.emissiveMap = tex;
  earthMat.emissive.set(0xffddaa);
  earthMat.emissiveIntensity = 0.15;
  earthMat.needsUpdate = true;
});
const earthMesh = new THREE.Mesh(earthGeo, earthMat);
scene.add(earthMesh);

// Earth atmosphere glow
const glowGeo = new THREE.SphereGeometry(EARTH_RADIUS * 1.03, 24, 24);
const glowMat = new THREE.MeshBasicMaterial({
  color: 0x4488ff,
  transparent: true,
  opacity: 0.12,
  side: THREE.BackSide,
});
scene.add(new THREE.Mesh(glowGeo, glowMat));

// --- Moon ---
const moonGeo = new THREE.SphereGeometry(MOON_RADIUS, 32, 32);
const moonMat = new THREE.MeshPhongMaterial({
  color: 0x999999,
  emissive: 0x222222,
  emissiveIntensity: 0.1,
  shininess: 5,
});
textureLoader.load('textures/moon.jpg', (tex) => {
  moonMat.map = tex;
  moonMat.color.set(0xffffff);
  moonMat.emissive.set(0x000000);
  moonMat.needsUpdate = true;
});
const moonMesh = new THREE.Mesh(moonGeo, moonMat);
scene.add(moonMesh);

// --- Far-side easter egg ---
const alienGroup = new THREE.Group();
const alienMat = new THREE.MeshPhongMaterial({ color: 0x44ff44, emissive: 0x115511, emissiveIntensity: 0.3 });
// Body
const alienBody = new THREE.Group();
alienBody.add(new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.1, 4, 8), alienMat));
// Waving arm (right side, raised)
const armPivot = new THREE.Group();
armPivot.position.set(0.07, 0.05, 0);
const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.02, 0.1, 4, 6), alienMat);
arm.position.y = 0.06;
armPivot.add(arm);
armPivot.rotation.z = -Math.PI / 3;
alienBody.add(armPivot);
// Left arm (resting)
const leftArm = new THREE.Mesh(new THREE.CapsuleGeometry(0.02, 0.08, 4, 6), alienMat);
leftArm.position.set(-0.08, 0.0, 0);
leftArm.rotation.z = Math.PI / 6;
alienBody.add(leftArm);
alienGroup.add(alienBody);
// Head (separate so it can track Orion)
const alienHead = new THREE.Group();
const headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 8), alienMat);
headMesh.scale.set(1, 1.2, 1);
alienHead.add(headMesh);
const eyeMat = new THREE.MeshPhongMaterial({ color: 0x111111, emissive: 0x000000 });
const leftEye = new THREE.Mesh(new THREE.SphereGeometry(0.02, 6, 6), eyeMat);
leftEye.position.set(-0.03, 0.01, 0.06);
alienHead.add(leftEye);
const rightEye = new THREE.Mesh(new THREE.SphereGeometry(0.02, 6, 6), eyeMat);
rightEye.position.set(0.03, 0.01, 0.06);
alienHead.add(rightEye);
alienHead.position.y = 0.14;
alienGroup.add(alienHead);
// Small light so it's visible in the dark
const alienLight = new THREE.PointLight(0x88ffaa, 0.15, 1.5);
alienLight.position.set(0, 0.3, 0);
alienGroup.add(alienLight);
alienGroup.visible = false;
scene.add(alienGroup);

// --- Orion spacecraft model ---
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
const orionGroup = new THREE.Group();
// Glow ring (visible at distance)
const orionRing = new THREE.Mesh(
  new THREE.RingGeometry(1.2, 1.8, 32),
  new THREE.MeshBasicMaterial({ color: 0x55aaff, transparent: true, opacity: 0.5, side: THREE.DoubleSide })
);
orionGroup.add(orionRing);
// Load GLB model
new GLTFLoader().load('models/orion.glb', (gltf) => {
  const model = gltf.scene;
  model.scale.setScalar(3);
  // Align model with telemetry body frame
  // Model: +Y = CM/nose, -Y = SM, X/Z = solar arrays
  // Orion body frame: +X = SM/sun-facing. Rotate model +Y (nose) → +X
  model.rotation.z = -Math.PI / 2;
  // Reposition SAW panels (manually aligned via panel-tool)
  const sawTransforms = {
    'SAW1': { pos: [0.4950, 0.0461, 0.4289], quat: [0.5530, -0.5435, -0.4338, 0.4589] },
    'SAW2': { pos: [0.4024, -0.0734, -0.5767], quat: [-0.1437, -0.8356, 0.0006, 0.5302] },
    'SAW3': { pos: [-0.7006, -0.0759, -0.0818], quat: [0.0711, -0.8427, 0.1274, 0.5183] },
    'SAW4': { pos: [-0.4286, -0.0726, 0.5506], quat: [-0.1440, 0.8499, -0.0031, -0.5069] },
  };
  model.traverse((child) => {
    if (child.isMesh) {
      child.material = child.material.clone();
      child.material.emissive = new THREE.Color(0x334455);
      child.material.emissiveIntensity = 0.3;
      child.material.side = THREE.DoubleSide;
      child.material.metalness = 0.0;
      child.material.roughness = 0.8;
      const st = sawTransforms[child.name];
      if (st) {
        child.position.set(...st.pos);
        child.quaternion.set(...st.quat);
      }
    }
  });
  orionGroup.add(model);
});
scene.add(orionGroup);

// --- Trajectory line ---
let orionTrailLine;
let orionMilestoneDots = [];
let moonTrailLine;

// --- Labels (CSS-style via sprites) ---
function makeLabel(text, color = '#7eb8ff') {
  const cvs = document.createElement('canvas');
  cvs.width = 256;
  cvs.height = 64;
  const ctx = cvs.getContext('2d');
  ctx.font = 'bold 28px Helvetica Neue, sans-serif';
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.fillText(text, 128, 40);
  const tex = new THREE.CanvasTexture(cvs);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(20, 5, 1);
  return sprite;
}

const earthLabel = makeLabel('Earth', '#5599ff');
earthLabel.position.set(0, EARTH_RADIUS + 8, 0);
scene.add(earthLabel);

const moonLabel = makeLabel('Moon', '#aaaaaa');
scene.add(moonLabel);

const orionLabel = makeLabel('Orion', '#ffaa44');
scene.add(orionLabel);

// --- Sun (placed in correct direction, visual distance) ---
const SUN_VISUAL_DIST = 5000; // units — near starfield, not to scale
const sunSprite = (() => {
  const cvs = document.createElement('canvas');
  cvs.width = 128; cvs.height = 128;
  const ctx = cvs.getContext('2d');
  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255, 255, 220, 1)');
  grad.addColorStop(0.15, 'rgba(255, 230, 140, 0.9)');
  grad.addColorStop(0.4, 'rgba(255, 200, 60, 0.3)');
  grad.addColorStop(1, 'rgba(255, 180, 40, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(cvs);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(300, 300, 1);
  return sprite;
})();
scene.add(sunSprite);

const sunLabel = makeLabel('Sun', '#ffdd66');
scene.add(sunLabel);

// --- State ---
let data = null;
let currentTime = null;
let timeStart = null;
let timeEnd = null;
let playing = false;
let liveMode = false;
let liveTelemetry = null; // latest from NASA AROW
let prevLiveTelemetry = null; // previous sample for interpolation
let liveTelemetryTime = 0; // performance.now() when liveTelemetry was received
let lastTelemetryFetch = -Infinity;
let speedMultiplier = 60; // 1 real second = 60 mission seconds
const speedSteps = [1, 10, 30, 60, 120, 300, 600, 1800, 3600];
let speedIdx = 3;
let useImperial = false; // toggle with 'u' key
let useLocalTime = false; // toggle with 't' key
let focusTarget = 'orion'; // 'earth', 'moon', 'orion', 'free'
let lastRealTime = null;

// --- UI elements ---
const elDataSource = document.getElementById('data-source');
const elDataAge = document.getElementById('data-age');
const elDistEarth = document.getElementById('dist-earth');
const elDistMoon = document.getElementById('dist-moon');
const elVelocity = document.getElementById('velocity');
const elAltitude = document.getElementById('altitude');
const elTimeLabel = document.getElementById('time-label');
const elMetLabel = document.getElementById('met-label');
const elTimeline = document.getElementById('timeline');
const elBtnPlay = document.getElementById('btn-play');
const elSpeedDisplay = document.getElementById('speed-display');
const elLoading = document.getElementById('loading');
const elLoadingStatus = document.getElementById('loading-status');

// --- Live telemetry polling ---
async function pollTelemetry() {
  const now = performance.now();
  if (now - lastTelemetryFetch < 10000) return; // poll every 10s
  lastTelemetryFetch = now;
  try {
    const resp = await fetch('/api/telemetry');
    const telData = await resp.json();
    if (telData.orion && telData.orion.File && telData.orion.File.Activity === 'MIS') {
      const parsed = parseTelemetry(telData.orion);
      if (parsed) {
        // Only update if NASA's data timestamp has actually changed
        const isNew = !liveTelemetry || parsed.date.getTime() !== liveTelemetry.date.getTime();
        if (isNew) {
          prevLiveTelemetry = liveTelemetry;
          liveTelemetry = parsed;
          liveTelemetryTime = performance.now();
        }
      }
    }
  } catch (e) {
    console.warn('Telemetry poll error:', e);
  }
}

function parseTelemetry(raw) {
  const p = (num) => {
    const param = raw[`Parameter_${num}`];
    return param ? parseFloat(param.Value) : null;
  };
  // Positions in feet from Earth center, convert to km
  const FT_TO_KM = 0.0003048;
  const xRaw = p(2003); const yRaw = p(2004); const zRaw = p(2005);
  if (xRaw == null || yRaw == null || zRaw == null) return null;
  const x = xRaw * FT_TO_KM; const y = yRaw * FT_TO_KM; const z = zRaw * FT_TO_KM;
  // Velocities in ft/s, convert to km/s
  const vxRaw = p(2009); const vyRaw = p(2010); const vzRaw = p(2011);
  const vx = vxRaw * FT_TO_KM; const vy = vyRaw * FT_TO_KM; const vz = vzRaw * FT_TO_KM;
  // Attitude quaternion
  const qw = p(2012); const qx = p(2013); const qy = p(2014); const qz = p(2015);
  // Parse timestamp from parameter time field "2026:091:23:45:04.722"
  const timeStr = raw.Parameter_2003?.Time;
  let date = new Date();
  if (timeStr) {
    const m = timeStr.match(/(\d{4}):(\d{3}):(\d{2}):(\d{2}):(\d{2})/);
    if (m) {
      const jan1 = new Date(Date.UTC(+m[1], 0, 1));
      date = new Date(jan1.getTime() + (+m[2] - 1) * 86400000 + +m[3] * 3600000 + +m[4] * 60000 + +m[5] * 1000);
    }
  }
  return {
    date,
    x, y, z,       // km
    vx, vy, vz,   // km/s
    qw, qx, qy, qz,
    // Angular rates (deg/s)
    rateRoll: p(2101), ratePitch: p(2102), rateYaw: p(2103),
    // Thruster state flags
    thr1: p(2040), thr2: p(2041), thr3: p(2042),
    // RCS
    rcs1: p(2091), rcs2: p(2092), rcs3: p(2093), rcs4: p(2094), rcs5: p(2095),
    // Solar array params
    solar2048: p(2048), solar2049: p(2049), solar2050: p(2050),
    solar2051: p(2051), solar2052: p(2052), solar2053: p(2053),
    // Status
    statusFlag: p(2016),
    altitude: p(5001), // km (already in km from telemetry)
    raw,
  };
}

// --- Data loading ---
async function init() {
  try {
    data = await fetchTrajectoryData(status => {
      elLoadingStatus.textContent = status;
    });

    timeStart = data.orion[0].date;
    timeEnd = data.orion[data.orion.length - 1].date;

    // Start in live mode if mission is underway or hasn't started yet
    const now = new Date();
    if (now >= LAUNCH_TIME && now <= timeEnd) {
      setLiveMode(true);
    } else {
      currentTime = new Date(timeStart);
    }

    buildTrajectoryLines();
    buildMilestoneUI();
    createStarfield();
    frameCamera();
    elLoading.style.display = 'none';
    lastRealTime = performance.now();
    if (liveMode) pollTelemetry();
    animate();
  } catch (err) {
    elLoadingStatus.textContent = `Error: ${err.message}`;
    console.error(err);
  }
}

function frameCamera() {
  // Position camera so Orion is in foreground with the nearest body fully visible behind it
  const orionState = interpolate(data.orion, currentTime);
  const moonState = interpolate(data.moon, currentTime);

  const orionPos = toScene(orionState);
  const moonPos = toScene(moonState);
  const earthPos = new THREE.Vector3(0, 0, 0);

  const distEarthKm = Math.sqrt(orionState.x ** 2 + orionState.y ** 2 + orionState.z ** 2);
  const distMoonKm = Math.sqrt(
    (orionState.x - moonState.x) ** 2 +
    (orionState.y - moonState.y) ** 2 +
    (orionState.z - moonState.z) ** 2
  );

  const nearEarth = distEarthKm < distMoonKm;
  const bgBody = nearEarth ? earthPos : moonPos;
  const bodyRadiusScene = nearEarth ? EARTH_RADIUS : MOON_RADIUS;
  const distToBodyScene = (nearEarth ? distEarthKm : distMoonKm) * SCALE;

  // We want the body to fill ~40% of the vertical FOV
  const fovRad = camera.fov * Math.PI / 180;
  const desiredAngularSize = fovRad * 0.4;
  // Distance from body where it subtends that angle: r / tan(angle/2)
  const camDistFromBody = bodyRadiusScene / Math.tan(desiredAngularSize / 2);

  // Direction from body to Orion
  const bodyToOrion = new THREE.Vector3().subVectors(orionPos, bgBody).normalize();

  // Place camera along the body→Orion line, past Orion
  const up = new THREE.Vector3(0, 1, 0);
  const side = new THREE.Vector3().crossVectors(bodyToOrion, up).normalize();
  const camUp = new THREE.Vector3().crossVectors(side, bodyToOrion).normalize();

  // Camera position: along the body-to-Orion axis at the computed distance, offset slightly up and right
  camera.position.copy(bgBody)
    .addScaledVector(bodyToOrion, camDistFromBody)
    .addScaledVector(camUp, camDistFromBody * 0.05)
    .addScaledVector(side, camDistFromBody * 0.03);

  // Look at the body center so it's fully framed
  controls.target.copy(bgBody);
  controls.update();
}

function buildTrajectoryLines() {
  // Orion phase-colored trajectory using Line2
  const positions = [];
  const colors = [];
  for (const p of data.orion) {
    positions.push(p.x * SCALE, p.z * SCALE, -p.y * SCALE);
    const metHrs = (p.date.getTime() - LAUNCH_TIME.getTime()) / 3600000;
    const hex = getPhaseColor(metHrs);
    const c = new THREE.Color(hex);
    colors.push(c.r, c.g, c.b);
  }

  const orionGeo = new LineGeometry();
  orionGeo.setPositions(positions);
  orionGeo.setColors(colors);
  const orionMat = new LineMaterial({
    linewidth: 2,
    vertexColors: true,
    transparent: true,
    opacity: 0.7,
    resolution: new THREE.Vector2(window.innerWidth, window.innerHeight),
  });
  orionTrailLine = new Line2(orionGeo, orionMat);
  orionTrailLine.computeLineDistances();
  scene.add(orionTrailLine);

  // Add small dots at milestone positions on the trajectory
  const dotGeo = new THREE.SphereGeometry(0.3, 8, 6);
  for (const ms of MILESTONES) {
    const msTime = new Date(LAUNCH_TIME.getTime() + ms.metHrs * 3600000);
    if (msTime < data.orion[0].date || msTime > data.orion[data.orion.length - 1].date) continue;

    const state = interpolate(data.orion, msTime);
    const pos = new THREE.Vector3(state.x * SCALE, state.z * SCALE, -state.y * SCALE);
    const phaseColor = getPhaseColor(ms.metHrs);
    const dotMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(phaseColor) });
    const dot = new THREE.Mesh(dotGeo, dotMat);
    dot.position.copy(pos);
    scene.add(dot);
    orionMilestoneDots.push(dot);
  }

  // Moon trajectory path
  const moonPositions = [];
  for (const p of data.moon) {
    moonPositions.push(p.x * SCALE, p.z * SCALE, -p.y * SCALE);
  }
  const moonGeo = new LineGeometry();
  moonGeo.setPositions(moonPositions);
  const moonMat = new LineMaterial({
    color: 0x999999,
    linewidth: 2,
    transparent: true,
    opacity: 0.4,
    resolution: new THREE.Vector2(window.innerWidth, window.innerHeight),
  });
  moonTrailLine = new Line2(moonGeo, moonMat);
  moonTrailLine.computeLineDistances();
  scene.add(moonTrailLine);
}

function buildMilestoneUI() {
  const phaseBar = document.getElementById('phase-bar-container');
  const missionStart = data.orion[0].date.getTime();
  const missionEnd = data.orion[data.orion.length - 1].date.getTime();
  const startMetHrs = (missionStart - LAUNCH_TIME.getTime()) / 3600000;
  const endMetHrs = (missionEnd - LAUNCH_TIME.getTime()) / 3600000;

  // Phase bar: colored segments proportional to phase duration
  for (const phase of PHASES) {
    const phaseStart = Math.max(phase.startHrs, startMetHrs);
    const phaseEnd = Math.min(phase.endHrs, endMetHrs);
    if (phaseStart >= phaseEnd) continue;

    const leftPct = ((phaseStart - startMetHrs) / (endMetHrs - startMetHrs)) * 100;
    const widthPct = ((phaseEnd - phaseStart) / (endMetHrs - startMetHrs)) * 100;

    const seg = document.createElement('div');
    seg.className = 'phase-segment';
    seg.style.left = `${leftPct}%`;
    seg.style.width = `${widthPct}%`;
    seg.style.background = phase.color;
    seg.title = phase.name;
    phaseBar.appendChild(seg);
  }

  // Milestone ticks
  const tickContainer = document.getElementById('milestone-ticks');
  for (const ms of MILESTONES) {
    if (ms.metHrs < startMetHrs || ms.metHrs > endMetHrs) continue;
    const pct = ((ms.metHrs - startMetHrs) / (endMetHrs - startMetHrs)) * 100;

    const tick = document.createElement('div');
    tick.className = 'milestone-tick';
    tick.style.left = `${pct}%`;
    tick.style.background = getPhaseColor(ms.metHrs);

    const label = document.createElement('div');
    label.className = 'milestone-tick-label';
    label.textContent = ms.name;
    tick.appendChild(label);

    tick.addEventListener('click', () => {
      if (liveMode) setLiveMode(false);
      const msTime = new Date(LAUNCH_TIME.getTime() + ms.metHrs * 3600000);
      currentTime = new Date(Math.max(missionStart, Math.min(missionEnd, msTime.getTime())));
      needsRender = true;
    });

    tickContainer.appendChild(tick);
  }

  // Event jump dropdown
  const jumpSelect = document.getElementById('event-jump');
  for (const ms of MILESTONES) {
    if (ms.metHrs < startMetHrs || ms.metHrs > endMetHrs) continue;
    const opt = document.createElement('option');
    opt.value = ms.metHrs;
    const metD = Math.floor(ms.metHrs / 24);
    const metH = Math.floor(ms.metHrs % 24);
    const metM = Math.round((ms.metHrs % 1) * 60);
    opt.textContent = `${ms.name} (${metD}d ${String(metH).padStart(2, '0')}:${String(metM).padStart(2, '0')})`;
    jumpSelect.appendChild(opt);
  }
  jumpSelect.addEventListener('change', () => {
    if (!jumpSelect.value) return;
    if (liveMode) setLiveMode(false);
    const metHrs = parseFloat(jumpSelect.value);
    const msTime = new Date(LAUNCH_TIME.getTime() + metHrs * 3600000);
    currentTime = new Date(Math.max(missionStart, Math.min(missionEnd, msTime.getTime())));
    needsRender = true;
    jumpSelect.value = '';
  });
}

function toScene(p) {
  // Horizons ecliptic J2000: X, Y in ecliptic plane, Z north
  // Three.js: Y is up. Map ecliptic X -> scene X, ecliptic Z -> scene Y (up), ecliptic Y -> scene -Z
  return new THREE.Vector3(p.x * SCALE, p.z * SCALE, -p.y * SCALE);
}

// Convert equatorial J2000 (NASA telemetry) to ecliptic, then to scene coords
const OBLIQUITY = 23.4393 * Math.PI / 180;
const cosObl = Math.cos(OBLIQUITY);
const sinObl = Math.sin(OBLIQUITY);
function equatorialToScene(p) {
  // Equatorial -> Ecliptic: rotate around X by obliquity
  const ex = p.x;
  const ey = p.y * cosObl + p.z * sinObl;
  const ez = -p.y * sinObl + p.z * cosObl;
  // Ecliptic -> Scene
  return new THREE.Vector3(ex * SCALE, ez * SCALE, -ey * SCALE);
}

// Extrapolate live telemetry using velocity (position) and angular rates (attitude)
const _quatA = new THREE.Quaternion();
const _quatB = new THREE.Quaternion();
const _quatDelta = new THREE.Quaternion();

function getLiveState() {
  if (!liveTelemetry) return null;
  const t = liveTelemetry;
  const dtSec = (performance.now() - liveTelemetryTime) / 1000;

  // Dead-reckon position
  const vx = t.vx || 0, vy = t.vy || 0, vz = t.vz || 0;
  const x = t.x + vx * dtSec;
  const y = t.y + vy * dtSec;
  const z = t.z + vz * dtSec;
  const r = Math.sqrt(x * x + y * y + z * z);

  // Dead-reckon quaternion using angular rates (deg/s -> rad/s)
  let qw = t.qw, qx = t.qx, qy = t.qy, qz = t.qz;
  if (qw != null && t.rateRoll != null) {
    const wx = (t.rateRoll || 0) * Math.PI / 180;
    const wy = (t.ratePitch || 0) * Math.PI / 180;
    const wz = (t.rateYaw || 0) * Math.PI / 180;
    const halfAngle = 0.5 * Math.sqrt(wx * wx + wy * wy + wz * wz) * dtSec;
    if (halfAngle > 1e-8) {
      const axis = Math.sin(halfAngle) / (halfAngle * 2 / dtSec);
      _quatDelta.set(wx * axis, wy * axis, wz * axis, Math.cos(halfAngle));
      _quatA.set(qx, qy, qz, qw);
      _quatA.multiply(_quatDelta);
      _quatA.normalize();
      qw = _quatA.w; qx = _quatA.x; qy = _quatA.y; qz = _quatA.z;
    }
  }

  return {
    ...t,
    x, y, z,
    qw, qx, qy, qz,
    altitude: r - 6371,
  };
}

function updateScene() {
  if (!data) return;

  // Use live NASA telemetry for Orion position when in live mode
  let orionState;
  let usedLive = false;
  if (liveMode && liveTelemetry) {
    orionState = getLiveState();
    usedLive = true;
  } else {
    orionState = interpolate(data.orion, currentTime);
  }
  const moonState = interpolate(data.moon, currentTime);
  const sunState = interpolate(data.sun, currentTime);

  // Both Horizons data and NASA telemetry appear to be in the same Earth-centered
  // frame (Horizons defaults to equatorial for geocentric vectors), so use the
  // same toScene mapping for both.
  const orionPos = toScene(orionState);
  const moonPos = toScene(moonState);

  // Update object positions
  moonMesh.position.copy(moonPos);
  moonMesh.lookAt(_origin);
  moonMesh.rotateY(Math.PI);

  // Easter egg: alien on the far side of the Moon
  // Far-side direction = Moon away from Earth (moon is tidally locked)
  _v0.copy(_origin).sub(moonPos).normalize(); // moonToEarth
  _v1.copy(_v0).negate(); // farSideDir
  // Place alien on the far-side surface, oriented "standing" on the Moon
  alienGroup.position.copy(moonPos).addScaledVector(_v1, MOON_RADIUS);
  // Orient so local +Y = surface normal (standing upright on surface)
  _q0.setFromUnitVectors(_up, _v1);
  alienGroup.quaternion.copy(_q0);
  // Head tracks Orion
  _v2.copy(orionPos);
  alienHead.lookAt(alienGroup.worldToLocal(_v2));
  // Wave animation
  armPivot.rotation.z = -Math.PI / 3 + Math.sin(performance.now() * 0.005) * 0.4;
  // Show only when Orion is on the far side
  _v2.subVectors(orionPos, moonPos).normalize();
  alienGroup.visible = _v2.dot(_v1) > 0.3;

  orionGroup.position.copy(orionPos);

  // Rotate Earth to match reality
  // Greenwich Mean Sidereal Time: Earth's rotation angle relative to vernal equinox
  // GMST at J2000.0 epoch (2000-01-01 12:00 UTC) = 280.46061837 degrees
  // Earth rotates 360.98564736629 degrees per day (sidereal)
  const J2000 = Date.UTC(2000, 0, 1, 12, 0, 0);
  const daysSinceJ2000 = (currentTime.getTime() - J2000) / 86400000;
  const gmstDeg = (280.46061837 + 360.98564736629 * daysSinceJ2000) % 360;
  earthMesh.rotation.y = gmstDeg * Math.PI / 180;

  // Orient Orion model
  if (usedLive && orionState.qw != null) {
    // Use actual spacecraft attitude quaternion from telemetry
    orionGroup.quaternion.set(orionState.qx, orionState.qz, -orionState.qy, orionState.qw);
  } else {
    // Fallback: point nose (+X in body frame) along velocity
    _v0.set(orionState.vx, orionState.vz, -orionState.vy).normalize();
    _q0.setFromUnitVectors(_forward, _v0);
    orionGroup.quaternion.copy(_q0);
  }

  // Sun direction (placed at visual distance, not to scale)
  const sunDir = toScene(sunState).normalize();
  sunSprite.position.copy(sunDir).multiplyScalar(SUN_VISUAL_DIST);
  sunLabel.position.copy(sunDir).multiplyScalar(SUN_VISUAL_DIST * 0.95).add(_v0.set(0, 40, 0));
  sunLight.position.copy(sunDir).multiplyScalar(500);

  // Labels follow objects
  moonLabel.position.copy(moonPos).add(_v0.set(0, MOON_RADIUS + 5, 0));
  orionLabel.position.copy(orionPos).add(_v0.set(0, 4, 0));

  // Scale orion marker based on camera distance
  const camDist = camera.position.distanceTo(orionPos);
  const markerScale = Math.max(0.3, Math.min(3, camDist / 80));
  orionGroup.scale.setScalar(markerScale);
  orionRing.lookAt(camera.position);

  // Camera tracking
  if (focusTarget === 'orion') {
    controls.target.lerp(orionPos, 0.05);
  } else if (focusTarget === 'moon') {
    controls.target.lerp(moonPos, 0.05);
  } else if (focusTarget === 'earth') {
    controls.target.lerp(_origin, 0.05);
  } else if (focusTarget === 'system') {
    controls.target.lerp(_system, 0.05);
  }

  // Update HUD
  const distEarthKm = Math.sqrt(orionState.x ** 2 + orionState.y ** 2 + orionState.z ** 2);
  const distMoonKm = Math.sqrt(
    (orionState.x - moonState.x) ** 2 +
    (orionState.y - moonState.y) ** 2 +
    (orionState.z - moonState.z) ** 2
  );
  const speed = Math.sqrt(orionState.vx ** 2 + orionState.vy ** 2 + orionState.vz ** 2);
  const altitudeKm = (usedLive && orionState.altitude != null) ? orionState.altitude : (distEarthKm - 6371);

  elDistEarth.textContent = formatDist(distEarthKm);
  elDistMoon.textContent = formatDist(distMoonKm);
  elVelocity.textContent = formatSpeed(speed);
  elAltitude.textContent = formatDist(altitudeKm);
  elDataSource.textContent = usedLive ? 'NASA AROW (live)' : 'JPL Horizons';
  elDataSource.style.color = usedLive ? '#44ff88' : '#ddeeff';
  if (usedLive && liveTelemetry?.date) {
    const ageSec = Math.round((Date.now() - liveTelemetry.date.getTime()) / 1000);
    elDataAge.textContent = `${ageSec}s ago`;
  } else {
    elDataAge.textContent = liveMode ? 'waiting...' : '';
  }
  // Time display — in live mode, always use wall clock for ticking display
  const displayTime = liveMode ? new Date() : currentTime;
  const timeStr = useLocalTime
    ? displayTime.toLocaleString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' })
    : displayTime.toUTCString().replace('GMT', 'UTC');
  elTimeLabel.textContent = timeStr;
  const met = displayTime.getTime() - LAUNCH_TIME.getTime();
  elMetLabel.textContent = `MET: ${formatMET(met)}`;
  elSpeedDisplay.textContent = liveMode ? '' : formatPlaybackSpeed();
  document.title = `MET ${formatMET(met)} | Alt ${formatDist(altitudeKm)}`;

  // Update event badge — show nearest milestone if within 5 minutes
  const metMs = currentTime.getTime() - LAUNCH_TIME.getTime();
  const nearest = getNearestMilestone(metMs, 1800000); // 30 minutes
  const elEventBadge = document.getElementById('event-badge');
  if (nearest) {
    elEventBadge.textContent = '\u203A ' + nearest.milestone.name;
    elEventBadge.style.color = getPhaseColor(nearest.milestone.metHrs);
  } else {
    elEventBadge.textContent = '';
  }

  // Update phase label
  const currentPhase = getPhaseAtMet(metMs);
  const elPhaseLabel = document.getElementById('phase-label');
  if (currentPhase) {
    elPhaseLabel.textContent = currentPhase.name;
    elPhaseLabel.style.color = currentPhase.color;
  }

  // Update extended telemetry HUD
  updateTelemetryHUD(usedLive ? liveTelemetry : null);

  // Timeline slider
  const frac = (currentTime.getTime() - timeStart.getTime()) / (timeEnd.getTime() - timeStart.getTime());
  elTimeline.value = Math.round(frac * 1000);
}

function formatDist(km) {
  if (useImperial) {
    const mi = km * 0.621371;
    if (mi >= 1000) return `${mi.toLocaleString('en-US', { maximumFractionDigits: 0 })} mi`;
    return `${mi.toFixed(1)} mi`;
  }
  if (km >= 1000) return `${km.toLocaleString('en-US', { maximumFractionDigits: 0 })} km`;
  return `${km.toFixed(1)} km`;
}

function formatSpeed(kmPerSec) {
  if (useImperial) {
    const mph = kmPerSec * 2236.936;
    return `${mph.toLocaleString('en-US', { maximumFractionDigits: 0 })} mph`;
  }
  return `${kmPerSec.toFixed(2)} km/s (${(kmPerSec * 3600).toLocaleString('en-US', { maximumFractionDigits: 0 })} km/h)`;
}

function formatMET(ms) {
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hrs = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const tenths = Math.floor((ms % 1000) / 100);
  const base = `${days}d ${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return liveMode ? `${base}.${tenths}` : base;
}

// --- Live mode ---
const elBtnLive = document.getElementById('btn-live');
const elLiveStatus = document.getElementById('live-status');

function setLiveMode(on) {
  liveMode = on;
  if (on) {
    playing = false;
    elBtnPlay.textContent = '\u25B6 Play';
    elBtnLive.classList.add('active');
    speedMultiplier = 1;
    speedIdx = 0;
    lastTelemetryFetch = -Infinity; // fetch immediately on entering live mode
    updateSpeedDisplay();
    updateLiveTime();
  } else {
    elBtnLive.classList.remove('active');
    elLiveStatus.textContent = '';
  }
}

function updateLiveTime() {
  const wallNow = new Date();
  if (wallNow < timeStart) {
    // Before trajectory data begins — clamp to start, show countdown
    currentTime = new Date(timeStart);
    const secsUntil = Math.ceil((timeStart.getTime() - wallNow.getTime()) / 1000);
    const mins = Math.floor(secsUntil / 60);
    const secs = secsUntil % 60;
    elLiveStatus.textContent = `Tracking data begins in ${mins}m ${String(secs).padStart(2, '0')}s (post-ICPS separation)`;
  } else if (wallNow > timeEnd) {
    currentTime = new Date(timeEnd);
    elLiveStatus.textContent = 'Mission tracking data ended';
  } else {
    currentTime = wallNow;
    elLiveStatus.textContent = '';
  }
}

// --- Animation loop ---
function animate() {
  requestAnimationFrame(animate);

  const now = performance.now();
  if (liveMode) {
    updateLiveTime();
    pollTelemetry(); // non-blocking, rate-limited to every 2s
    needsRender = true;
  } else if (playing && lastRealTime) {
    const dtReal = (now - lastRealTime) / 1000;
    const dtMission = dtReal * speedMultiplier * 1000;
    currentTime = new Date(Math.min(currentTime.getTime() + dtMission, timeEnd.getTime()));
    if (currentTime.getTime() >= timeEnd.getTime()) {
      playing = false;
      elBtnPlay.textContent = '\u25B6 Play';
    }
    needsRender = true;
  }
  lastRealTime = now;

  // Always update controls (damping triggers 'change' event which sets needsRender)
  controls.update();

  // Skip expensive rendering when nothing has changed
  // Always render when tracking a target (camera lerp needs continuous frames)
  if (focusTarget !== 'free') needsRender = true;
  if (!needsRender) return;
  needsRender = false;

  updateScene();
  renderer.render(scene, camera);
}

// --- UI event handlers ---
elBtnPlay.addEventListener('click', () => {
  if (liveMode) setLiveMode(false);
  playing = !playing;
  elBtnPlay.textContent = playing ? '\u23F8 Pause' : '\u25B6 Play';
  if (playing) lastRealTime = performance.now();
  needsRender = true;
});

document.getElementById('btn-live').addEventListener('click', () => {
  setLiveMode(!liveMode);
});

document.getElementById('btn-faster').addEventListener('click', () => {
  if (liveMode) setLiveMode(false);
  speedIdx = Math.min(speedIdx + 1, speedSteps.length - 1);
  speedMultiplier = speedSteps[speedIdx];
  playing = true;
  elBtnPlay.textContent = '\u23F8 Pause';
  updateSpeedDisplay();
});

document.getElementById('btn-slower').addEventListener('click', () => {
  if (liveMode) setLiveMode(false);
  speedIdx = Math.max(speedIdx - 1, 0);
  speedMultiplier = speedSteps[speedIdx];
  updateSpeedDisplay();
});

function formatPlaybackSpeed() {
  if (speedMultiplier >= 3600) return `${speedMultiplier / 3600}h/s`;
  if (speedMultiplier >= 60) return `${speedMultiplier / 60}m/s`;
  return `${speedMultiplier}x`;
}
function updateSpeedDisplay() {
  elSpeedDisplay.textContent = liveMode ? '' : formatPlaybackSpeed();
}
updateSpeedDisplay();

elTimeline.addEventListener('input', () => {
  if (liveMode) setLiveMode(false);
  const frac = parseInt(elTimeline.value) / 1000;
  currentTime = new Date(timeStart.getTime() + frac * (timeEnd.getTime() - timeStart.getTime()));
  needsRender = true;
});

// Focus buttons
['earth', 'orion', 'moon', 'free', 'system'].forEach(target => {
  document.getElementById(`focus-${target}`).addEventListener('click', () => {
    focusTarget = target;
    needsRender = true;
    document.querySelectorAll('#focus-btns .btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`focus-${target}`).classList.add('active');
  });
});

// Units and timezone toggles
const btnUnits = document.getElementById('btn-units');
const btnTz = document.getElementById('btn-tz');
btnUnits.addEventListener('click', () => {
  useImperial = !useImperial;
  btnUnits.textContent = useImperial ? 'mi' : 'km';
});
btnTz.addEventListener('click', () => {
  useLocalTime = !useLocalTime;
  btnTz.textContent = useLocalTime ? 'Local' : 'UTC';
});

// Resize
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (orionTrailLine) {
    orionTrailLine.material.resolution.set(window.innerWidth, window.innerHeight);
    moonTrailLine.material.resolution.set(window.innerWidth, window.innerHeight);
  }
  needsRender = true;
});

// Keyboard shortcuts
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') { e.preventDefault(); elBtnPlay.click(); }
  if (e.code === 'ArrowRight') document.getElementById('btn-faster').click();
  if (e.code === 'ArrowLeft') document.getElementById('btn-slower').click();
  if (e.key === '1') document.getElementById('focus-earth').click();
  if (e.key === '2') document.getElementById('focus-orion').click();
  if (e.key === '3') document.getElementById('focus-moon').click();
  if (e.key === '4') document.getElementById('focus-free').click();
  if (e.key === '5') document.getElementById('focus-system').click();
  if (e.key === 'l' || e.key === 'L') document.getElementById('btn-live').click();
  if (e.key === 'u' || e.key === 'U') document.getElementById('btn-units').click();
  if (e.key === 't' || e.key === 'T') document.getElementById('btn-tz').click();
  if (e.key === '?') {
    const modal = document.getElementById('about-modal');
    modal.classList.toggle('open');
  }
  if (e.key === 'n' || e.key === 'N') {
    const metHrs = (currentTime.getTime() - LAUNCH_TIME.getTime()) / 3600000;
    const next = MILESTONES.find(ms => ms.metHrs > metHrs + 0.01);
    if (next) {
      if (liveMode) setLiveMode(false);
      const msTime = new Date(LAUNCH_TIME.getTime() + next.metHrs * 3600000);
      currentTime = new Date(Math.max(timeStart.getTime(), Math.min(timeEnd.getTime(), msTime.getTime())));
      needsRender = true;
    }
  }
  if (e.key === 'p' || e.key === 'P') {
    const metHrs = (currentTime.getTime() - LAUNCH_TIME.getTime()) / 3600000;
    const prev = [...MILESTONES].reverse().find(ms => ms.metHrs < metHrs - 0.01);
    if (prev) {
      if (liveMode) setLiveMode(false);
      const msTime = new Date(LAUNCH_TIME.getTime() + prev.metHrs * 3600000);
      currentTime = new Date(Math.max(timeStart.getTime(), Math.min(timeEnd.getTime(), msTime.getTime())));
      needsRender = true;
    }
  }
});

// --- Modals ---
document.getElementById('about-modal').addEventListener('click', (e) => {
  if (e.target.id === 'about-modal') e.target.classList.remove('open');
});
document.getElementById('btn-about').addEventListener('click', () => {
  document.getElementById('about-modal').classList.add('open');
});

// --- Collapsible telemetry section ---
{
  const header = document.getElementById('toggle-telemetry');
  const body = document.getElementById('section-telemetry');
  header.addEventListener('click', () => {
    header.classList.toggle('open');
    body.classList.toggle('open');
  });
}

// --- Extended telemetry HUD ---
function tv(val, decimals = 4) {
  if (val == null) return '\u2014';
  return typeof val === 'number' ? val.toFixed(decimals) : String(val);
}

function setTelem(id, val, decimals = 4) {
  const el = document.getElementById(id);
  if (!el) return;
  const text = tv(val, decimals);
  el.textContent = text;
  el.classList.toggle('telemetry-na', val == null);
}

function updateTelemetryHUD(telem) {
  // Attitude
  setTelem('att-qw', telem?.qw);
  setTelem('att-qx', telem?.qx);
  setTelem('att-qy', telem?.qy);
  setTelem('att-qz', telem?.qz);
  setTelem('rate-roll', telem?.rateRoll, 3);
  setTelem('rate-pitch', telem?.ratePitch, 3);
  setTelem('rate-yaw', telem?.rateYaw, 3);

  // Propulsion
  setTelem('thr-1', telem?.thr1, 0);
  setTelem('thr-2', telem?.thr2, 0);
  setTelem('thr-3', telem?.thr3, 0);
  setTelem('rcs-1', telem?.rcs1, 0);
  setTelem('rcs-2', telem?.rcs2, 0);
  setTelem('rcs-3', telem?.rcs3, 0);
  setTelem('rcs-4', telem?.rcs4, 0);
  setTelem('rcs-5', telem?.rcs5, 0);

  // Solar arrays
  setTelem('solar-2048', telem?.solar2048, 2);
  setTelem('solar-2049', telem?.solar2049, 2);
  setTelem('solar-2050', telem?.solar2050, 2);
  setTelem('solar-2051', telem?.solar2051, 2);
  setTelem('solar-2052', telem?.solar2052, 2);
  setTelem('solar-2053', telem?.solar2053, 2);

  // Status
  const flagVal = telem?.statusFlag;
  const flagEl = document.getElementById('status-flag');
  if (flagEl) {
    flagEl.textContent = flagVal != null ? '0x' + Math.round(flagVal).toString(16).toUpperCase() : '\u2014';
    flagEl.classList.toggle('telemetry-na', flagVal == null);
  }
  setTelem('telem-alt', telem?.altitude, 1);
}

// --- Start ---
init();
