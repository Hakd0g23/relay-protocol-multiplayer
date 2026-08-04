const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const TIMER_SECONDS = 90;
const WIRE_COUNT = 5;
const SHAPES = ['circle', 'triangle', 'square', 'diamond', 'star'];
const COLORS = ['red', 'blue', 'yellow', 'green', 'purple'];
const SYMBOLS = ['▲', '●', '■', '★', '◆', '✦', '✚', '✖'];

const ROLE_SETS = {
  2: ['blind_operator', 'relay_specialist'],
  3: ['blind_operator', 'mute_reader', 'deaf_interpreter'],
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
const MIN_TIMER_SECONDS = 60;
const CONTAINMENT_THRESHOLD = 50; // spread % at which the ruleset shifts once

// Difficulty scales with round number: more wires, a shorter clock, and a
// wider variant pool unlock as the room clears more bombs in a row.
function wireCountForRound(round) {
  return Math.min(WIRE_COUNT + Math.floor((round - 1) / 2), MAX_WIRE_COUNT);
}

function timerForRound(round) {
  return Math.max(TIMER_SECONDS - (round - 1) * 5, MIN_TIMER_SECONDS);
}

function variantPoolForRound(round) {
  const pool = ['sequence', 'color_group', 'shape_pair'];
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

function generateWireCutModule(round = 1) {
  const wireCount = wireCountForRound(round);
  const variant = pick(variantPoolForRound(round));
  const wires = makeWires(wireCount, variant === 'shape_pair');
  const totalWires = wires.length;

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
  const pool = ['row', 'column', 'color_group', 'shape_pair'];
  if (round >= 3) pool.push('diagonal');
  return pool;
}

function generateHandshakeModule(round = 1) {
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
  return Math.max(20 - (round - 1) * 2, 8);
}

function generateFrequencyModule(round = 1) {
  const channelLabel = 1 + Math.floor(Math.random() * 9);
  const width = bandWidthForRound(round);
  const odd = channelLabel % 2 === 1;
  // Manual-style conditional, in the spirit of KTANE's serial-digit branches:
  // the key's parity decides which half of the dial the band lives in.
  const targetLow = odd
    ? Math.floor(Math.random() * (50 - width))
    : 50 + Math.floor(Math.random() * (50 - width));
  const targetHigh = targetLow + width;
  return {
    moduleType: 'frequency_lock',
    channelLabel,
    targetLow,
    targetHigh,
    dialValue: Math.floor(Math.random() * 100),
    ruleText: `Channel key reads ${channelLabel} (${odd ? 'ODD' : 'EVEN'}) — ${odd ? 'odd keys aim LOW' : 'even keys aim HIGH'}. Tune the dial so the needle rests between ${targetLow} and ${targetHigh}, then lock it in.`,
  };
}

const FACES = ['front', 'back', 'right', 'left', 'top', 'bottom'];
const MODULE_COUNT = 2;

function generateOneModule(moduleType, round) {
  if (moduleType === 'handshake_grid') return generateHandshakeModule(round);
  if (moduleType === 'frequency_lock') return generateFrequencyModule(round);
  return generateWireCutModule(round);
}

// Two modules per round, each on a distinct random face of the same cube —
// the player has to rotate to find both, same as a real multi-module bomb.
function generateModules(round = 1) {
  const types = shuffle(['wire_cut', 'handshake_grid', 'frequency_lock']).slice(0, MODULE_COUNT);
  const faces = shuffle(FACES).slice(0, MODULE_COUNT);
  return types.map((moduleType, i) => {
    const mod = generateOneModule(moduleType, round);
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
  constructor(id, mode, playStyle) {
    this.id = id;
    this.mode = mode; // 2 or 3
    this.playStyle = playStyle === 'local' ? 'local' : 'online'; // 'local' = players together in person
    this.players = new Map(); // playerId -> {id, name, role, connected}
    this.status = 'lobby'; // lobby | active | won | lost
    this.modules = []; // active modules this round, each on a distinct cube face
    this.startedAt = null;
    this.spread = 0; // 0-100 containment spread; reaching 100 is a quarantine breach (loss)
    this.round = 1; // increments on each win, resets to 1 on a loss
    this.timerDuration = TIMER_SECONDS;
    this.log = []; // {from, kind, value, at}
    this.instruction = ''; // latest plain-text instruction for the blind operator
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

function getOrCreateRoom(id, mode, playStyle) {
  let room = rooms.get(id);
  if (!room) {
    room = new Room(id, mode || 2, playStyle);
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
    instruction: room.instruction,
    log: room.log.slice(-25),
    serverTime: Date.now(),
  };

  if (!room.modules.length || room.status === 'lobby') return base;

  const sightedRoles = ['relay_specialist', 'mute_reader'];
  const sighted = sightedRoles.includes(role);
  const blind = role === 'blind_operator';
  const deaf = role === 'deaf_interpreter';

  base.modules = room.modules.map((m) => buildModuleView(m, { sighted, blind, deaf }));

  if (role === 'mute_reader') base.symbolPalette = SYMBOLS;
  if (deaf) base.symbolLog = room.log.filter((e) => e.kind === 'symbol').slice(-25);

  return base;
}

function buildModuleView(m, { sighted, blind, deaf }) {
  const out = { face: m.face, moduleType: m.moduleType, solved: m.solved };

  if (m.moduleType === 'wire_cut') {
    if (blind || deaf) {
      out.wires = m.wires.map((w) => ({ id: w.id, position: w.position, shape: w.shape, cut: w.cut }));
    } else if (sighted) {
      out.wires = m.wires.map((w) => ({ id: w.id, position: w.position, shape: w.shape, color: w.color, cut: w.cut }));
      out.ruleText = m.ruleText;
    }
  } else if (m.moduleType === 'handshake_grid') {
    if (blind || deaf) {
      out.grid = { size: m.size, nodes: m.nodes.map((n) => ({ id: n.id, row: n.row, col: n.col, shape: n.shape, pressed: n.pressed })) };
    } else if (sighted) {
      out.grid = { size: m.size, nodes: m.nodes.map((n) => ({ id: n.id, row: n.row, col: n.col, shape: n.shape, color: n.color, pressed: n.pressed })) };
      out.ruleText = m.ruleText;
    }
  } else if (m.moduleType === 'frequency_lock') {
    if (blind || deaf) {
      out.freq = { channelLabel: m.channelLabel, dialValue: m.dialValue };
    } else if (sighted) {
      out.freq = { channelLabel: m.channelLabel, dialValue: m.dialValue, targetLow: m.targetLow, targetHigh: m.targetHigh };
      out.ruleText = m.ruleText;
    }
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
    const name = (body.name || 'Player').replace(/[<>]/g, '').slice(0, 24) || 'Player';
    const room = getOrCreateRoom(roomId, mode, playStyle);
    if (room.players.size >= room.mode && ![...room.players.values()].some(p => p.name === name)) {
      // allow rejoin by same connection later via playerId; block brand-new joins once full
    }
    if (room.players.size >= room.mode) {
      return sendJson(res, 409, { error: 'Room is full.' });
    }
    const playerId = newId(6);
    room.players.set(playerId, { id: playerId, name, role: null, connected: false });
    sendJson(res, 200, { roomId: room.id, playerId, mode: room.mode, playStyle: room.playStyle });
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
    room.timerDuration = timerForRound(room.round);
    room.modules = generateModules(room.round);
    room.startedAt = Date.now();
    room.status = 'active';
    room.spread = 0;
    room.instruction = '';
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
    room.instruction = '';
    room.log = [];
    broadcast(room);
    sendJson(res, 200, { ok: true });
  },

  async 'POST /api/room/symbol'(req, res) {
    const body = await readBody(req);
    const room = rooms.get(body.roomId);
    if (!room) return sendJson(res, 404, { error: 'Room not found.' });
    const player = requirePlayer(room, body.playerId);
    if (!player || player.role !== 'mute_reader') {
      return sendJson(res, 403, { error: 'Only the Mute Clue Reader can send symbols.' });
    }
    if (!SYMBOLS.includes(body.symbol)) return sendJson(res, 400, { error: 'Unknown symbol.' });
    room.log.push({ from: player.name, kind: 'symbol', value: body.symbol, at: Date.now() });
    broadcast(room);
    sendJson(res, 200, { ok: true });
  },

  async 'POST /api/room/instruct'(req, res) {
    const body = await readBody(req);
    const room = rooms.get(body.roomId);
    if (!room) return sendJson(res, 404, { error: 'Room not found.' });
    const player = requirePlayer(room, body.playerId);
    const allowed = ['relay_specialist', 'deaf_interpreter'];
    if (!player || !allowed.includes(player.role)) {
      return sendJson(res, 403, { error: 'Only the Relay Specialist or Deaf Interpreter can send instructions.' });
    }
    const text = (body.text || '').slice(0, 140);
    room.instruction = text;
    room.log.push({ from: player.name, kind: 'instruction', value: text, at: Date.now() });
    broadcast(room);
    sendJson(res, 200, { ok: true });
  },

  async 'POST /api/room/cut'(req, res) {
    const body = await readBody(req);
    const room = rooms.get(body.roomId);
    if (!room) return sendJson(res, 404, { error: 'Room not found.' });
    const player = requirePlayer(room, body.playerId);
    if (!player || player.role !== 'blind_operator') {
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
    if (!player || player.role !== 'blind_operator') {
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
    if (!player || player.role !== 'blind_operator') {
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
      room.connections.delete(playerId);
      const p = room.players.get(playerId);
      if (p) p.connected = false;
      broadcast(room);
    });
  },
};

// Shared wrong-action penalty for every module type: adds spread, docks time,
// and triggers the one-time containment breach (on every unsolved module)
// once spread crosses threshold.
function applyWrongAction(room) {
  const before = room.spread;
  room.spread = Math.min(100, room.spread + 14 + Math.floor(Math.random() * 8)); // +14-21%
  room.startedAt -= 8000; // 8s time penalty
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
