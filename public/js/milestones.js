// Mission phase definitions with colors for trajectory and timeline rendering
// Phase boundaries adjusted to match press kit event timing
export const PHASES = [
  { name: 'LEO / Orbit Raising',  color: '#4488ff', startHrs: 0,       endHrs: 25.23  },
  { name: 'Trans-Lunar Coast',    color: '#44cc88', startHrs: 25.23,   endHrs: 102.98 },
  { name: 'Lunar Flyby',          color: '#ffcc44', startHrs: 102.98,  endHrs: 139.78 },
  { name: 'Trans-Earth Coast',    color: '#ff8844', startHrs: 139.78,  endHrs: 217.22 },
  { name: 'Entry & Splashdown',   color: '#ff4466', startHrs: 217.22,  endHrs: 218.0  },
];

// Mission milestones — MET in hours from launch (T-0 = 2026-04-01T22:35:12Z)
//
// Sources:
//   Past events (Launch–TLI): actual times from NASA Artemis II blog posts
//     https://www.nasa.gov/blogs/missions/2026/04/01/live-artemis-ii-launch-day-updates/
//     https://www.nasa.gov/blogs/missions/2026/04/02/artemis-ii-flight-day-2-orion-completes-tli-burn-crew-begins-journey-to-the-moon/
//   Future events (OTC-1–Splashdown): planned times from NASA Artemis II Press Kit, pp. 13-15
//     https://www.nasa.gov/wp-content/uploads/2026/01/artemis-ii-press-kit.pdf
export const MILESTONES = [
  // — Actual times from NASA blog —
  { name: 'Launch',                  metHrs: 0,        desc: 'Liftoff from LC-39B' },
  { name: 'SRB Separation',         metHrs: 0.036,    desc: 'Solid rocket booster separation' },          // +00:02:09
  { name: 'MECO',                   metHrs: 0.135,    desc: 'Main engine cutoff' },                       // +00:08:06
  { name: 'Solar Array Deploy',     metHrs: 0.333,    desc: 'Orion solar array deployment' },             // +00:20:00
  { name: 'Perigee Raise Maneuver', metHrs: 0.817,    desc: 'ICPS perigee raise burn' },                  // +00:49:00
  { name: 'Apogee Raising Burn',    metHrs: 1.799,    desc: 'Enter high Earth orbit' },                   // +01:47:57
  { name: 'Orion/ICPS Separation',  metHrs: 3.404,    desc: 'Separation from upper stage' },              // +03:24:15
  { name: 'Perigee Raise Burn 2',   metHrs: 13.733,   desc: 'Second perigee raise for TLI geometry' },    // +0/13:44
  { name: 'TLI Burn',               metHrs: 25.233,   desc: 'Trans-Lunar Injection' },                    // actual: ~Apr 2 23:49 UTC
  // — Planned times from NASA press kit (pp. 13-15) —
  { name: 'OTC Burn',               metHrs: 47.417,   desc: 'Trajectory correction burn' },               // +1/23:25
  { name: 'OTC-1',                  metHrs: 48.117,   desc: 'Outbound trajectory correction 1' },         // +2/00:07
  { name: 'OTC-2',                  metHrs: 72.2,     desc: 'Outbound trajectory correction 2' },         // +3/00:12
  { name: 'OTC-3',                  metHrs: 101.383,  desc: 'Outbound trajectory correction 3' },         // +4/05:23
  { name: 'Lunar SOI Entry',        metHrs: 102.983,  desc: 'Enter Moon sphere of influence' },           // +4/06:59
  { name: 'Lunar Close Approach',   metHrs: 121.383,  desc: 'Closest approach to the Moon' },             // +5/01:23
  { name: 'Max Earth Distance',     metHrs: 121.433,  desc: 'Maximum distance from Earth' },              // +5/01:26
  { name: 'Lunar SOI Exit',         metHrs: 139.783,  desc: 'Exit Moon sphere of influence' },            // +5/19:47
  { name: 'RTC-1',                  metHrs: 148.383,  desc: 'Return trajectory correction 1' },           // +6/04:23
  { name: 'RTC-2',                  metHrs: 196.55,   desc: 'Return trajectory correction 2' },           // +8/04:33
  { name: 'RTC-3',                  metHrs: 212.55,   desc: 'Return trajectory correction 3' },           // +8/20:33
  { name: 'CM/SM Separation',       metHrs: 217.217,  desc: 'Crew module separates from service module' },// +9/01:13
  { name: 'Entry Interface',        metHrs: 217.55,   desc: 'Atmospheric entry at 400,000 ft' },          // +9/01:33
  { name: 'Splashdown',             metHrs: 217.767,  desc: 'Pacific Ocean splashdown' },                 // +9/01:46
];

export const MISSION_DURATION_HRS = 218.0;

const MS_PER_HR = 3600000;

/**
 * Returns the phase object for a given MET in milliseconds.
 */
export function getPhaseAtMet(metMs) {
  const metHrs = metMs / MS_PER_HR;
  return PHASES.find(p => metHrs >= p.startHrs && metHrs < p.endHrs) || null;
}

/**
 * Returns the nearest milestone within toleranceMs, or null.
 * @param {number} metMs - MET in milliseconds
 * @param {number} toleranceMs - search tolerance in ms (default 5 minutes)
 * @returns {{ milestone: object, distanceMs: number } | null}
 */
export function getNearestMilestone(metMs, toleranceMs = 300000) {
  let best = null;
  let bestDist = Infinity;
  for (const m of MILESTONES) {
    const dist = Math.abs(metMs - m.metHrs * MS_PER_HR);
    if (dist < bestDist) {
      bestDist = dist;
      best = m;
    }
  }
  if (best && bestDist <= toleranceMs) {
    return { milestone: best, distanceMs: bestDist };
  }
  return null;
}

/**
 * Returns the hex color string for a given MET in hours.
 */
export function getPhaseColor(metHrs) {
  const phase = PHASES.find(p => metHrs >= p.startHrs && metHrs < p.endHrs);
  return phase ? phase.color : '#888888';
}

/**
 * Returns true if metHrs is within deltaMet hours of any milestone.
 */
export function isNearMilestone(metHrs, deltaMet = 0.5) {
  return MILESTONES.some(m => Math.abs(metHrs - m.metHrs) <= deltaMet);
}
