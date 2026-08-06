const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const TIMER_SECONDS = 90;
const WIRE_COUNT = 5;
const SHAPES = ['circle', 'triangle', 'square', 'diamond', 'star'];
const COLORS = ['red', 'blue', 'yellow', 'green', 'purple'];

// Real KTANE structure: the Operator sees the whole bomb (every color,
// every module) but has no manual. Specialists hold the manual (the rule)
// but never see the bomb itself. In 3-player mode the two active modules
// split across two specialists, each blind to the other's module — the
// Operator has to run two relay channels at once instead of one.
const ROLE_SETS = {
  2: ['operator', 'specialist'],
  3: ['operator', 'specialist_1', 'specialist_2'],
};

/** @type {Map<string, Room>} */
const rooms = new Map();

function newId(len = 8) {
  return crypto.randomBytes(len).toString('hex');
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ---- Puzzle generation ----------------------------------------------------

const MAX_WIRE_COUNT = 8;
const MIN_TIMER_SECONDS = 75;
const LOOKUP_TIME_BONUS = 15; // extra seconds per manual-lookup module — those take real decode time
const CONTAINMENT_THRESHOLD = 50; // spread % at which the ruleset shifts once

// Difficulty is a per-room setting chosen at creation (like mode/playStyle).
// ROUND_OFFSET reuses every existing round-scaling formula above by shifting
// the round number fed into it — Easy plays like a room that's behind where
// it "should" be, Hard like one that's further ahead. PENALTY_MULT scales
// how much a wrong action actually costs.
const DIFFICULTIES = ['easy', 'medium', 'hard'];
const DIFFICULTY_ROUND_OFFSET = { easy: -3, medium: 0, hard: 5 };
const DIFFICULTY_PENALTY_MULT = { easy: 0.7, medium: 1, hard: 1.35 };

function effectiveRound(room) {
  return room.round + (DIFFICULTY_ROUND_OFFSET[room.difficulty] || 0);
}

// Difficulty scales with round number: more wires, a shorter clock, and a
// wider variant pool unlock as the room clears more bombs in a row.
// Difficulty mode shifts the round number fed into every one of these
// formulas (see DIFFICULTY_ROUND_OFFSET below), which can push it negative
// for Easy — clamp each formula's own range rather than the round itself,
// so Easy round 1 is actually easier than normal round 1, not just "normal
// round 1 minus growth that was already floored away."
function wireCountForRound(round) {
  return Math.max(4, Math.min(WIRE_COUNT + Math.floor((round - 1) / 2), MAX_WIRE_COUNT));
}

function timerForRound(round) {
  return Math.min(Math.max(TIMER_SECONDS - (round - 1) * 3, MIN_TIMER_SECONDS), 150);
}

function variantPoolForRound(round) {
  const pool = ['sequence', 'color_group', 'shape_pair', 'manual_lookup'];
  if (round >= 3) pool.push('position_parity', 'color_exclusion');
  return pool;
}

function makeWires(count, forceShapePair) {
  const shapes = [];
  if (forceShapePair) {
    // Guarantee exactly one shape appears twice, so a "matching pair" puzzle is solvable.
    const pairShape = pick(SHAPES);
    shapes.push(pairShape, pairShape);
    const others = shuffle(SHAPES.filter((s) => s !== pairShape));
    while (shapes.length < count) shapes.push(others[(shapes.length - 2) % others.length]);
    shuffle(shapes).forEach((s, i) => (shapes[i] = s));
  } else {
    for (let i = 0; i < count; i++) shapes.push(pick(SHAPES));
  }
  const colors = [];
  for (let i = 0; i < count; i++) colors.push(pick(COLORS));
  return shapes.map((shape, i) => ({
    id: `w${i}`,
    position: i,
    shape,
    color: colors[i],
    cut: false,
  }));
}

// KTANE-style decision tree: sighted roles get the RAW conditional logic
// plus the shared bomb key, not a resolved answer — they have to evaluate
// it themselves against the actual wire panel, same as the real manual.
function resolveManualLookup(wires, bombKey) {
  const lastDigitMatch = bombKey.match(/\d(?!.*\d)/);
  const lastDigit = lastDigitMatch ? parseInt(lastDigitMatch[0], 10) : 0;
  const odd = lastDigit % 2 === 1;
  const last = wires[wires.length - 1];
  const redCount = wires.filter((w) => w.color === 'red').length;
  const blueWires = wires.filter((w) => w.color === 'blue');

  const steps = [
    '1. If there are NO red wires, cut the SECOND wire.',
    '2. Else if the LAST wire is yellow, cut the LAST wire.',
    '3. Else if there is more than one blue wire, cut the LAST blue wire.',
    `4. Else if the bomb key's last digit is ODD, cut the LAST wire.`,
    '5. Otherwise, cut the SECOND wire.',
  ];

  let target;
  if (redCount === 0) target = wires[1] || wires[0];
  else if (last.color === 'yellow') target = last;
  else if (blueWires.length > 1) target = blueWires[blueWires.length - 1];
  else if (odd) target = last;
  else target = wires[1] || wires[0];

  return { target, steps };
}

function generateWireCutModule(round = 1, bombKey = 'AAAAAA') {
  const wireCount = wireCountForRound(round);
  const variant = pick(variantPoolForRound(round));
  const wires = makeWires(wireCount, variant === 'shape_pair');
  const totalWires = wires.length;

  if (variant === 'manual_lookup') {
    const { target, steps } = resolveManualLookup(wires, bombKey);
    return {
      moduleType: 'wire_cut',
      variant,
      wires,
      ruleText: `MANUAL LOOKUP — bomb key ${bombKey}. Work out the target wire yourself from this decision tree, checked in order (first match wins):\n${steps.join(' ')}`,
      requiredFirst: [target.id],
      exactSet: true,
      totalWires,
    };
  }

  if (variant === 'sequence') {
    const order = shuffle(wires.map((w) => w.id));
    const desc = order
      .map((id) => wires.find((w) => w.id === id))
      .map((w) => `#${w.position + 1} (${w.color} ${w.shape})`)
      .join(' -> ');
    return {
      moduleType: 'wire_cut',
      variant,
      wires,
      ruleText: `Cut wires in this exact order: ${desc}.`,
      solutionOrder: order,
      totalWires,
    };
  }

  if (variant === 'color_group') {
    const targetColor = pick([...new Set(wires.map((w) => w.color))]);
    const group = wires.filter((w) => w.color === targetColor).map((w) => w.id);
    return {
      moduleType: 'wire_cut',
      variant,
      wires,
      ruleText: `Cut every ${targetColor.toUpperCase()} wire (any order among them). Leave every other wire untouched.`,
      requiredFirst: group,
      exactSet: true,
      totalWires,
    };
  }

  if (variant === 'shape_pair') {
    const shapeCounts = {};
    wires.forEach((w) => (shapeCounts[w.shape] = (shapeCounts[w.shape] || 0) + 1));
    const pairShape = Object.keys(shapeCounts).find((s) => shapeCounts[s] >= 2) || wires[0].shape;
    const pairWires = wires.filter((w) => w.shape === pairShape).map((w) => w.id);
    return {
      moduleType: 'wire_cut',
      variant,
      wires,
      ruleText: `Find the two wires that share the same shape (${pairShape.toUpperCase()}) and cut only those two. Leave the rest untouched.`,
      requiredFirst: pairWires,
      exactSet: true,
      totalWires,
    };
  }

  if (variant === 'position_parity') {
    const parity = pick(['even', 'odd']);
    const group = wires
      .filter((w) => (w.position + 1) % 2 === (parity === 'even' ? 0 : 1))
      .map((w) => w.id);
    return {
      moduleType: 'wire_cut',
      variant,
      wires,
      ruleText: `Cut every wire at an ${parity.toUpperCase()}-numbered position (any order among them). Leave the other positions untouched.`,
      requiredFirst: group,
      exactSet: true,
      totalWires,
    };
  }

  // color_exclusion
  const excludedColor = pick([...new Set(wires.map((w) => w.color))]);
  const group = wires.filter((w) => w.color !== excludedColor).map((w) => w.id);
  return {
    moduleType: 'wire_cut',
    variant,
    wires,
    ruleText: `Cut every wire EXCEPT the ${excludedColor.toUpperCase()} ones (any order). Leave ${excludedColor.toUpperCase()} wires untouched.`,
    requiredFirst: group,
    exactSet: true,
    totalWires,
  };
}

// ---- Handshake Sequence: a grid of nodes instead of a row of wires --------

function gridSizeForRound(round) {
  return round >= 3 ? 4 : 3;
}

function gridVariantPoolForRound(round) {
  const pool = ['row', 'column', 'color_group', 'shape_pair', 'manual_lookup'];
  if (round >= 3) pool.push('diagonal');
  return pool;
}

// Same idea as the wire-cut manual lookup: resolve to a row or column via a
// raw decision tree the Specialist evaluates themselves, not a stated answer.
function resolveGridManualLookup(nodes, size, bombKey) {
  const mDigit = bombKey.match(/\d(?!.*\d)/);
  const lastDigit = mDigit ? parseInt(mDigit[0], 10) : 0;
  const odd = lastDigit % 2 === 1;
  const purpleCount = nodes.filter((n) => n.color === 'purple').length;
  const starNodes = nodes.filter((n) => n.shape === 'star');

  const steps = [
    '1. If there is NO purple node, press ROW 1.',
    '2. Else if there are two or more star-shaped nodes, press the COLUMN containing the FIRST star node (reading row by row).',
    "3. Else if the bomb key's last digit is ODD, press the LAST row.",
    '4. Otherwise, press the FIRST column.',
  ];

  let group;
  if (purpleCount === 0) group = nodes.filter((n) => n.row === 0);
  else if (starNodes.length >= 2) group = nodes.filter((n) => n.col === starNodes[0].col);
  else if (odd) group = nodes.filter((n) => n.row === size - 1);
  else group = nodes.filter((n) => n.col === 0);

  return { group: group.map((n) => n.id), steps };
}

function generateHandshakeModule(round = 1, bombKey = 'AAAAAA') {
  const size = gridSizeForRound(round);
  const variant = pick(gridVariantPoolForRound(round));
  const total = size * size;

  let shapes = [];
  if (variant === 'shape_pair') {
    const pairShape = pick(SHAPES);
    shapes.push(pairShape, pairShape);
    const others = shuffle(SHAPES.filter((s) => s !== pairShape));
    while (shapes.length < total) shapes.push(others[(shapes.length - 2) % others.length]);
    shapes = shuffle(shapes);
  } else {
    for (let i = 0; i < total; i++) shapes.push(pick(SHAPES));
  }
  const nodes = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const i = r * size + c;
      nodes.push({ id: `n${i}`, row: r, col: c, shape: shapes[i], color: pick(COLORS), pressed: false });
    }
  }

  const base = { moduleType: 'handshake_grid', variant, size, nodes };

  if (variant === 'manual_lookup') {
    const { group, steps } = resolveGridManualLookup(nodes, size, bombKey);
    return {
      ...base,
      ruleText: `MANUAL LOOKUP — bomb key ${bombKey}. Work out the target row/column yourself from this decision tree, checked in order (first match wins):\n${steps.join(' ')}`,
      requiredNodes: group,
      exactSet: true,
    };
  }
  if (variant === 'row') {
    const targetRow = Math.floor(Math.random() * size);
    const group = nodes.filter((n) => n.row === targetRow).map((n) => n.id);
    return { ...base, ruleText: `Press every node in ROW ${targetRow + 1} (any order). Leave other rows untouched.`, requiredNodes: group, exactSet: true };
  }
  if (variant === 'column') {
    const targetCol = Math.floor(Math.random() * size);
    const group = nodes.filter((n) => n.col === targetCol).map((n) => n.id);
    return { ...base, ruleText: `Press every node in COLUMN ${targetCol + 1} (any order). Leave other columns untouched.`, requiredNodes: group, exactSet: true };
  }
  if (variant === 'diagonal') {
    const main = Math.random() < 0.5;
    const group = nodes.filter((n) => (main ? n.row === n.col : n.row + n.col === size - 1)).map((n) => n.id);
    return { ...base, ruleText: `Press every node on the ${main ? 'MAIN' : 'ANTI'} diagonal (any order). Leave the rest untouched.`, requiredNodes: group, exactSet: true };
  }
  if (variant === 'color_group') {
    const targetColor = pick([...new Set(nodes.map((n) => n.color))]);
    const group = nodes.filter((n) => n.color === targetColor).map((n) => n.id);
    return { ...base, ruleText: `Press every ${targetColor.toUpperCase()} node (any order). Leave the rest untouched.`, requiredNodes: group, exactSet: true };
  }
  // shape_pair
  const shapeCounts = {};
  nodes.forEach((n) => (shapeCounts[n.shape] = (shapeCounts[n.shape] || 0) + 1));
  const pairShape = Object.keys(shapeCounts).find((s) => shapeCounts[s] >= 2) || nodes[0].shape;
  const group = nodes.filter((n) => n.shape === pairShape).map((n) => n.id);
  return { ...base, ruleText: `Find the two nodes that share shape ${pairShape.toUpperCase()} and press only those two. Leave the rest untouched.`, requiredNodes: group, exactSet: true };
}

