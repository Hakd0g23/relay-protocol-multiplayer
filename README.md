# Relay Protocol

A multiplayer bomb-defusal prototype about relaying information under constraints. No dependencies — plain Node.js `http` module on the server, plain HTML/CSS/JS on the client, synced over Server-Sent Events (SSE).

## Roles

**2 players**
- **Blind Bomb Operator** — sees wire shapes in grayscale only (no color). Cuts wires based on instructions from the Relay Specialist.
- **Relay Specialist** — sees the full color-coded wire panel and the defusal rule, and sends free-text instructions to the Operator.

**3 players**
- **Blind Bomb Operator** — same as above.
- **Mute Clue Reader** — sees the full panel and rule but can only send fixed symbols, no free text.
- **Deaf Interpreter** — cannot see the color panel or rule; reads the incoming symbol stream and writes plain-text instructions for the Operator.

Each role has a genuine information constraint and a genuine piece of expertise the others need — nobody can solve the bomb alone. The server never sends a role information it isn't entitled to see (each SSE connection gets a role-filtered view, not the full room state).

Puzzles are randomized per round across five variants (exact cut order, color grouping, color exclusion, position parity, shape pairing), with a synced countdown and a 3-strike limit. Difficulty escalates with each win in a room: wire count grows from 5 up to 8, the timer shrinks from 90s down to a 60s floor, and the two more demanding variants (position parity, color exclusion) only enter the pool from round 3 onward. A loss resets the room back to round 1.

## Run locally

```
npm start
```

Then open `http://localhost:3000` in two or three separate browser windows/tabs (or devices on the same network). Enter the same room code in each window to join together, pick distinct roles, and start the bomb once every role is filled.

## Deploy to Render

This repo includes a `render.yaml` Blueprint.

1. Push this repo to GitHub.
2. In Render, choose **New > Blueprint** and point it at the GitHub repo (or **New > Web Service** and select the repo directly — Render will detect `npm start`).
3. Render builds with `npm install` and starts with `npm start`. No environment variables or database are required.
4. Once deployed, open the public HTTPS URL in separate browser tabs/devices to test a 2-player and a 3-player room.

## Accessibility

- Semantic buttons/labels/fieldsets/legends throughout; live regions announce instructions, timer, and win/lose state.
- Full keyboard operability — every action is a real `<button>` or form control.
- High-contrast dark theme; `prefers-contrast: more` gets stronger border contrast.
- `prefers-reduced-motion: reduce` collapses all transitions/animations.
- Wire shapes are distinguished by SVG glyph, not color alone, everywhere they appear.

## Assets

- `assets/metal-panel.jpg` — a downscaled crop of ambientCG's "Metal006" material (CC0, no attribution required). https://ambientcg.com/a/Metal006
- Font: "Share Tech Mono" via Google Fonts (SIL Open Font License).
- Bolt/rivet panel accents are hand-authored CSS (radial-gradient pseudo-elements), not an image asset.

## Known limitations

- Room state is in-memory only — a server restart clears all active rooms.
- No persistence/accounts; room codes are the only join mechanism.
- No audio; the "Deaf"/"Mute" role constraints are simulated by UI restrictions (no text field vs. no color panel), not actual audio muting.
