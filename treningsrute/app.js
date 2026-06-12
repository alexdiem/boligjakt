/* Terrengøkt — aligns a structured workout with real-world terrain along a GPX route.
   Everything runs client-side. UI text is Norwegian; code is English. */

'use strict';

/* ============================================================
   Geometry & route model
   ============================================================ */

const SAMPLE_STEP = 10; // metres between resampled route points

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function parseGPX(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Ugyldig GPX-fil.');
  let pts = [...doc.querySelectorAll('trkpt')];
  if (pts.length < 2) pts = [...doc.querySelectorAll('rtept')];
  if (pts.length < 2) throw new Error('Fant ingen rutepunkter i GPX-filen.');
  const points = pts.map((p) => ({
    lat: parseFloat(p.getAttribute('lat')),
    lon: parseFloat(p.getAttribute('lon')),
    ele: parseFloat(p.querySelector('ele')?.textContent ?? 'NaN'),
  }));
  if (points.some((p) => isNaN(p.ele))) {
    throw new Error('GPX-filen mangler høydedata (<ele>), som trengs for terrenganalysen.');
  }
  return points;
}

/* Resamples the track at a fixed step and computes smoothed elevation + grade.
   Returns { lat[], lon[], ele[], grade[], step, totalDist, n } */
function buildRouteFromPoints(points) {
  // cumulative distance of raw points
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + haversine(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon));
  }
  const totalDist = cum[cum.length - 1];
  if (totalDist < 500) throw new Error('Ruten er for kort (under 500 m).');

  const n = Math.floor(totalDist / SAMPLE_STEP) + 1;
  const lat = new Float64Array(n), lon = new Float64Array(n), eleRaw = new Float64Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const d = i * SAMPLE_STEP;
    while (j < cum.length - 2 && cum[j + 1] < d) j++;
    const span = cum[j + 1] - cum[j];
    const t = span > 0 ? (d - cum[j]) / span : 0;
    lat[i] = points[j].lat + t * (points[j + 1].lat - points[j].lat);
    lon[i] = points[j].lon + t * (points[j + 1].lon - points[j].lon);
    eleRaw[i] = points[j].ele + t * (points[j + 1].ele - points[j].ele);
  }

  // smooth elevation with a ±5-sample (±50 m) moving average
  const ele = new Float64Array(n);
  const W = 5;
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = Math.max(0, i - W); k <= Math.min(n - 1, i + W); k++) { s += eleRaw[k]; c++; }
    ele[i] = s / c;
  }

  // grade (%) from smoothed elevation over a ±30 m window
  const grade = new Float64Array(n);
  const G = 3;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - G), b = Math.min(n - 1, i + G);
    grade[i] = ((ele[b] - ele[a]) / ((b - a) * SAMPLE_STEP)) * 100;
  }

  return { lat, lon, ele, grade, step: SAMPLE_STEP, totalDist, n };
}

function routeIndexAt(route, dist) {
  return Math.max(0, Math.min(route.n - 1, Math.round(dist / route.step)));
}
function gradeAt(route, dist) { return route.grade[routeIndexAt(route, dist)]; }
function eleAt(route, dist) { return route.ele[routeIndexAt(route, dist)]; }
function latLngAt(route, dist) {
  const i = routeIndexAt(route, dist);
  return [route.lat[i], route.lon[i]];
}
function latLngsBetween(route, d0, d1) {
  const i0 = routeIndexAt(route, d0), i1 = routeIndexAt(route, d1);
  const out = [];
  for (let i = i0; i <= i1; i++) out.push([route.lat[i], route.lon[i]]);
  return out;
}

/* ============================================================
   Workout parsing
   Normalised step: { name, durationSec?, distanceM?, intensity (fraction of FTP), kind }
   kind ∈ warmup | cooldown | rest | endurance | tempo | work
   ============================================================ */

function classifyIntensity(intensity) {
  if (intensity < 0.55) return 'rest';
  if (intensity < 0.76) return 'endurance';
  if (intensity < 0.88) return 'tempo';
  return 'work';
}