// ---- Frequency Lock: a continuous dial instead of discrete wires/nodes ----

function bandWidthForRound(round) {
  return Math.max(8, Math.min(20 - (round - 1) * 2, 40));
}

// KTANE's Frequencies module structure: decode a condition, look up the
// matching table row, get the exact answer. The table itself is safe to
// print in full — knowing all four zones doesn't tell you which applies.
const FREQ_ZONES = { A: 15, B: 40, C: 60, D: 85 }; // zone center points

function resolveFrequencyZone(channelLabel, bombKey) {
  const hasRepeatLetter = /([A-Z]).*\1/.test(bombKey);
  const digitCount = (bombKey.match(/\d/g) || []).length;
  const odd = channelLabel % 2 === 1;

  const steps = [
    '1. If the bomb key contains a REPEATED letter, use ZONE A.',
    '2. Else if the bomb key contains 3 or more digits, use ZONE D.',
    '3. Else if the channel key is ODD, use ZONE B.',
    '4. Otherwise, use ZONE C.',
  ];

  let zone;
  if (hasRepeatLetter) zone = 'A';
  else if (digitCount >= 3) zone = 'D';
  else if (odd) zone = 'B';
  else zone = 'C';

  return { zone, steps };
}

// The dial face itself prints the four zone letters at their fixed
// positions (same every game, visible to whoever's looking at the dial) —
// that calibration is public. What's NOT public is which zone applies, and
// the numeric target band is never handed to the Specialist directly: they
// work out the ZONE from the bomb key and relay the LETTER, same as every
// other module hands over a described target rather than a raw coordinate.
// The Operator has to actually find that letter on their own dial.
function generateFrequencyModule(round = 1, bombKey = 'AAAAAA') {
  const channelLabel = 1 + Math.floor(Math.random() * 9);
  const width = bandWidthForRound(round);
  const { zone, steps } = resolveFrequencyZone(channelLabel, bombKey);
  const center = FREQ_ZONES[zone];
  const targetLow = Math.max(0, Math.min(100 - width, center - width / 2));
  const targetHigh = targetLow + width;

  return {
    moduleType: 'frequency_lock',
    channelLabel,
    zone,
    targetLow,
    targetHigh,
    dialValue: Math.floor(Math.random() * 100),
    ruleText: `MANUAL LOOKUP — channel key ${channelLabel}, bomb key ${bombKey}. Determine the zone yourself, checked in order (first match wins):\n${steps.join(' ')}\nTell the Operator to line the needle up with that ZONE letter on the dial face, then lock it in.`,
  };
}

