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

function generatePuzzle(round = 1) {
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
    variant,
    wires,
    ruleText: `Cut every wire EXCEPT the ${excludedColor.toUpperCase()} ones (any order). Leave ${excludedColor.toUpperCase()} wires untouched.`,
    requiredFirst: group,
    exactSet: true,
    totalWires,
  };
}

// ---- Room model -------------------------------------------------------

class Room {
  constructor(id, mode) {
    this.id = id;
    this.mode = mode; // 2 or 3
    this.players = new Map(); // playerId -> {id, name, role, connected}
    this.status = 'lobby'; // lobby | active | won | lost
    this.puzzle = null;
    this.startedAt = null;
    this.strikes = 0;
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

  wiresRemaining() {
    if (!this.puzzle) return WIRE_COUNT;
    return this.puzzle.wires.filter((w) => !w.cut).length;
  }
}

function getOrCreateRoom(id, mode) {
  let room = rooms.get(id);
  if (!room) {
    room = new Room(id, mode || 2);
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
    status: room.status,
    players: publicPlayers(room),
    availableRoles: room.availableRoles(),
    yourRole: role,
    timeRemaining: room.timeRemaining(),
    timerDuration: room.timerDuration,
    round: room.round,
    strikes: room.strikes,
    wiresRemaining: room.wiresRemaining(),
    totalWires: room.puzzle ? room.puzzle.totalWires : WIRE_COUNT,
    instruction: room.instruction,
    log: room.log.slice(-25),
    serverTime: Date.now(),
  };

  if (!room.puzzle || room.status === 'lobby') return base;

  const sightedRoles = ['relay_specialist', 'mute_reader'];

  if (role === 'blind_operator') {
    base.wires = room.puzzle.wires.map((w) => ({
      id: w.id,
      position: w.position,
      shape: w.shape,
      cut: w.cut,
    }));
  } else if (sightedRoles.includes(role)) {
    base.wires = room.puzzle.wires.map((w) => ({
      id: w.id,
      position: w.position,
      shape: w.shape,
      color: w.color,
      cut: w.cut,
    }));
    base.ruleText = room.puzzle.ruleText;
    if (role === 'mute_reader') base.symbolPalette = SYMBOLS;
  } else if (role === 'deaf_interpreter') {
    // Sees only the symbol log the mute sent, plus wire shapes/positions (no color, no rule).
    base.wires = room.puzzle.wires.map((w) => ({
      id: w.id,
      position: w.position,
      shape: w.shape,
      cut: w.cut,
    }));
    base.symbolLog = room.log.filter((e) => e.kind === 'symbol').slice(-25);
  }

  return base;
}

function broadcast(room) {
  for (const [pid, res] of room.connections) {
    if (res.writableEnded) continue;
    const view = buildView(room, pid);
    res.write(`data: ${JSON.stringify(view)}\n\n`);
  }
}

// Auto-lose sweep for rooms whose timer expired with nobody polling right now.
setInterval(() => {
  for (const room of rooms.values()) {
    const wasActive = room.status === 'active';
    room.checkTimeout();
    if (wasActive && room.status === 'lost') broadcast(room);
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
    const name = (body.name || 'Player').replace(/[<>]/g, '').slice(0, 24) || 'Player';
    const room = getOrCreateRoom(roomId, mode);
    if (room.players.size >= room.mode && ![...room.players.values()].some(p => p.name === name)) {
      // allow rejoin by same connection later via playerId; block brand-new joins once full
    }
    if (room.players.size >= room.mode) {
      return sendJson(res, 409, { error: 'Room is full.' });
    }
    const playerId = newId(6);
    room.players.set(playerId, { id: playerId, name, role: null, connected: false });
    sendJson(res, 200, { roomId: room.id, playerId, mode: room.mode });
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
    room.puzzle = generatePuzzle(room.round);
    room.startedAt = Date.now();
    room.status = 'active';
    room.strikes = 0;
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
    room.puzzle = null;
    room.startedAt = null;
    room.status = 'lobby';
    room.strikes = 0;
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
    if (room.status !== 'active') return sendJson(res, 400, { error: 'No active bomb.' });
    room.checkTimeout();
    if (room.status !== 'active') {
      broadcast(room);
      return sendJson(res, 200, { ok: true, status: room.status });
    }
    const wire = room.puzzle.wires.find((w) => w.id === body.wireId);
    if (!wire || wire.cut) return sendJson(res, 400, { error: 'Invalid wire.' });

    const correct = isCorrectCut(room.puzzle, wire, room.puzzle.wires);
    if (correct) {
      wire.cut = true;
      if (room.wiresRemaining() === 0 || puzzleSatisfied(room.puzzle)) {
        room.status = 'won';
      }
    } else {
      room.strikes += 1;
      room.startedAt -= 8000; // 8s time penalty for a wrong cut
      if (room.strikes >= 3) room.status = 'lost';
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