/* ---------- Zwift .zwo ---------- */
function parseZwo(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Ugyldig .zwo-fil.');
  const wo = doc.querySelector('workout');
  if (!wo) throw new Error('Fant ingen <workout> i .zwo-filen.');
  const steps = [];
  const num = (el, attr, def) => {
    const v = parseFloat(el.getAttribute(attr));
    return isNaN(v) ? def : v;
  };
  for (const el of wo.children) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'warmup' || tag === 'cooldown' || tag === 'ramp') {
      const dur = num(el, 'Duration', 300);
      const lo = num(el, 'PowerLow', 0.5), hi = num(el, 'PowerHigh', 0.75);
      const avg = (lo + hi) / 2;
      const kind = tag === 'warmup' ? 'warmup' : tag === 'cooldown' ? 'cooldown' : classifyIntensity(avg);
      steps.push({ name: el.tagName, durationSec: dur, intensity: avg, kind });
    } else if (tag === 'steadystate') {
      const p = num(el, 'Power', 0.6);
      steps.push({ name: 'SteadyState', durationSec: num(el, 'Duration', 300), intensity: p, kind: classifyIntensity(p) });
    } else if (tag === 'intervalst') {
      const reps = Math.max(1, Math.round(num(el, 'Repeat', 1)));
      const onDur = num(el, 'OnDuration', 60), offDur = num(el, 'OffDuration', 60);
      const onP = num(el, 'OnPower', 1.0), offP = num(el, 'OffPower', 0.5);
      for (let r = 0; r < reps; r++) {
        steps.push({ name: `Drag ${r + 1}/${reps}`, durationSec: onDur, intensity: onP, kind: classifyIntensity(onP) });
        steps.push({ name: `Pause ${r + 1}/${reps}`, durationSec: offDur, intensity: offP, kind: classifyIntensity(offP) });
      }
    } else if (tag === 'freeride') {
      steps.push({ name: 'FreeRide', durationSec: num(el, 'Duration', 600), intensity: 0.7, kind: 'endurance' });
    }
  }
  if (!steps.length) throw new Error('Fant ingen steg i .zwo-filen.');
  return steps;
}

/* ---------- TrainerRoad / ERG / MRC ---------- */
function parseErgMrc(text, ftp) {
  const lines = text.split(/\r?\n/);
  let inData = false, isPercent = null;
  let fileFtp = null;
  const rows = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^\[END COURSE DATA\]/i.test(line)) inData = false;
    else if (/^\[COURSE DATA\]/i.test(line)) inData = true;
    else if (/^FTP\s*=\s*(\d+)/i.test(line)) fileFtp = parseFloat(line.match(/^FTP\s*=\s*(\d+)/i)[1]);
    else if (/MINUTES\s+PERCENT/i.test(line)) isPercent = true;
    else if (/MINUTES\s+WATTS/i.test(line)) isPercent = false;
    else if (inData) {
      const m = line.match(/^([\d.]+)\s+([\d.]+)/);
      if (m) rows.push([parseFloat(m[1]), parseFloat(m[2])]);
    }
  }
  if (rows.length < 2) throw new Error('Fant ingen kursdata i .erg/.mrc-filen.');
  const effFtp = fileFtp || ftp || 250;
  const toFrac = (v) => (isPercent === false ? v / effFtp : v / 100);
  const steps = [];
  for (let i = 0; i < rows.length - 1; i++) {
    const [t0, v0] = rows[i], [t1, v1] = rows[i + 1];
    const dur = (t1 - t0) * 60;
    if (dur < 1) continue; // vertical edge between segments
    const avg = toFrac((v0 + v1) / 2);
    steps.push({ name: `Steg ${steps.length + 1}`, durationSec: dur, intensity: avg, kind: classifyIntensity(avg) });
  }
  if (!steps.length) throw new Error('Klarte ikke å tolke kursdataene.');
  // label first/last low-intensity blocks as warmup/cooldown
  if (steps[0].kind !== 'work') steps[0].kind = steps[0].kind === 'rest' ? 'warmup' : steps[0].kind;
  return steps;
}

/* ---------- Garmin .fit (workout files) ---------- */

const FIT_WKT_STEP = 27;
const FIT_DUR_TIME = 0, FIT_DUR_DISTANCE = 1, FIT_DUR_OPEN = 5, FIT_DUR_REPEAT = 6;