// ---- Signal Decode: a flashed color sequence the Operator sees but can't
// interpret, translated through a manual-held lookup table -----------------

function signalLengthForRound(round) {
  return Math.max(3, Math.min(3 + Math.floor((round - 1) / 2), 6));
}

// KTANE's Simon Says structure: the sighted role never gets a resolved
// mapping, just two full tables and the same repeated-letter test used
// elsewhere — safe to print both tables since knowing them doesn't say
// which one applies.
function generateSignalModule(round = 1, bombKey = 'AAAAAA') {
  const buttonColors = shuffle(COLORS).slice(0, 4);
  const length = signalLengthForRound(round);
  const signals = Array.from({ length }, () => pick(buttonColors));
  const hasRepeatLetter = /([A-Z]).*\1/.test(bombKey);

  const shuffledA = shuffle(buttonColors);
  const shuffledB = shuffle(buttonColors);
  const tableA = {}, tableB = {};
  buttonColors.forEach((c, i) => { tableA[c] = shuffledA[i]; tableB[c] = shuffledB[i]; });
  const table = hasRepeatLetter ? tableA : tableB;
  const target = signals.map((c) => table[c]);

  const fmtTable = (t) => buttonColors.map((c) => `${c.toUpperCase()} -> ${t[c].toUpperCase()}`).join(', ');
  return {
    moduleType: 'signal_decode',
    buttonColors,
    signals,
    progress: 0,
    target,
    _table: table,
    ruleText: `MANUAL LOOKUP — bomb key ${bombKey}. TABLE A (use if the bomb key has a REPEATED letter): ${fmtTable(tableA)}. TABLE B (otherwise): ${fmtTable(tableB)}. For each flashed color in order, press the button for its translated color from the correct table.`,
  };
}

// ---- Password Lock: letter reels spelling a word picked from a printed --
// candidate list via a decision tree, same manual-lookup shape as the rest.

const PASSWORD_WORDS = ['RADIO', 'ROBOT', 'TRACE', 'PRIME', 'GHOST', 'QUARK', 'VALVE', 'ORBIT', 'CHART', 'PULSE'];
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function resolvePasswordWord(candidates, bombKey) {
  const hasRepeatLetter = /([A-Z]).*\1/.test(bombKey);
  const digitCount = (bombKey.match(/\d/g) || []).length;
  const vowelCount = (bombKey.match(/[AEIOU]/g) || []).length;

  const steps = [
    `1. If the bomb key has a REPEATED letter, the password is candidate #1 (${candidates[0]}).`,
    `2. Else if the bomb key has 3 or more digits, the password is candidate #2 (${candidates[1]}).`,
    `3. Else if the bomb key has 2 or more vowels, the password is candidate #3 (${candidates[2]}).`,
    `4. Otherwise, the password is candidate #4 (${candidates[3]}).`,
  ];

  let word;
  if (hasRepeatLetter) word = candidates[0];
  else if (digitCount >= 3) word = candidates[1];
  else if (vowelCount >= 2) word = candidates[2];
  else word = candidates[3];

  return { word, steps };
}

function generatePasswordModule(round = 1, bombKey = 'AAAAAA') {
  const candidates = shuffle(PASSWORD_WORDS).slice(0, 4);
  const { word, steps } = resolvePasswordWord(candidates, bombKey);
  const reels = word.split('').map(() => ({ letterIndex: Math.floor(Math.random() * ALPHABET.length) }));

  return {
    moduleType: 'password_lock',
    candidates,
    reels,
    targetWord: word,
    ruleText: `MANUAL LOOKUP — bomb key ${bombKey}. Candidate passwords: ${candidates.join(', ')}. Determine which one is correct, checked in order (first match wins):\n${steps.join(' ')}\nSpin each reel to spell that word, then submit.`,
  };
}

// ---- Maze: a hidden wall map the Operator has to be walked through --------
// Real KTANE Maze structure: the defuser sees their own marker and the goal
// marker (both physically on the panel) but nothing about the walls between
// them. The Specialist holds the full wall layout — the only secret — and
// has to give one direction at a time.

function mazeSizeForRound(round) {
  return round >= 3 ? 6 : 5;
}

function randInt(n) {
  return Math.floor(Math.random() * n);
}

function generateMazeGrid(size) {
  const cells = Array.from({ length: size }, () => Array.from({ length: size }, () => ({ N: false, E: false, S: false, W: false })));
  const visited = Array.from({ length: size }, () => Array(size).fill(false));
  const DIRS = [['N', -1, 0, 'S'], ['S', 1, 0, 'N'], ['E', 0, 1, 'W'], ['W', 0, -1, 'E']];

  function carve(r, c) {
    visited[r][c] = true;
    for (const [dir, dr, dc, opp] of shuffle(DIRS)) {
      const nr = r + dr, nc = c + dc;
      if (nr >= 0 && nr < size && nc >= 0 && nc < size && !visited[nr][nc]) {
        cells[r][c][dir] = true;
        cells[nr][nc][opp] = true;
        carve(nr, nc);
      }
    }
  }
  carve(0, 0);
  return cells;
}

