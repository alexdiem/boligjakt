# Terrengøkt

Workout route optimizer: aligns a structured training plan with real-world terrain.

Upload a structured workout (Garmin `.fit`, Zwift `.zwo`, TrainerRoad `.erg`/`.mrc`) and a GPX
route, enter your average speed, and the app finds the optimal place on the route to start the
workout — so hard intervals land on climbs and rest intervals align with descents or flats.

- **Rest stretching** — rest intervals may be extended by up to +50 % of their planned duration
  so the rider can finish a descent naturally before the next effort.
- **Commute zones** — mark a traffic zone at the start (the workout may not begin inside it)
  and at the end (the workout must be fully complete before it begins).
- **UI** — Leaflet map with color-coded intervals, a timeline view of the adjusted schedule
  against the elevation profile, and a summary of start point, added rest, and affected intervals.

Everything runs client-side; no files leave the browser. UI text is Norwegian (bokmål).

## Files

- `index.html` — markup and styles
- `app.js` — GPX/workout parsers (including a minimal FIT decoder), optimizer, and rendering
- `test.cjs` — Node sanity tests: `node test.cjs`

Open `index.html` via any static server (it is deployed with the rest of this repo on Vercel
at `/treningsrute/`). The «Prøv med eksempeldata» button loads a demo route and workout.