function parseFit(buffer, ftp) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 14) throw new Error('Ugyldig .fit-fil.');
  const headerSize = view.getUint8(0);
  const dataSize = view.getUint32(4, true);
  const sig = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
  if (sig !== '.FIT') throw new Error('Dette ser ikke ut som en .fit-fil.');

  let pos = headerSize;
  const end = Math.min(headerSize + dataSize, buffer.byteLength);
  const defs = {}; // local message type -> definition
  const rawSteps = [];

  const readValue = (offset, size, baseType, little) => {
    const bt = baseType & 0x1f;
    try {
      if (bt === 7) { // string
        let s = '';
        for (let i = 0; i < size; i++) {
          const c = view.getUint8(offset + i);
          if (c === 0) break;
          s += String.fromCharCode(c);
        }
        return s;
      }
      if (size === 1) return view.getUint8(offset);
      if (size === 2) return view.getUint16(offset, little);
      if (size === 4) return view.getUint32(offset, little);
    } catch (e) { /* fall through */ }
    return null;
  };

  while (pos < end) {
    const hdr = view.getUint8(pos); pos += 1;
    const isCompressed = (hdr & 0x80) !== 0;
    const isDef = !isCompressed && (hdr & 0x40) !== 0;
    const hasDev = !isCompressed && (hdr & 0x20) !== 0;
    const localType = isCompressed ? (hdr >> 5) & 0x03 : hdr & 0x0f;

    if (isDef) {
      pos += 1; // reserved
      const arch = view.getUint8(pos); pos += 1;
      const little = arch === 0;
      const globalNum = view.getUint16(pos, little); pos += 2;
      const numFields = view.getUint8(pos); pos += 1;
      const fields = [];
      for (let i = 0; i < numFields; i++) {
        fields.push({ num: view.getUint8(pos), size: view.getUint8(pos + 1), baseType: view.getUint8(pos + 2) });
        pos += 3;
      }
      let devBytes = 0;
      if (hasDev) {
        const numDev = view.getUint8(pos); pos += 1;
        for (let i = 0; i < numDev; i++) { devBytes += view.getUint8(pos + 1); pos += 3; }
      }
      defs[localType] = { globalNum, fields, little, devBytes };
    } else {
      const def = defs[localType];
      if (!def) throw new Error('Korrupt .fit-fil (manglende definisjonsmelding).');
      const rec = {};
      let p = pos;
      for (const f of def.fields) {
        rec[f.num] = readValue(p, f.size, f.baseType, def.little);
        p += f.size;
      }
      p += def.devBytes;
      pos = p;
      if (def.globalNum === FIT_WKT_STEP) {
        rawSteps.push({
          messageIndex: rec[254],
          name: rec[0] || '',
          durationType: rec[1],
          durationValue: rec[2],
          targetType: rec[3],
          targetValue: rec[4],
          customLow: rec[5],
          customHigh: rec[6],
          intensity: rec[7],
        });
      }
    }
  }

  if (!rawSteps.length) throw new Error('Fant ingen treningssteg i .fit-filen — er dette en treningsøkt (workout)?');
  rawSteps.sort((a, b) => (a.messageIndex ?? 0) - (b.messageIndex ?? 0));
  return fitStepsToWorkout(rawSteps, ftp || 250);
}

function fitPowerFraction(step, ftp) {
  // target_type 4 = power
  if (step.targetType === 4) {
    if (step.targetValue >= 1 && step.targetValue <= 7) {
      return [0.5, 0.62, 0.8, 0.93, 1.08, 1.25, 1.5][step.targetValue - 1];
    }
    const lo = step.customLow, hi = step.customHigh;
    if (lo != null && hi != null && hi > 0) {
      const mid = (lo + hi) / 2;
      // 0–1000 encodes % of FTP; >1000 encodes watts offset by 1000
      return mid > 1000 ? (mid - 1000) / ftp : mid / 100;
    }
  }
  return null;
}

function fitStepsToWorkout(rawSteps, ftp) {
  const expanded = []; // { srcIndex, step }
  for (const s of rawSteps) {
    if (s.durationType === FIT_DUR_REPEAT) {
      const from = s.durationValue;
      const reps = Math.max(1, s.targetValue || 1);
      const block = expanded.filter((e) => e.srcIndex >= from);
      for (let r = 1; r < reps; r++) {
        for (const b of block) expanded.push({ srcIndex: b.srcIndex, step: b.step });
      }
      continue;
    }
    expanded.push({ srcIndex: s.messageIndex ?? expanded.length, step: s });
  }

  const intensityKind = { 1: 'rest', 4: 'rest', 2: 'warmup', 3: 'cooldown' };
  const out = [];
  for (const { step: s } of expanded) {
    const frac = fitPowerFraction(s, ftp);
    let kind = intensityKind[s.intensity];
    let intensity = frac;
    if (intensity == null) intensity = kind === 'rest' ? 0.45 : kind === 'warmup' || kind === 'cooldown' ? 0.55 : 0.9;
    if (!kind) kind = classifyIntensity(intensity);

    const norm = { name: s.name || kindLabel(kind), intensity, kind };
    if (s.durationType === FIT_DUR_TIME) norm.durationSec = s.durationValue / 1000;
    else if (s.durationType === FIT_DUR_DISTANCE) norm.distanceM = s.durationValue / 100;
    else norm.durationSec = 300; // open / lap-button steps: assume 5 min
    out.push(norm);
  }
  return out;
}

