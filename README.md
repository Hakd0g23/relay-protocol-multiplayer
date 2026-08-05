# Relay Protocol

A multiplayer bomb-defusal prototype about relaying information under constraints. No dependencies — plain Node.js `http` module on the server, plain HTML/CSS/JS on the client, synced over Server-Sent Events (SSE).

## Roles

Same core split as Keep Talking and Nobody Explodes: one person sees the bomb, the other(s) hold the manual. Nobody can solve it alone.

**2 players**
- **Operator** — sees the whole bomb, every color, every module. Has no manual. Acts on the Specialist's instructions.
- **Specialist** — has the manual (the rule) for every module, but never sees the bomb itself. Sends free-text instructions to the Operator.

**3 players**
- **Operator** — same as above, sees both active modules in full.
- **Specialist (Module A)** and **Specialist (Module B)** — each holds the manual for exactly one of the two active modules, and is blind to the other's. The Operator has to run two relay channels at once instead of one.

The server never sends a role information it isn't entitled to see (each SSE connection gets a role-filtered view, not the full room state).

Each round mounts 2 modules on 2 random distinct faces of the same cube, picked from:

- **Wire Cut** — a row of 5-8 wires; cut the set/order described by the rule (exact order, color grouping, color exclusion, position parity, shape pairing, or a KTANE-style **manual lookup**: a raw conditional decision tree plus a shared "bomb key" the Specialist has to evaluate themselves against the panel, not a resolved answer).
- **Handshake Grid** — a 3x3 or 4x4 grid of nodes; press the set described by the rule (a row, column, diagonal, color group, or matching shape pair).
- **Frequency Lock** — a rotary dial with a visible channel key; tune the needle into the target band (the key's parity decides which half of the dial to aim for) and lock it in.
- **Signal Decode** — a flashed sequence of colored signals the Operator watches (no manual); press the translated-color button for each one in order, using whichever of two printed lookup tables the bomb key selects.
- **Password Lock** — a row of letter reels; spin each to spell the correct password, chosen from a printed candidate list via a decision tree keyed off the bomb key.

Both modules must be solved to win. The Operator gets a single rotatable 3D cube with both modules mounted on their assigned faces, in full color — they have to rotate to find the second one, like a real multi-module bomb. A real accessible control (hidden button, or a visible slider for the dial) always exists per module alongside the 3D view, so the game is fully playable by keyboard/screen reader too.

Every module shares the same failure pressure: a synced countdown and a **containment spread meter** instead of flat strikes. Each wrong action adds 14-21% spread and docks 8 seconds off the clock; hitting 100% is a "quarantine breach" (loss). Once spread crosses 50%, the ruleset shifts once — an extra wire/node gets added to the target set, a wire sequence reverses, or the frequency band drifts — visible immediately to whichever Specialist holds that module's manual, felt by the Operator only as a suddenly-harder puzzle.

Difficulty escalates with each win in a room: wire/grid size grows, the timer shrinks toward a 60s floor, and more demanding variants unlock from round 3 onward. A loss resets the room back to round 1.

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
- Wire/node shapes are distinguished by SVG glyph, not color alone, everywhere they appear.

## Assets

- Fonts: "Baloo 2" (headers/timer) and "Nunito" (body) via Google Fonts (SIL Open Font License).
- Panel/casing colors are a warm cream + gumball-bright palette (CSS custom properties, hand-tuned), replacing the earlier dark industrial theme.
- Bolt/rivet panel accents are hand-authored CSS (radial-gradient pseudo-elements), not an image asset.

## Known limitations

- Room state is in-memory only — a server restart clears all active rooms.
- No persistence/accounts; room codes are the only join mechanism.
- The Specialist "manual" is a full visual copy of the panel plus rule text, not a real verbal-description-only channel (a deliberate simplification — the actual info split that matters is who can act vs. who knows the rule, not who can see what).