function describeMazeWalls(grid, size) {
  const lines = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const open = grid[r][c];
      const dirs = ['N', 'E', 'S', 'W'].filter((d) => open[d]);
      lines.push(`(${r},${c}): ${dirs.length ? dirs.join('/') : 'none'}`);
    }
  }
  return lines.join('; ');
}

// A perfect maze (spanning tree) has exactly one path between any two
// cells, and a random goal's distance from the start is unbounded — median
// ~11 steps at size 5, worst case 24+. At real relay speed (one verbal
// direction + confirmation per step) that alone can eat the whole round's
// timer. Cap the goal to a bounded distance range so path length stays a
// fair, predictable part of the round instead of an occasional timer-killer.
const MAZE_MIN_PATH = 2;
const MAZE_MAX_PATH = 10;

function mazeDistances(grid, size, start) {
  const DELTA = { N: [-1, 0], S: [1, 0], E: [0, 1], W: [0, -1] };
  const dist = Array.from({ length: size }, () => Array(size).fill(-1));
  dist[start.row][start.col] = 0;
  const q = [[start.row, start.col]];
  while (q.length) {
    const [r, c] = q.shift();
    for (const dir of ['N', 'E', 'S', 'W']) {
      if (!grid[r][c][dir]) continue;
      const [dr, dc] = DELTA[dir];
      const nr = r + dr, nc = c + dc;
      if (dist[nr][nc] === -1) {
        dist[nr][nc] = dist[r][c] + 1;
        q.push([nr, nc]);
      }
    }
  }
  return dist;
}

function pickMazeGoal(grid, size, from) {
  const dist = mazeDistances(grid, size, from || { row: 0, col: 0 });
  const candidates = [];
  let farthest = from || { row: 0, col: 0 }, farthestDist = -1;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (dist[r][c] >= MAZE_MIN_PATH && dist[r][c] <= MAZE_MAX_PATH) candidates.push({ row: r, col: c });
      if (dist[r][c] > farthestDist) { farthestDist = dist[r][c]; farthest = { row: r, col: c }; }
    }
  }
  return candidates.length ? pick(candidates) : farthest;
}

function generateMazeModule(round = 1) {
  const size = mazeSizeForRound(round);
  const grid = generateMazeGrid(size);
  const goal = pickMazeGoal(grid, size);
  return {
    moduleType: 'maze',
    size,
    grid,
    pos: { row: 0, col: 0 },
    goal,
    ruleText: `You hold the only map of this maze. Guide the Operator one step at a time (N/E/S/W) from their current position to the goal — walking into a wall counts as a wrong move. Walls (open directions per cell):\n${describeMazeWalls(grid, size)}`,
  };
}

// ---- Morse Relay: a flashed dot/dash pattern decoded via the standard ----
// Morse alphabet (public, unchanging reference) into letters to press.

const MORSE_MAP = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....',
  I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.',
  Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-',
  Y: '-.--', Z: '--..',
};
const MORSE_WORDS = ['RELAY', 'SIGNAL', 'ALERT', 'BEACON', 'ORBIT', 'RADIO', 'ECHO', 'VAULT'];

function morseWordLengthForRound(round) {
  return round >= 3 ? MORSE_WORDS : MORSE_WORDS.filter((w) => w.length <= 5);
}

function generateMorseModule(round = 1) {
  const word = pick(morseWordLengthForRound(round));
  const letters = word.split('');
  const signals = letters.map((l) => MORSE_MAP[l]);
  return {
    moduleType: 'morse_relay',
    letters,
    signals,
    progress: 0,
    ruleText: 'Standard Morse reference (see table below, public, same every round). Decode each flashed group in order, then have the Operator press that letter on the keypad.',
  };
}

const FACES = ['front', 'back', 'right', 'left', 'top', 'bottom'];
const MODULE_COUNT = 2;
const MODULE_TYPES = ['wire_cut', 'handshake_grid', 'frequency_lock', 'signal_decode', 'password_lock', 'maze', 'morse_relay'];

function generateOneModule(moduleType, round, bombKey) {
  if (moduleType === 'handshake_grid') return generateHandshakeModule(round, bombKey);
  if (moduleType === 'frequency_lock') return generateFrequencyModule(round, bombKey);
  if (moduleType === 'signal_decode') return generateSignalModule(round, bombKey);
  if (moduleType === 'password_lock') return generatePasswordModule(round, bombKey);
  if (moduleType === 'maze') return generateMazeModule(round);
  if (moduleType === 'morse_relay') return generateMorseModule(round);
  return generateWireCutModule(round, bombKey);
}

const BOMB_KEY_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ123456789'; // no O/0/I to avoid ambiguity
function generateBombKey() {
  let key = '';
  for (let i = 0; i < 6; i++) key += BOMB_KEY_CHARS[Math.floor(Math.random() * BOMB_KEY_CHARS.length)];
  return key;
}

// Two modules per round, each on a distinct random face of the same cube —
// the player has to rotate to find both, same as a real multi-module bomb.
function generateModules(round = 1, bombKey = 'AAAAAA') {
  const types = shuffle(MODULE_TYPES).slice(0, MODULE_COUNT);
  const faces = shuffle(FACES).slice(0, MODULE_COUNT);
  return types.map((moduleType, i) => {
    const mod = generateOneModule(moduleType, round, bombKey);
    mod.face = faces[i];
    mod.solved = false;
    return mod;
  });
}