/* ---------- dispatch ---------- */
function parseWorkoutFile(name, content, ftp) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.fit')) return parseFit(content, ftp);
  if (lower.endsWith('.zwo') || lower.endsWith('.xml')) return parseZwo(content);
  if (lower.endsWith('.erg') || lower.endsWith('.mrc')) {
    const steps = parseErgMrc(content, ftp);
    return steps;
  }
  throw new Error('Ukjent filtype. Støttede formater: .fit, .zwo, .erg, .mrc');
}

/* ============================================================
   Optimizer
   ============================================================ */

const MAX_REST_STRETCH = 0.5;   // rest may grow by up to +50 %
const DESCENT_DONE_GRADE = -1;  // grade (%) above which a descent counts as finished

/* Resolve steps to seconds at a given speed (m/s). */
function resolveDurations(steps, speedMs) {
  return steps.map((s) => ({
    ...s,
    durationSec: s.durationSec != null ? s.durationSec : s.distanceM / speedMs,
  }));
}

/* Place the workout on the route starting at distance s0 (metres).
   Rest steps are stretched (≤ +50 %) while the rider is still descending. */
function simulatePlacement(route, steps, s0, speedMs) {
  const segments = [];
  let pos = s0;
  let addedRestSec = 0;
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    const plannedDist = st.durationSec * speedMs;
    let endPos = pos + plannedDist;
    let stretchSec = 0;
    if (st.kind === 'rest' && i < steps.length - 1) {
      const maxEnd = pos + plannedDist * (1 + MAX_REST_STRETCH);
      while (endPos < maxEnd && endPos < route.totalDist && gradeAt(route, endPos) < DESCENT_DONE_GRADE) {
        endPos = Math.min(maxEnd, endPos + route.step);
      }
      stretchSec = (endPos - (pos + plannedDist)) / speedMs;
      addedRestSec += stretchSec;
    }
    if (endPos > route.totalDist) return null; // workout does not fit
    segments.push({
      index: i, name: st.name, kind: st.kind, intensity: st.intensity,
      plannedSec: st.durationSec, adjustedSec: st.durationSec + stretchSec, stretchSec,
      startDist: pos, endDist: endPos,
    });
    pos = endPos;
  }
  // average grade per segment
  for (const seg of segments) {
    seg.avgGrade = ((eleAt(route, seg.endDist) - eleAt(route, seg.startDist)) /
      Math.max(1, seg.endDist - seg.startDist)) * 100;
  }
  return { segments, addedRestSec, startDist: s0, endDist: pos };
}

/* Higher is better: hard efforts on climbs, rest on descents/flats. */
function scorePlacement(route, segments) {
  let total = 0, count = 0;
  const SAMPLE = 20; // metres
  for (const seg of segments) {
    const w = seg.intensity;
    for (let d = seg.startDist; d < seg.endDist; d += SAMPLE) {
      const g = Math.max(-12, Math.min(12, gradeAt(route, d)));
      let s = 0;
      if (seg.kind === 'work') {
        s = w * g;                                    // uphill is favourable for hard efforts
        if (g < -3) s -= w * (Math.abs(g) - 3) * 2;   // steep descents ruin hard intervals
      } else if (seg.kind === 'tempo') {
        s = 0.5 * w * g;
        if (g < -4) s -= w * (Math.abs(g) - 4);
      } else if (seg.kind === 'rest') {
        if (g < 0) s = 1.4 * -g;                      // descents are ideal recovery
        else if (g > 1) s = -1.6 * (g - 1);           // resting uphill defeats the purpose
      } else {
        s = -0.15 * Math.abs(g);                      // warmup/cooldown/endurance prefer gentle terrain
      }
      total += s;
      count++;
    }
  }
  return count ? total / count : -Infinity;
}

/* Search start positions between the commute zones. All distances in metres. */
function optimize(route, steps, speedMs, commuteStartM, commuteEndM) {
  const resolved = resolveDurations(steps, speedMs);
  const minWorkoutDist = resolved.reduce((a, s) => a + s.durationSec * speedMs, 0);
  const latestEnd = route.totalDist - commuteEndM;
  const earliestStart = commuteStartM;

  if (earliestStart + minWorkoutDist > latestEnd) {
    throw new Error(
      `Økten trenger minst ${(minWorkoutDist / 1000).toFixed(1)} km, men det er bare ` +
      `${((latestEnd - earliestStart) / 1000).toFixed(1)} km tilgjengelig mellom pendlersonene. ` +
      'Reduser pendlersonene, øk farten eller velg en lengre rute.'
    );
  }

  const stepSize = Math.max(20, Math.round(route.totalDist / 2000 / 10) * 10);
  let best = null;
  for (let s0 = earliestStart; s0 + minWorkoutDist <= latestEnd; s0 += stepSize) {
    const placement = simulatePlacement(route, resolved, s0, speedMs);
    if (!placement || placement.endDist > latestEnd) continue;
    const score = scorePlacement(route, placement.segments);
    if (!best || score > best.score) best = { ...placement, score };
  }
  if (!best) {
    throw new Error('Fant ingen gyldig plassering — pausene som forlenges gjør at økten ikke får plass. Prøv kortere pendlersoner.');
  }
  return best;
}

