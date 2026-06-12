/* Node sanity tests for the Terrengøkt logic: run with `node test.cjs` */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const code = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const sandbox = { module: { exports: {} }, console };
vm.runInNewContext(code, sandbox);
const app = sandbox.module.exports;

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`ok   ${name}`);
  else { failures++; console.error(`FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

/* ---------- synthetic route: 30 km, flat → climb → descent → flat ---------- */
function syntheticPoints() {
  const pts = [];
  let lat = 60.0, lon = 10.0;
  const stepM = 50, n = 600; // 30 km
  for (let i = 0; i <= n; i++) {
    const km = (i * stepM) / 1000;
    let ele = 100;
    if (km > 8 && km <= 13) ele += (km - 8) * 50;        // 5 km climb @ 5 %
    else if (km > 13 && km <= 17) ele += 250 - (km - 13) * 62.5; // 4 km descent
    else if (km > 17) ele += 0;
    lat += stepM / 111320;
    pts.push({ lat, lon, ele });
  }
  return pts;
}

const route = app.buildRouteFromPoints(syntheticPoints());
check('route length ~30 km', Math.abs(route.totalDist - 30000) < 200, `got ${route.totalDist}`);
check('grade on climb ~5 %', Math.abs(app.gradeAt(route, 10000) - 5) < 1, `got ${app.gradeAt(route, 10000)}`);
check('grade on descent ~-6 %', app.gradeAt(route, 15000) < -4, `got ${app.gradeAt(route, 15000)}`);
check('grade on flat ~0 %', Math.abs(app.gradeAt(route, 25000)) < 0.5, `got ${app.gradeAt(route, 25000)}`);

/* ---------- ERG parsing ---------- */
const erg = `[COURSE HEADER]
FTP = 200
MINUTES WATTS
[END COURSE HEADER]
[COURSE DATA]
0\t100
10\t100
10\t250
14\t250
14\t100
18\t100
[END COURSE DATA]`;
const ergSteps = app.parseErgMrc(erg, 250);
check('erg: 3 steps', ergSteps.length === 3, `got ${ergSteps.length}`);
check('erg: middle step is work @125 %', ergSteps[1].kind === 'work' && Math.abs(ergSteps[1].intensity - 1.25) < 0.01,
  JSON.stringify(ergSteps[1]));
check('erg: first step low intensity', ergSteps[0].intensity === 0.5, JSON.stringify(ergSteps[0]));

/* ---------- FIT round-trip: encode a minimal workout file, then parse it ---------- */
function encodeFitWorkout(steps) {
  const bytes = [];
  const u8 = (v) => bytes.push(v & 0xff);
  const u16 = (v) => { u8(v); u8(v >> 8); };
  const u32 = (v) => { u8(v); u8(v >> 8); u8(v >> 16); u8(v >> 24); };

  // definition message for workout_step (global 27), local type 0, little-endian
  u8(0x40); u8(0); u8(0); u16(27); u8(8);
  const fields = [[254, 2, 0x84], [1, 1, 0x00], [2, 4, 0x86], [3, 1, 0x00], [4, 4, 0x86], [5, 4, 0x86], [6, 4, 0x86], [7, 1, 0x00]];
  for (const [num, size, bt] of fields) { u8(num); u8(size); u8(bt); }

  steps.forEach((s, i) => {
    u8(0x00); // data message, local type 0
    u16(i);
    u8(s.durationType); u32(s.durationValue);
    u8(s.targetType ?? 2); u32(s.targetValue ?? 0);
    u32(s.customLow ?? 0); u32(s.customHigh ?? 0);
    u8(s.intensity ?? 0);
  });

  const data = Uint8Array.from(bytes);
  const buf = new Uint8Array(14 + data.length + 2);
  const dv = new DataView(buf.buffer);
  dv.setUint8(0, 14); dv.setUint8(1, 0x20); dv.setUint16(2, 2156, true);
  dv.setUint32(4, data.length, true);
  buf.set([0x2e, 0x46, 0x49, 0x54], 8); // ".FIT"
  buf.set(data, 14);
  return buf.buffer;
}

// warmup 10 min, then 3 × (5 min @ 105 % FTP / 3 min rest), cooldown 10 min
const fitBuf = encodeFitWorkout([
  { durationType: 0, durationValue: 600000, intensity: 2 },
  { durationType: 0, durationValue: 300000, targetType: 4, targetValue: 0, customLow: 100, customHigh: 110, intensity: 0 },
  { durationType: 0, durationValue: 180000, intensity: 1 },
  { durationType: 6, durationValue: 1, targetType: 2, targetValue: 3 }, // repeat steps 1–2, 3 times total
  { durationType: 0, durationValue: 600000, intensity: 3 },
]);
const fitSteps = app.parseFit(fitBuf, 250);
check('fit: expanded to 8 steps (warmup + 3×2 + cooldown)', fitSteps.length === 8, `got ${fitSteps.length}`);
check('fit: warmup first', fitSteps[0].kind === 'warmup', fitSteps[0].kind);
check('fit: work intensity 105 %', Math.abs(fitSteps[1].intensity - 1.05) < 0.01, `${fitSteps[1].intensity}`);
check('fit: rest steps classified', fitSteps[2].kind === 'rest' && fitSteps[4].kind === 'rest' && fitSteps[6].kind === 'rest');
check('fit: cooldown last', fitSteps[7].kind === 'cooldown', fitSteps[7].kind);
check('fit: durations in seconds', fitSteps[0].durationSec === 600 && fitSteps[1].durationSec === 300);

/* ---------- optimizer ---------- */
const speedMs = 28 / 3.6;
const best = app.optimize(route, fitSteps, speedMs, 2000, 2000);
check('optimize: respects start commute zone', best.startDist >= 2000, `start ${best.startDist}`);
check('optimize: ends before end commute zone', best.endDist <= route.totalDist - 2000, `end ${best.endDist}`);

// hard intervals should land predominantly on the climb (8–13 km) rather than the descent
const workSegs = best.segments.filter((s) => s.kind === 'work');
const avgWorkGrade = workSegs.reduce((a, s) => a + s.avgGrade, 0) / workSegs.length;
check('optimize: work intervals favour climbs (avg grade > 0)', avgWorkGrade > 0.5, `avg work grade ${avgWorkGrade.toFixed(2)}`);

// rest stretching: rests are only ever extended, never shortened, ≤ +50 %
for (const seg of best.segments) {
  if (seg.kind === 'rest') {
    check(`rest ${seg.index}: stretch within [0, +50 %]`,
      seg.stretchSec >= 0 && seg.adjustedSec <= seg.plannedSec * 1.5 + 0.01,
      `planned ${seg.plannedSec}, adjusted ${seg.adjustedSec}`);
  } else {
    check(`non-rest ${seg.index}: unchanged duration`, seg.stretchSec === 0);
  }
}
check('optimize: addedRestSec matches segment stretches',
  Math.abs(best.addedRestSec - best.segments.reduce((a, s) => a + s.stretchSec, 0)) < 0.01);

// no valid placement when commute zones leave too little room → must throw
let threw = false;
try { app.optimize(route, fitSteps, speedMs, 14000, 14000); } catch (e) { threw = true; }
check('optimize: throws when workout cannot fit', threw);

// a rest that ends mid-descent gets stretched: force start so a rest lands on the descent
const placed = app.simulatePlacement(route, app.resolveDurations(fitSteps, speedMs), 6000, speedMs);
check('simulate: placement valid from 6 km', !!placed);

console.log(failures ? `\n${failures} test(s) failed` : '\nAll tests passed');
process.exit(failures ? 1 : 0);