// Once spread crosses the containment threshold, the signal fights back: the
// live rule quietly gains one extra condition. Sighted roles see the updated
// ruleText immediately; the blind operator only feels it as a harder puzzle.
function applyContainmentBreach(puzzle) {
  if (!puzzle || puzzle.thresholdShifted) return;
  puzzle.thresholdShifted = true;

  if (puzzle.moduleType === 'frequency_lock') {
    // The target band itself drifts — only sighted roles notice the new range.
    const width = puzzle.targetHigh - puzzle.targetLow;
    const shift = (Math.random() < 0.5 ? -1 : 1) * (15 + Math.floor(Math.random() * 15));
    const newLow = Math.max(0, Math.min(100 - width, puzzle.targetLow + shift));
    puzzle.targetLow = newLow;
    puzzle.targetHigh = newLow + width;
    puzzle.ruleText += ' CONTAINMENT BREACH: the target band has drifted — re-read the range.';
    return;
  }

  if (puzzle.moduleType === 'maze') {
    // The goal marker itself is public (the Operator can see it same as the
    // Specialist) — what changes is the Specialist now has to replan a path
    // through walls the Operator still can't see.
    puzzle.goal = pickMazeGoal(puzzle.grid, puzzle.size, puzzle.pos);
    puzzle.ruleText += ` CONTAINMENT BREACH: the goal marker has jumped to a new cell — replan the route from the Operator's current position.`;
    return;
  }

  if (puzzle.moduleType === 'morse_relay') {
    const extra = pick(Object.keys(MORSE_MAP));
    puzzle.letters.push(extra);
    puzzle.signals.push(MORSE_MAP[extra]);
    puzzle.ruleText += ' CONTAINMENT BREACH: one more letter has been flashed — extend the word you relay.';
    return;
  }

  if (puzzle.moduleType === 'signal_decode') {
    // The signal keeps talking: one more flash arrives, translated through
    // the same table — sighted roles see it appended immediately, the
    // operator only feels the sequence they're relaying got longer.
    const extra = pick(puzzle.buttonColors);
    puzzle.signals.push(extra);
    puzzle.target.push(puzzle._table[extra]);
    puzzle.ruleText += ' CONTAINMENT BREACH: one more signal has flashed — extend the sequence you relay.';
    return;
  }

  if (puzzle.moduleType === 'password_lock') {
    // The password drifts to a different entry on the same printed list —
    // only sighted roles notice the manual now points elsewhere.
    const alternatives = puzzle.candidates.filter((w) => w !== puzzle.targetWord);
    puzzle.targetWord = pick(alternatives);
    puzzle.ruleText += ` CONTAINMENT BREACH: the password has changed — it is now ${puzzle.targetWord}.`;
    return;
  }

  if (puzzle.moduleType === 'wire_cut' && puzzle.variant === 'sequence') {
    const remaining = puzzle.solutionOrder.filter((id) => {
      const w = puzzle.wires.find((x) => x.id === id);
      return !w.cut;
    });
    const done = puzzle.solutionOrder.filter((id) => !remaining.includes(id));
    puzzle.solutionOrder = [...done, ...remaining.reverse()];
    puzzle.ruleText += ' CONTAINMENT BREACH: the remaining cut order has reversed.';
    return;
  }

  // exactSet-style modules: wire_cut's color/parity/exclusion variants, and
  // every handshake_grid variant — both use { items, requiredKey, cutFlag }.
  const isGrid = puzzle.moduleType === 'handshake_grid';
  const items = isGrid ? puzzle.nodes : puzzle.wires;
  const requiredKey = isGrid ? 'requiredNodes' : 'requiredFirst';
  const cutFlag = isGrid ? 'pressed' : 'cut';
  const uncommitted = items.filter((x) => !x[cutFlag] && !puzzle[requiredKey].includes(x.id));
  if (uncommitted.length) {
    const flipped = pick(uncommitted);
    puzzle[requiredKey].push(flipped.id);
    const verb = isGrid ? 'press' : 'cut';
    const where = isGrid ? `row ${flipped.row + 1}, column ${flipped.col + 1}` : `position ${flipped.position + 1}`;
    puzzle.ruleText += ` CONTAINMENT BREACH: also ${verb} the one at ${where}.`;
  }
}

function breachAllModules(room) {
  for (const m of room.modules) {
    if (!m.solved) applyContainmentBreach(m);
  }
}

// ---- Room model -------------------------------------------------------

class Room {
  constructor(id, mode, playStyle, difficulty) {
    this.id = id;
    this.mode = mode; // 2 or 3
    this.playStyle = playStyle === 'local' ? 'local' : 'online'; // 'local' = players together in person
    this.difficulty = DIFFICULTIES.includes(difficulty) ? difficulty : 'medium';
    this.players = new Map(); // playerId -> {id, name, role, connected}
    this.status = 'lobby'; // lobby | active | won | lost
    this.modules = []; // active modules this round, each on a distinct cube face
    this.bombKey = null; // shared "serial number"-style key sighted roles cross-reference
    this.startedAt = null;
    this.spread = 0; // 0-100 containment spread; reaching 100 is a quarantine breach (loss)
    this.round = 1; // increments on each win, resets to 1 on a loss
    this.timerDuration = TIMER_SECONDS;
    this.log = []; // {from, kind, value, at}
    this.instructions = { specialist: '', specialist_1: '', specialist_2: '' }; // per-specialist channel to the Operator
    this.connections = new Map(); // playerId -> res (SSE)
    this.createdAt = Date.now();
  }

  availableRoles() {
    const taken = new Set([...this.players.values()].map((p) => p.role).filter(Boolean));
    return ROLE_SETS[this.mode].filter((r) => !taken.has(r));
  }

  timeRemaining() {
    if (!this.startedAt) return this.timerDuration;
    const elapsed = (Date.now() - this.startedAt) / 1000;
    return Math.max(0, Math.round(this.timerDuration - elapsed));
  }

  checkTimeout() {
    if (this.status === 'active' && this.timeRemaining() <= 0) {
      this.status = 'lost';
    }
  }

}

function getOrCreateRoom(id, mode, playStyle, difficulty) {
  let room = rooms.get(id);
  if (!room) {
    room = new Room(id, mode || 2, playStyle, difficulty);
    rooms.set(id, room);
  }
  return room;
}

// ---- Per-role state views ----------------------------------------------

function publicPlayers(room) {
  return [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    role: p.role,
    connected: p.connected,
  }));
}

function buildView(room, playerId) {
  room.checkTimeout();
  const player = room.players.get(playerId);
  const role = player ? player.role : null;

  const base = {
    roomId: room.id,
    mode: room.mode,
    playStyle: room.playStyle,
    difficulty: room.difficulty,
    status: room.status,
    players: publicPlayers(room),
    availableRoles: room.availableRoles(),
    yourRole: role,
    timeRemaining: room.timeRemaining(),
    timerDuration: room.timerDuration,
    round: room.round,
    spread: room.spread,
    modulesSolved: room.modules.filter((m) => m.solved).length,
    modulesTotal: room.modules.length,
    instructions: room.instructions,
    log: room.log.slice(-25),
    serverTime: Date.now(),
  };

  if (!room.modules.length || room.status === 'lobby') return base;

  const isOperator = role === 'operator';

  // Which module indices this role can see: the Operator and the single
  // 2-player Specialist see everything; in 3-player mode each specialist
  // owns exactly one module and is blind to the other.
  const canSeeIndex = (i) => {
    if (isOperator || role === 'specialist') return true;
    if (role === 'specialist_1') return i === 0;
    if (role === 'specialist_2') return i === 1;
    return false;
  };

  base.modules = room.modules.map((m, i) => {
    if (!canSeeIndex(i)) return { face: m.face, moduleType: m.moduleType, solved: m.solved, hidden: true };
    return buildModuleView(m, { showRule: !isOperator });
  });
  if (!isOperator) base.bombKey = room.bombKey;

  return base;
}