/* ============================================================
   Formatting helpers
   ============================================================ */

function fmtTime(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
function fmtKm(m) { return (m / 1000).toFixed(1).replace('.', ',') + ' km'; }
function fmtPct(v) { return (v >= 0 ? '+' : '') + v.toFixed(1).replace('.', ',') + ' %'; }

function kindLabel(kind) {
  return { warmup: 'Oppvarming', cooldown: 'Nedtrapping', rest: 'Pause', endurance: 'Rolig', tempo: 'Tempo', work: 'Hardt drag' }[kind] || kind;
}
function kindColor(kind, intensity) {
  switch (kind) {
    case 'rest': return '#4a7fd9';
    case 'warmup': case 'cooldown': return '#8f9aa8';
    case 'endurance': return '#3f8f63';
    case 'tempo': return '#c79a2e';
    case 'work': return intensity >= 1.05 ? '#9e2f1c' : '#cf4f2b';
    default: return '#777';
  }
}

/* ============================================================
   Demo data
   ============================================================ */

function demoGpx() {
  // ~42 km out of Oslo with a flat commute, two climbs with descents, rolling middle.
  const pts = [];
  let lat = 59.91, lon = 10.78;
  const totalKm = 42, stepM = 50, n = (totalKm * 1000) / stepM;
  const eleAtKm = (km) => {
    let e = 50;
    e += 25 * smoothstep(km, 4, 5);                     // small rise after commute
    e += 220 * smoothstep(km, 7, 12);                   // climb 1: 5 km @ ~4.5 %
    e -= 190 * smoothstep(km, 13, 17);                  // descent 1
    e += 35 * Math.sin((km - 17) * 0.9) * smoothstep(km, 17, 19) * (1 - smoothstep(km, 23, 25)); // rollers
    e += 250 * smoothstep(km, 26, 31);                  // climb 2: 5 km @ ~5 %
    e -= 280 * smoothstep(km, 32, 37);                  // long descent home
    return e;
  };
  for (let i = 0; i <= n; i++) {
    const km = (i * stepM) / 1000;
    const heading = 0.6 + 0.5 * Math.sin(km * 0.35);
    lat += (stepM * Math.cos(heading)) / 111320;
    lon += (stepM * Math.sin(heading)) / (111320 * Math.cos((lat * Math.PI) / 180));
    pts.push(`<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"><ele>${eleAtKm(km).toFixed(1)}</ele></trkpt>`);
  }
  return `<?xml version="1.0"?><gpx version="1.1" creator="demo"><trk><name>Demo-rute</name><trkseg>${pts.join('')}</trkseg></trk></gpx>`;
}
function smoothstep(x, a, b) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function demoZwo() {
  return `<?xml version="1.0"?>
<workout_file><name>4 × 8 min terskel</name><workout>
  <Warmup Duration="720" PowerLow="0.45" PowerHigh="0.70"/>
  <IntervalsT Repeat="4" OnDuration="480" OnPower="1.0" OffDuration="300" OffPower="0.45"/>
  <Cooldown Duration="480" PowerLow="0.65" PowerHigh="0.45"/>
</workout></workout_file>`;
}

/* ============================================================
   UI
   ============================================================ */

if (typeof document !== 'undefined') {
  const state = { workoutSteps: null, route: null, map: null, mapLayers: [] };
  const $ = (id) => document.getElementById(id);

  function setStatus(msg, isError) {
    const el = $('status');
    el.textContent = msg || '';
    el.classList.toggle('err', !!isError);
  }
  function updateButton() {
    $('optimizeBtn').disabled = !(state.workoutSteps && state.route);
  }

  $('workoutFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const ftp = parseFloat($('ftp').value) || 250;
      const isFit = file.name.toLowerCase().endsWith('.fit');
      const content = isFit ? await file.arrayBuffer() : await file.text();
      state.workoutSteps = parseWorkoutFile(file.name, content, ftp);
      const total = state.workoutSteps.reduce((a, s) => a + (s.durationSec || 0), 0);
      $('workoutOk').textContent = `✓ ${file.name} — ${state.workoutSteps.length} steg${total ? ', ' + fmtTime(total) : ''}`;
      $('workoutOk').style.display = 'block';
      setStatus('');
    } catch (err) {
      state.workoutSteps = null;
      $('workoutOk').style.display = 'none';
      setStatus(err.message, true);
    }
    updateButton();
  });

  $('gpxFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      state.route = buildRouteFromPoints(parseGPX(await file.text()));
      const climb = totalClimb(state.route);
      $('gpxOk').textContent = `✓ ${file.name} — ${fmtKm(state.route.totalDist)}, ${Math.round(climb)} hm`;
      $('gpxOk').style.display = 'block';
      setStatus('');
    } catch (err) {
      state.route = null;
      $('gpxOk').style.display = 'none';
      setStatus(err.message, true);
    }
    updateButton();
  });

  $('demoBtn').addEventListener('click', () => {
    state.workoutSteps = parseZwo(demoZwo());
    state.route = buildRouteFromPoints(parseGPX(demoGpx()));
    $('workoutOk').textContent = '✓ Eksempel: 4 × 8 min terskel';
    $('workoutOk').style.display = 'block';
    $('gpxOk').textContent = `✓ Eksempelrute — ${fmtKm(state.route.totalDist)}, ${Math.round(totalClimb(state.route))} hm`;
    $('gpxOk').style.display = 'block';
    $('commuteStart').value = 3;
    $('commuteEnd').value = 2;
    setStatus('Eksempeldata lastet — trykk «Finn optimal start».');
    updateButton();
  });

  $('optimizeBtn').addEventListener('click', () => {
    try {
      setStatus('Beregner …');
      const speed = parseFloat($('speed').value);
      if (!speed || speed <= 0) throw new Error('Oppgi en gyldig gjennomsnittsfart.');
      const speedMs = speed / 3.6;
      const csM = (parseFloat($('commuteStart').value) || 0) * 1000;
      const ceM = (parseFloat($('commuteEnd').value) || 0) * 1000;
      const result = optimize(state.route, state.workoutSteps, speedMs, csM, ceM);
      render(result, { speedMs, csM, ceM });
      setStatus('');
    } catch (err) {
      setStatus(err.message, true);
      $('results').style.display = 'none';
    }
  });

  function totalClimb(route) {
    let c = 0;
    for (let i = 1; i < route.n; i++) c += Math.max(0, route.ele[i] - route.ele[i - 1]);
    return c;
  }

  /* ---------- rendering ---------- */

  function render(result, opts) {
    $('results').style.display = 'block';
    renderSummary(result, opts);
    renderMap(result, opts);
    renderTimeline(result, opts);
    renderTable(result);
    $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderSummary(result, { speedMs, ceM }) {
    const route = state.route;
    const stretched = result.segments.filter((s) => s.stretchSec > 0.5);
    const planned = result.segments.reduce((a, s) => a + s.plannedSec, 0);
    const rideToStart = result.startDist / speedMs;
    const margin = route.totalDist - ceM - result.endDist;
    const cards = [
      [fmtKm(result.startDist), `Økten starter her — ca. ${fmtTime(rideToStart)} sykling fra rutestart`],
      [fmtKm(result.endDist), `Økten er ferdig her — ${fmtKm(margin)} margin til pendlersonen`],
      ['+' + fmtTime(result.addedRestSec), `Ekstra hviletid totalt — ${stretched.length} pause${stretched.length === 1 ? '' : 'r'} forlenget`],
      [fmtTime(planned + result.addedRestSec), `Justert varighet (planlagt ${fmtTime(planned)})`],
    ];
    $('summaryGrid').innerHTML = cards
      .map(([v, l]) => `<div class="stat"><div class="v">${v}</div><div class="l">${l}</div></div>`)
      .join('');
    $('summaryNote').textContent = stretched.length
      ? 'Forlengede pauser: ' + stretched.map((s) => `${s.name || 'pause'} (+${fmtTime(s.stretchSec)})`).join(', ')
      : 'Ingen pauser ble forlenget — alle pauser slutter allerede på flatt eller stigende terreng.';
  }

  function renderMap(result, { csM, ceM }) {
    const route = state.route;
    if (!state.map) {
      state.map = L.map('map');
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap',
      }).addTo(state.map);
    }
    state.mapLayers.forEach((l) => state.map.removeLayer(l));
    state.mapLayers = [];
    const add = (layer) => { layer.addTo(state.map); state.mapLayers.push(layer); return layer; };

    const full = latLngsBetween(route, 0, route.totalDist);
    add(L.polyline(full, { color: '#b9b2a0', weight: 4, opacity: 0.8 }));

    if (csM > 0) add(L.polyline(latLngsBetween(route, 0, csM), { color: '#55524a', weight: 6, opacity: 0.85, dashArray: '2 8' }))
      .bindTooltip('Pendlersone (start)');
    if (ceM > 0) add(L.polyline(latLngsBetween(route, route.totalDist - ceM, route.totalDist), { color: '#55524a', weight: 6, opacity: 0.85, dashArray: '2 8' }))
      .bindTooltip('Pendlersone (slutt)');

    for (const seg of result.segments) {
      const line = add(L.polyline(latLngsBetween(route, seg.startDist, seg.endDist), {
        color: kindColor(seg.kind, seg.intensity), weight: 7, opacity: 0.95,
      }));
      line.bindTooltip(
        `${kindLabel(seg.kind)} — ${Math.round(seg.intensity * 100)} % FTP, ${fmtTime(seg.adjustedSec)}` +
        (seg.stretchSec > 0.5 ? ` (forlenget +${fmtTime(seg.stretchSec)})` : '')
      );
    }

    add(L.circleMarker(latLngAt(route, result.startDist), { radius: 9, color: '#fff', weight: 2, fillColor: '#2a4a3d', fillOpacity: 1 }))
      .bindTooltip('Start på økten', { permanent: true, direction: 'top', offset: [0, -10] });
    add(L.circleMarker(latLngAt(route, result.endDist), { radius: 9, color: '#fff', weight: 2, fillColor: '#ac4f2c', fillOpacity: 1 }))
      .bindTooltip('Slutt på økten', { direction: 'top' });

    state.map.fitBounds(L.latLngBounds(full), { padding: [24, 24] });

    const kinds = [...new Set(result.segments.map((s) => s.kind))];
    $('legend').innerHTML =
      kinds.map((k) => `<span><i class="sw" style="background:${kindColor(k, 1)}"></i>${kindLabel(k)}</span>`).join('') +
      `<span><i class="sw" style="background:#55524a"></i>Pendlersone</span>` +
      `<span><i class="sw" style="background:#b9b2a0"></i>Rute uten økt</span>`;
  }

  function renderTimeline(result, { speedMs, csM, ceM }) {
    const route = state.route;
    const svg = $('timeline');
    const W = 1100, H = 320, mL = 46, mR = 14, mT = 56, mB = 34;
    const plotW = W - mL - mR, plotH = H - mT - mB;
    const x = (d) => mL + (d / route.totalDist) * plotW;

    let eMin = Infinity, eMax = -Infinity;
    for (let i = 0; i < route.n; i++) { eMin = Math.min(eMin, route.ele[i]); eMax = Math.max(eMax, route.ele[i]); }
    const ePad = Math.max(10, (eMax - eMin) * 0.08);
    eMin -= ePad; eMax += ePad;
    const y = (e) => mT + plotH - ((e - eMin) / (eMax - eMin)) * plotH;

    const parts = [];
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

    // elevation profile fill helper for a distance range
    const profilePath = (d0, d1) => {
      const i0 = routeIndexAt(route, d0), i1 = routeIndexAt(route, d1);
      const stepIdx = Math.max(1, Math.floor((i1 - i0) / 400));
      let p = `M ${x(i0 * route.step).toFixed(1)} ${(mT + plotH).toFixed(1)}`;
      for (let i = i0; i <= i1; i += stepIdx) p += ` L ${x(i * route.step).toFixed(1)} ${y(route.ele[i]).toFixed(1)}`;
      p += ` L ${x(i1 * route.step).toFixed(1)} ${y(route.ele[i1]).toFixed(1)}`;
      p += ` L ${x(i1 * route.step).toFixed(1)} ${(mT + plotH).toFixed(1)} Z`;
      return p;
    };

    // base profile
    parts.push(`<path d="${profilePath(0, route.totalDist)}" fill="#d9d2c0" stroke="#a89f8a" stroke-width="1"/>`);

    // commute zones (hatched)
    parts.push(`<defs><pattern id="hatch" width="7" height="7" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
      <rect width="7" height="7" fill="rgba(85,82,74,.12)"/><line x1="0" y1="0" x2="0" y2="7" stroke="rgba(85,82,74,.5)" stroke-width="2"/></pattern></defs>`);
    if (csM > 0) parts.push(`<rect x="${x(0)}" y="${mT}" width="${x(csM) - x(0)}" height="${plotH}" fill="url(#hatch)"/>`);
    if (ceM > 0) parts.push(`<rect x="${x(route.totalDist - ceM)}" y="${mT}" width="${x(route.totalDist) - x(route.totalDist - ceM)}" height="${plotH}" fill="url(#hatch)"/>`);

    // coloured profile per interval + band row on top
    for (const seg of result.segments) {
      const c = kindColor(seg.kind, seg.intensity);
      parts.push(`<path d="${profilePath(seg.startDist, seg.endDist)}" fill="${c}" fill-opacity="0.55" stroke="${c}" stroke-width="1.5"/>`);
      const bx = x(seg.startDist), bw = Math.max(1.5, x(seg.endDist) - bx);
      const dash = seg.stretchSec > 0.5 ? ' stroke-dasharray="4 3" stroke="#1d3a8f" stroke-width="2"' : ` stroke="${c}"`;
      parts.push(`<rect x="${bx.toFixed(1)}" y="${mT - 26}" width="${bw.toFixed(1)}" height="18" rx="3" fill="${c}"${dash}><title>${esc(kindLabel(seg.kind))} ${fmtTime(seg.adjustedSec)}${seg.stretchSec > 0.5 ? ' (+' + fmtTime(seg.stretchSec) + ')' : ''}</title></rect>`);
    }

    // workout time ticks every 15 min along the band row
    const wStart = result.startDist;
    const totalSec = (result.endDist - wStart) / speedMs;
    for (let t = 0; t <= totalSec; t += 900) {
      const d = wStart + t * speedMs;
      parts.push(`<line x1="${x(d)}" y1="${mT - 30}" x2="${x(d)}" y2="${mT - 6}" stroke="#615d50" stroke-width="1"/>`);
      parts.push(`<text x="${x(d)}" y="${mT - 34}" font-size="10" fill="#615d50" text-anchor="middle">${fmtTime(t)}</text>`);
    }
    parts.push(`<text x="${x(wStart)}" y="${mT - 46}" font-size="11" font-weight="700" fill="#2a4a3d" text-anchor="start">Økt-tid →</text>`);

    // axes: km along bottom, metres on left
    const kmStep = route.totalDist > 40000 ? 10000 : route.totalDist > 15000 ? 5000 : 2000;
    for (let d = 0; d <= route.totalDist; d += kmStep) {
      parts.push(`<line x1="${x(d)}" y1="${mT + plotH}" x2="${x(d)}" y2="${mT + plotH + 5}" stroke="#8c8676"/>`);
      parts.push(`<text x="${x(d)}" y="${mT + plotH + 18}" font-size="11" fill="#615d50" text-anchor="middle">${(d / 1000).toFixed(0)} km</text>`);
    }
    const eStep = eMax - eMin > 400 ? 200 : eMax - eMin > 150 ? 100 : 50;
    for (let e = Math.ceil(eMin / eStep) * eStep; e <= eMax; e += eStep) {
      parts.push(`<line x1="${mL}" y1="${y(e)}" x2="${W - mR}" y2="${y(e)}" stroke="rgba(140,134,118,.25)"/>`);
      parts.push(`<text x="${mL - 6}" y="${y(e) + 4}" font-size="11" fill="#615d50" text-anchor="end">${e.toFixed(0)} m</text>`);
    }

    // start/end markers
    for (const [d, label, color] of [[result.startDist, 'Start', '#2a4a3d'], [result.endDist, 'Slutt', '#ac4f2c']]) {
      parts.push(`<line x1="${x(d)}" y1="${mT - 4}" x2="${x(d)}" y2="${mT + plotH}" stroke="${color}" stroke-width="2" stroke-dasharray="5 4"/>`);
      parts.push(`<text x="${x(d) + 4}" y="${mT + 12}" font-size="11" font-weight="700" fill="${color}">${label}</text>`);
    }

    svg.innerHTML = parts.join('');
  }

  function renderTable(result) {
    $('intervalRows').innerHTML = result.segments
      .map((seg) => {
        const c = kindColor(seg.kind, seg.intensity);
        const note = seg.stretchSec > 0.5
          ? `<span class="plus">+${fmtTime(seg.stretchSec)}</span> — forlenget for å fullføre nedkjøring`
          : '';
        return `<tr class="${seg.stretchSec > 0.5 ? 'stretched' : ''}">
          <td class="num">${seg.index + 1}</td>
          <td><span class="pill" style="background:${c}">${kindLabel(seg.kind)}</span></td>
          <td class="num">${Math.round(seg.intensity * 100)} %</td>
          <td class="num">${fmtTime(seg.plannedSec)}</td>
          <td class="num">${fmtTime(seg.adjustedSec)}</td>
          <td class="num">${(seg.startDist / 1000).toFixed(1)}–${(seg.endDist / 1000).toFixed(1)}</td>
          <td class="num">${fmtPct(seg.avgGrade)}</td>
          <td>${note}</td>
        </tr>`;
      })
      .join('');
  }
}

/* Node export for tests */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    haversine, buildRouteFromPoints, gradeAt, eleAt,
    classifyIntensity, parseErgMrc, parseFit, fitStepsToWorkout,
    resolveDurations, simulatePlacement, scorePlacement, optimize,
    fmtTime, smoothstep,
  };
}