function buildModuleView(m, { showRule }) {
  const out = { face: m.face, moduleType: m.moduleType, solved: m.solved };

  // The Operator always sees the full bomb — every color, every shape —
  // same as a real defuser looking right at it. What they never get is the
  // rule: that's the manual, and only a Specialist holds it.
  if (m.moduleType === 'wire_cut') {
    out.wires = m.wires.map((w) => ({ id: w.id, position: w.position, shape: w.shape, color: w.color, cut: w.cut }));
    if (showRule) out.ruleText = m.ruleText;
  } else if (m.moduleType === 'handshake_grid') {
    out.grid = { size: m.size, nodes: m.nodes.map((n) => ({ id: n.id, row: n.row, col: n.col, shape: n.shape, color: n.color, pressed: n.pressed })) };
    if (showRule) out.ruleText = m.ruleText;
  } else if (m.moduleType === 'frequency_lock') {
    // The dial's physical zone-letter markings (FREQ_ZONES) are printed on
    // the instrument itself and sent to every role via the client's own
    // constant — never the raw numeric target band, which would just be
    // the answer handed over outright.
    out.freq = { channelLabel: m.channelLabel, dialValue: m.dialValue };
    if (showRule) {
      out.freq.zone = m.zone;
      out.ruleText = m.ruleText;
    }
  } else if (m.moduleType === 'signal_decode') {
    // The Operator sees the raw flashed sequence and how far they've gotten
    // (same as watching real Simon Says flashes) but never the translation
    // table — that's the manual, held only by the Specialist.
    out.signal = { buttonColors: m.buttonColors, signals: m.signals, progress: m.progress };
    if (showRule) out.ruleText = m.ruleText;
  } else if (m.moduleType === 'password_lock') {
    out.password = { reels: m.reels.map((r) => ({ letterIndex: r.letterIndex })) };
    if (showRule) {
      out.password.candidates = m.candidates;
      out.ruleText = m.ruleText;
    }
  } else if (m.moduleType === 'maze') {
    // Position and goal are both physically visible markers in real KTANE —
    // only the wall layout between them is the manual's secret.
    out.maze = { size: m.size, pos: m.pos, goal: m.goal };
    if (showRule) out.ruleText = m.ruleText;
  } else if (m.moduleType === 'morse_relay') {
    // The Morse alphabet is fixed and public (same table every round, like
    // the frequency dial's zone letters) — send it structured so the client
    // can render a real scannable grid instead of one long inline string.
    out.morse = { signals: m.signals, progress: m.progress, table: MORSE_MAP };
    if (showRule) out.ruleText = m.ruleText;
  }
  return out;
}

function broadcast(room) {
  for (const [pid, res] of room.connections) {
    if (res.writableEnded) continue;
    const view = buildView(room, pid);
    res.write(`data: ${JSON.stringify(view)}\n\n`);
  }
}

// Tick every active room's synced countdown once a second, and catch timeouts
// even when nobody is currently taking an action that would otherwise trigger
// a broadcast.
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.status !== 'active') continue;
    room.checkTimeout();
    broadcast(room);
  }
}, 1000);

// ---- HTTP plumbing -------------------------------------------------------

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function requirePlayer(room, playerId) {
  const p = room.players.get(playerId);
  if (!p) return null;
  return p;
}

const routes = {
  async 'POST /api/room/join'(req, res, url) {
    const body = await readBody(req);
    const requestedRoomId = (body.roomId || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    const roomId = requestedRoomId || newId(3).toUpperCase();
    const mode = body.mode === 3 ? 3 : 2;
    const playStyle = body.playStyle === 'local' ? 'local' : 'online';
    const difficulty = DIFFICULTIES.includes(body.difficulty) ? body.difficulty : 'medium';
    const name = (body.name || 'Player').replace(/[<>]/g, '').slice(0, 24) || 'Player';
    const room = getOrCreateRoom(roomId, mode, playStyle, difficulty);
    if (room.players.size >= room.mode && ![...room.players.values()].some(p => p.name === name)) {
      // allow rejoin by same connection later via playerId; block brand-new joins once full
    }
    if (room.players.size >= room.mode) {
      return sendJson(res, 409, { error: 'Room is full.' });
    }
    const playerId = newId(6);
    room.players.set(playerId, { id: playerId, name, role: null, connected: false });
    sendJson(res, 200, { roomId: room.id, playerId, mode: room.mode, playStyle: room.playStyle, difficulty: room.difficulty });
  },

  async 'POST /api/room/role'(req, res) {
    const body = await readBody(req);
    const room = rooms.get(body.roomId);
    if (!room) return sendJson(res, 404, { error: 'Room not found.' });
    const player = requirePlayer(room, body.playerId);
    if (!player) return sendJson(res, 404, { error: 'Player not found.' });
    const role = body.role;
    if (!ROLE_SETS[room.mode].includes(role)) {
      return sendJson(res, 400, { error: 'Invalid role for this room size.' });
    }
    const taken = [...room.players.values()].some((p) => p.role === role && p.id !== player.id);
    if (taken) return sendJson(res, 409, { error: 'That role is already taken in this room.' });
    player.role = role;
    broadcast(room);
    sendJson(res, 200, { ok: true });
  },

  async 'POST /api/room/start'(req, res) {
    const body = await readBody(req);
    const room = rooms.get(body.roomId);
    if (!room) return sendJson(res, 404, { error: 'Room not found.' });
    const roles = [...room.players.values()].map((p) => p.role);
    const needed = ROLE_SETS[room.mode];
    const filled = needed.every((r) => roles.includes(r));
    if (!filled || room.players.size !== room.mode) {
      return sendJson(res, 400, { error: 'Every role must be filled before starting.' });
    }
    room.bombKey = generateBombKey();
    const effRound = effectiveRound(room);
    room.modules = generateModules(effRound, room.bombKey);
    // Same flat bonus for any module that takes real extra relay time to
    // execute, not just the ones phrased as a decision-tree lookup: Maze
    // needs turn-by-turn verbal guidance across several moves, and Morse
    // Relay needs a table lookup PLUS hunting one letter at a time across a
    // 26-key keypad — both as slow in practice as a manual-lookup wire cut.
    const heavyModuleCount = room.modules.filter((m) =>
      (m.ruleText && m.ruleText.includes('MANUAL LOOKUP')) || m.moduleType === 'maze' || m.moduleType === 'morse_relay'
    ).length;
    room.timerDuration = timerForRound(effRound) + heavyModuleCount * LOOKUP_TIME_BONUS;
    room.startedAt = Date.now();
    room.status = 'active';
    room.spread = 0;
    room.instructions = { specialist: '', specialist_1: '', specialist_2: '' };
    room.log = [];
    broadcast(room);
    sendJson(res, 200, { ok: true });
  },

  async 'POST /api/room/reset'(req, res) {
    const body = await readBody(req);
    const room = rooms.get(body.roomId);
    if (!room) return sendJson(res, 404, { error: 'Room not found.' });
    room.checkTimeout();
    if (room.status === 'won') room.round += 1;
    else if (room.status === 'lost') room.round = 1;
    room.modules = [];
    room.startedAt = null;
    room.status = 'lobby';
    room.spread = 0;
    room.instructions = { specialist: '', specialist_1: '', specialist_2: '' };
    room.log = [];
    broadcast(room);
    sendJson(res, 200, { ok: true });
  },

  async 'POST /api/room/instruct'(req, res) {
    const body = await readBody(req);
    const room = rooms.get(body.roomId);
    if (!room) return sendJson(res, 404, { error: 'Room not found.' });
    const player = requirePlayer(room, body.playerId);
    const allowed = ['specialist', 'specialist_1', 'specialist_2'];
    if (!player || !allowed.includes(player.role)) {
      return sendJson(res, 403, { error: 'Only a Specialist can send instructions.' });
    }
    const text = (body.text || '').slice(0, 140);
    room.instructions[player.role] = text;
    room.log.push({ from: player.name, kind: 'instruction', value: text, at: Date.now() });
    broadcast(room);
    sendJson(res, 200, { ok: true });
  },

  async 'POST /api/room/cut'(req, res) {
    const body = await readBody(req);
    const room = rooms.get(body.roomId);
    if (!room) return sendJson(res, 404, { error: 'Room not found.' });
    const player = requirePlayer(room, body.playerId);
    if (!player || player.role !== 'operator') {
      return sendJson(res, 403, { error: 'Only the Blind Bomb Operator can cut wires.' });
    }
    const mod = findActiveModule(room, body.face, 'wire_cut');
    if (room.status !== 'active' || !mod) {
      return sendJson(res, 400, { error: 'No active wire-cut module on that face.' });
    }
    room.checkTimeout();
    if (room.status !== 'active') {
      broadcast(room);
      return sendJson(res, 200, { ok: true, status: room.status });
    }
    const wire = mod.wires.find((w) => w.id === body.wireId);
    if (!wire || wire.cut) return sendJson(res, 400, { error: 'Invalid wire.' });

    const correct = isCorrectCut(mod, wire, mod.wires);
    if (correct) {
      wire.cut = true;
      if (puzzleSatisfied(mod)) checkModuleSolved(room, mod);
    } else {
      applyWrongAction(room);
    }
    broadcast(room);
    sendJson(res, 200, { ok: true, correct });
  },

  async 'POST /api/room/press'(req, res) {
    const body = await readBody(req);
    const room = rooms.get(body.roomId);
    if (!room) return sendJson(res, 404, { error: 'Room not found.' });
    const player = requirePlayer(room, body.playerId);
    if (!player || player.role !== 'operator') {
      return sendJson(res, 403, { error: 'Only the Blind Bomb Operator can press nodes.' });
    }
    const mod = findActiveModule(room, body.face, 'handshake_grid');
    if (room.status !== 'active' || !mod) {
      return sendJson(res, 400, { error: 'No active handshake grid on that face.' });
    }
    room.checkTimeout();
    if (room.status !== 'active') {
      broadcast(room);
      return sendJson(res, 200, { ok: true, status: room.status });
    }
    const node = mod.nodes.find((n) => n.id === body.nodeId);
    if (!node || node.pressed) return sendJson(res, 400, { error: 'Invalid node.' });

    const correct = mod.requiredNodes.includes(node.id);
    if (correct) {
      node.pressed = true;
      if (mod.requiredNodes.every((id) => mod.nodes.find((n) => n.id === id).pressed)) {
        checkModuleSolved(room, mod);
      }
    } else {
      applyWrongAction(room);
    }
    broadcast(room);
    sendJson(res, 200, { ok: true, correct });
  },

  async 'POST /api/room/tune'(req, res) {
    const body = await readBody(req);
    const room = rooms.get(body.roomId);
    if (!room) return sendJson(res, 404, { error: 'Room not found.' });
    const player = requirePlayer(room, body.playerId);
    if (!player || player.role !== 'operator') {
      return sendJson(res, 403, { error: 'Only the Blind Bomb Operator can tune the dial.' });
    }
    const mod = findActiveModule(room, body.face, 'frequency_lock');
    if (room.status !== 'active' || !mod) {
      return sendJson(res, 400, { error: 'No active frequency lock on that face.' });
    }
    room.checkTimeout();
    if (room.status !== 'active') {
      broadcast(room);
      return sendJson(res, 200, { ok: true, status: room.status });
    }
    const value = Math.max(0, Math.min(100, Number(body.value) || 0));
    mod.dialValue = value;

    if (!body.lock) {
      broadcast(room);
      return sendJson(res, 200, { ok: true });
    }
    const correct = value >= mod.targetLow && value <= mod.targetHigh;
    if (correct) {
      checkModuleSolved(room, mod);
    } else {
      applyWrongAction(room);
    }
    broadcast(room);
    sendJson(res, 200, { ok: true, correct });
  },

  async 'POST /api/room/signal'(req, res) {
    const body = await readBody(req);
    const room = rooms.get(body.roomId);
    if (!room) return sendJson(res, 404, { error: 'Room not found.' });
    const player = requirePlayer(room, body.playerId);
    if (!player || player.role !== 'operator') {
      return sendJson(res, 403, { error: 'Only the Blind Bomb Operator can press signal buttons.' });
    }
    const mod = findActiveModule(room, body.face, 'signal_decode');
    if (room.status !== 'active' || !mod) {
      return sendJson(res, 400, { error: 'No active signal decode module on that face.' });
    }
    room.checkTimeout();
    if (room.status !== 'active') {
      broadcast(room);
      return sendJson(res, 200, { ok: true, status: room.status });
    }
    const color = body.color;
    if (!mod.buttonColors.includes(color)) return sendJson(res, 400, { error: 'Invalid button.' });

    const correct = mod.target[mod.progress] === color;
    if (correct) {
      mod.progress += 1;
      if (mod.progress >= mod.signals.length) checkModuleSolved(room, mod);
    } else {
      applyWrongAction(room);
    }
    broadcast(room);
    sendJson(res, 200, { ok: true, correct });
  },

  async 'POST /api/room/spin'(req, res) {
    const body = await readBody(req);
    const room = rooms.get(body.roomId);
    if (!room) return sendJson(res, 404, { error: 'Room not found.' });
    const player = requirePlayer(room, body.playerId);
    if (!player || player.role !== 'operator') {
      return sendJson(res, 403, { error: 'Only the Blind Bomb Operator can spin the reels.' });
    }
    const mod = findActiveModule(room, body.face, 'password_lock');
    if (room.status !== 'active' || !mod) {
      return sendJson(res, 400, { error: 'No active password lock on that face.' });
    }
    room.checkTimeout();
    if (room.status !== 'active') {
      broadcast(room);
      return sendJson(res, 200, { ok: true, status: room.status });
    }
    const reel = mod.reels[body.reelIndex];
    if (!reel) return sendJson(res, 400, { error: 'Invalid reel.' });
    const delta = body.delta === -1 ? -1 : 1;
    reel.letterIndex = (reel.letterIndex + delta + ALPHABET.length) % ALPHABET.length;
    broadcast(room);
    sendJson(res, 200, { ok: true });
  },

  async 'POST /api/room/submit-password'(req, res) {
    const body = await readBody(req);
    const room = rooms.get(body.roomId);
    if (!room) return sendJson(res, 404, { error: 'Room not found.' });
    const player = requirePlayer(room, body.playerId);
    if (!player || player.role !== 'operator') {
      return sendJson(res, 403, { error: 'Only the Blind Bomb Operator can submit the password.' });
    }
    const mod = findActiveModule(room, body.face, 'password_lock');
    if (room.status !== 'active' || !mod) {
      return sendJson(res, 400, { error: 'No active password lock on that face.' });
    }
    room.checkTimeout();
    if (room.status !== 'active') {
      broadcast(room);
      return sendJson(res, 200, { ok: true, status: room.status });
    }
    const spelled = mod.reels.map((r) => ALPHABET[r.letterIndex]).join('');
    const correct = spelled === mod.targetWord;
    if (correct) {
      checkModuleSolved(room, mod);
    } else {
      applyWrongAction(room);
    }
    broadcast(room);
    sendJson(res, 200, { ok: true, correct });
  },

  async 'POST /api/room/move'(req, res) {
    const body = await readBody(req);
    const room = rooms.get(body.roomId);
    if (!room) return sendJson(res, 404, { error: 'Room not found.' });
    const player = requirePlayer(room, body.playerId);
    if (!player || player.role !== 'operator') {
      return sendJson(res, 403, { error: 'Only the Blind Bomb Operator can move through the maze.' });
    }
    const mod = findActiveModule(room, body.face, 'maze');
    if (room.status !== 'active' || !mod) {
      return sendJson(res, 400, { error: 'No active maze on that face.' });
    }
    room.checkTimeout();
    if (room.status !== 'active') {
      broadcast(room);
      return sendJson(res, 200, { ok: true, status: room.status });
    }
    const dir = body.dir;
    const DELTA = { N: [-1, 0], S: [1, 0], E: [0, 1], W: [0, -1] };
    if (!DELTA[dir]) return sendJson(res, 400, { error: 'Invalid direction.' });

    const open = mod.grid[mod.pos.row][mod.pos.col][dir];
    if (open) {
      const [dr, dc] = DELTA[dir];
      mod.pos = { row: mod.pos.row + dr, col: mod.pos.col + dc };
      if (mod.pos.row === mod.goal.row && mod.pos.col === mod.goal.col) checkModuleSolved(room, mod);
    } else {
      applyWrongAction(room);
    }
    broadcast(room);
    sendJson(res, 200, { ok: true, correct: open });
  },

  async 'POST /api/room/morse'(req, res) {
    const body = await readBody(req);
    const room = rooms.get(body.roomId);
    if (!room) return sendJson(res, 404, { error: 'Room not found.' });
    const player = requirePlayer(room, body.playerId);
    if (!player || player.role !== 'operator') {
      return sendJson(res, 403, { error: 'Only the Blind Bomb Operator can press keypad letters.' });
    }
    const mod = findActiveModule(room, body.face, 'morse_relay');
    if (room.status !== 'active' || !mod) {
      return sendJson(res, 400, { error: 'No active Morse relay on that face.' });
    }
    room.checkTimeout();
    if (room.status !== 'active') {
      broadcast(room);
      return sendJson(res, 200, { ok: true, status: room.status });
    }
    const letter = (body.letter || '').toUpperCase();
    const correct = mod.letters[mod.progress] === letter;
    if (correct) {
      mod.progress += 1;
      if (mod.progress >= mod.letters.length) checkModuleSolved(room, mod);
    } else {
      applyWrongAction(room);
    }
    broadcast(room);
    sendJson(res, 200, { ok: true, correct });
  },

  async 'GET /api/room/stream'(req, res, url) {
    const roomId = url.searchParams.get('roomId');
    const playerId = url.searchParams.get('playerId');
    const room = rooms.get(roomId);
    if (!room || !room.players.has(playerId)) {
      res.writeHead(404);
      return res.end('Room or player not found');
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('\n');
    room.players.get(playerId).connected = true;
    room.connections.set(playerId, res);
    res.write(`data: ${JSON.stringify(buildView(room, playerId))}\n\n`);
    broadcast(room);

    const keepAlive = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 15000);

    req.on('close', () => {
      clearInterval(keepAlive);
      // A reconnect (page refresh, or the client's own error-triggered
      // EventSource retry) opens a new stream for the same playerId before
      // the old one's socket finishes tearing down. Only clear state if
      // this closing connection is still the one on record — otherwise a
      // late close from the OLD connection would wrongly evict the new one.
      if (room.connections.get(playerId) === res) {
        room.connections.delete(playerId);
        const p = room.players.get(playerId);
        if (p) p.connected = false;
        broadcast(room);
      }
    });
  },
};

// Shared wrong-action penalty for every module type: adds spread, docks time,
// and triggers the one-time containment breach (on every unsolved module)
// once spread crosses threshold.
function applyWrongAction(room) {
  const mult = DIFFICULTY_PENALTY_MULT[room.difficulty] || 1;
  const before = room.spread;
  room.spread = Math.min(100, room.spread + (14 + Math.floor(Math.random() * 8)) * mult); // +14-21%, scaled by difficulty
  room.startedAt -= 8000 * mult; // 8s time penalty, scaled by difficulty
  if (before < CONTAINMENT_THRESHOLD && room.spread >= CONTAINMENT_THRESHOLD) {
    breachAllModules(room);
  }
  if (room.spread >= 100) room.status = 'lost';
}

function findActiveModule(room, face, moduleType) {
  return room.modules.find((m) => m.face === face && m.moduleType === moduleType && !m.solved) || null;
}

function checkModuleSolved(room, mod) {
  mod.solved = true;
  if (room.modules.every((m) => m.solved)) room.status = 'won';
}

function isCorrectCut(puzzle, wire, allWires) {
  if (puzzle.variant === 'sequence') {
    const nextIndex = puzzle.solutionOrder.findIndex((id) => {
      const w = allWires.find((x) => x.id === id);
      return !w.cut;
    });
    return puzzle.solutionOrder[nextIndex] === wire.id;
  }
  // color_group / shape_pair: must belong to requiredFirst set; nothing outside it should be cut.
  return puzzle.requiredFirst.includes(wire.id);
}

function puzzleSatisfied(puzzle) {
  if (puzzle.variant === 'sequence') {
    return puzzle.wires.every((w) => w.cut);
  }
  return puzzle.requiredFirst.every((id) => puzzle.wires.find((w) => w.id === id).cut);
}

const STATIC_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function serveStatic(req, res) {
  const file = req.url === '/' ? '/index.html' : req.url;
  const filePath = path.join(__dirname, file.split('?')[0]);
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': STATIC_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const key = `${req.method} ${url.pathname}`;
  const handler = routes[key];
  if (handler) {
    try {
      await handler(req, res, url);
    } catch (e) {
      sendJson(res, 500, { error: 'Server error', detail: e.message });
    }
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Relay Protocol server listening on http://localhost:${PORT}`);
});
