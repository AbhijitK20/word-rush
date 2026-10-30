import { randomInt, randomUUID } from 'node:crypto';
import {
  AVATARS,
  MAX_PLAYERS,
  generateBoard,
  isValidAvatar,
  isValidPath,
  normalizeWord,
  scoreWord,
  validateName,
} from './game.js';

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 4;
export const ROUND_CHOICES = [3, 5];
export const TIME_CHOICES = [60, 90, 120];
export const REACTIONS = ['🔥', '😂', '😮', '👏', '💀', '❤️'];

const DEFAULT_RESULT_DELAY_MS = 12000;
const DEFAULT_OFFLINE_REMOVE_MS = 10 * 60 * 1000;
const DEFAULT_HOST_TRANSFER_MS = 5000;
const DEFAULT_ROOM_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_ROOM_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const DEFAULT_FEED_LIMIT = 40;
const MAX_ROOMS = 2000;
const CLAIM_WINDOW_MS = 10000;
const CLAIM_LIMIT = 18;
const REACTION_COOLDOWN_MS = 700;

const WS_OPEN = 1;

function normalizeCode(value) {
  return String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, ROOM_CODE_LENGTH);
}

function makeCode(rooms) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
      code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  throw new Error('Could not allocate a room code.');
}

function normalizeOrigin(origin) {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.origin;
  } catch {
    return '';
  }
}

function makeJoinUrl(origin, publicUrl, code) {
  const base = normalizeOrigin(origin) || normalizeOrigin(publicUrl);
  return base ? `${base}/?room=${code}` : `/?room=${code}`;
}

export class RoomManager {
  constructor(options = {}) {
    this.dictionary = options.dictionary;
    this.log = options.log ?? console;
    this.publicUrl = options.publicUrl ?? process.env.PUBLIC_URL ?? '';
    this.resultDelayMs = options.resultDelayMs ?? DEFAULT_RESULT_DELAY_MS;
    this.offlineRemoveMs = options.offlineRemoveMs ?? DEFAULT_OFFLINE_REMOVE_MS;
    this.hostTransferMs = options.hostTransferMs ?? DEFAULT_HOST_TRANSFER_MS;
    this.roomIdleMs = options.roomIdleMs ?? DEFAULT_ROOM_IDLE_MS;
    this.roomMaxAgeMs = options.roomMaxAgeMs ?? DEFAULT_ROOM_MAX_AGE_MS;
    this.feedLimit = options.feedLimit ?? DEFAULT_FEED_LIMIT;

    this.rooms = new Map();
    this.cleanupTimer = setInterval(() => this.cleanupRooms(), 60_000);
    this.cleanupTimer.unref?.();
  }

  attach(ws, options = {}) {
    ws.origin = options.origin ?? '';
    ws.session = null;
    ws.isAlive = true;
    ws.meta = { messageTimes: [] };
    this.send(ws, { type: 'hello', serverNow: Date.now() });
  }

  send(ws, payload) {
    if (!ws || ws.readyState !== WS_OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch (error) {
      this.log.warn?.('Could not send websocket message:', error?.message ?? error);
    }
  }

  sendError(ws, message, code = 'ERROR') {
    this.send(ws, { type: 'error', message, code });
  }

  handleMessage(ws, raw) {
    const now = Date.now();
    ws.meta ??= { messageTimes: [] };
    ws.meta.messageTimes = ws.meta.messageTimes.filter((time) => now - time < 10_000);
    ws.meta.messageTimes.push(now);
    if (ws.meta.messageTimes.length > 80) {
      this.sendError(ws, 'You are sending messages too quickly. Take a breath.', 'RATE_LIMIT');
      return;
    }

    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      this.sendError(ws, 'That message was not valid JSON.', 'BAD_MESSAGE');
      return;
    }

    if (!message || typeof message.type !== 'string') {
      this.sendError(ws, 'Missing message type.', 'BAD_MESSAGE');
      return;
    }

    switch (message.type) {
      case 'ping':
        this.send(ws, { type: 'pong', t: message.t, serverNow: Date.now() });
        return;
      case 'create':
        this.createRoom(ws, message);
        return;
      case 'join':
        this.joinRoom(ws, message);
        return;
      case 'resume':
        this.resumeSession(ws, message);
        return;
      case 'leave':
        this.leaveRoom(ws);
        return;
      case 'updateProfile':
        this.updateProfile(ws, message);
        return;
      case 'settings':
        this.updateSettings(ws, message);
        return;
      case 'start':
        this.startMatch(ws);
        return;
      case 'claim':
        this.claimWord(ws, message);
        return;
      case 'nextRound':
        this.nextRoundFromHost(ws);
        return;
      case 'rematch':
        this.rematch(ws);
        return;
      case 'react':
        this.react(ws, message);
        return;
      default:
        this.sendError(ws, 'Unknown action.', 'BAD_MESSAGE');
        return;
    }
  }

  contextFor(ws) {
    if (!ws?.session) return null;
    const room = this.rooms.get(ws.session.roomCode);
    if (!room) return null;
    const player = room.players.get(ws.session.playerId);
    if (!player || player.socket !== ws) return null;
    return { room, player };
  }

  createRoom(ws, message) {
    if (ws.session) {
      this.sendError(ws, "You're already in a room.", 'ALREADY_IN_ROOM');
      return;
    }
    if (this.rooms.size >= MAX_ROOMS) {
      this.sendError(ws, 'The server is full right now. Try again in a moment.', 'SERVER_FULL');
      return;
    }

    const nameResult = validateName(message.name, this.dictionary.blocked);
    if (!nameResult.ok) {
      this.sendError(ws, nameResult.error, 'NAME_INVALID');
      return;
    }

    const avatar = isValidAvatar(message.avatar) ? message.avatar : AVATARS[0];
    const code = makeCode(this.rooms);
    const now = Date.now();
    const room = {
      code,
      hostId: null,
      players: new Map(),
      status: 'lobby',
      settings: { rounds: 3, roundSeconds: 90 },
      roundNumber: 0,
      grid: null,
      boardWords: null,
      roundStartedAt: null,
      roundEndsAt: null,
      nextAt: null,
      results: null,
      feed: [],
      feedSeq: 0,
      createdAt: now,
      lastActivity: now,
      joinUrl: makeJoinUrl(ws.origin, this.publicUrl, code),
      timers: { end: null, sync: null, next: null, host: null },
    };

    const player = this.createPlayer(nameResult.name, avatar, now);
    room.players.set(player.id, player);
    room.hostId = player.id;
    this.rooms.set(code, room);

    this.attachPlayer(ws, room, player);
    this.pushFeed(room, {
      kind: 'system',
      text: `${player.name} opened the room. Invite some friends!`,
    });
    this.log.log?.(`Room ${code} created by ${player.name}`);
    this.broadcast(room);
  }

  joinRoom(ws, message) {
    if (ws.session) {
      this.sendError(ws, "You're already in a room.", 'ALREADY_IN_ROOM');
      return;
    }

    const code = normalizeCode(message.code);
    if (code.length !== ROOM_CODE_LENGTH) {
      this.sendError(ws, 'Enter the 4-character room code.', 'BAD_CODE');
      return;
    }

    const room = this.rooms.get(code);
    if (!room) {
      this.sendError(ws, 'No room with that code. Double-check it and try again.', 'ROOM_NOT_FOUND');
      return;
    }
    if (room.players.size >= MAX_PLAYERS) {
      this.sendError(ws, 'That room is full.', 'ROOM_FULL');
      return;
    }

    const nameResult = validateName(message.name, this.dictionary.blocked);
    if (!nameResult.ok) {
      this.sendError(ws, nameResult.error, 'NAME_INVALID');
      return;
    }

    const avatar = isValidAvatar(message.avatar) ? message.avatar : AVATARS[0];
    const player = this.createPlayer(nameResult.name, avatar, Date.now());
    room.players.set(player.id, player);
    room.lastActivity = Date.now();

    this.attachPlayer(ws, room, player);
    this.pushFeed(room, {
      kind: 'join',
      playerId: player.id,
      name: player.name,
      avatar: player.avatar,
      text: 'joined the room',
    });
    if (!room.hostId || !room.players.has(room.hostId)) {
      room.hostId = player.id;
    } else {
      this.ensureHost(room);
    }
    this.log.log?.(`${player.name} joined room ${code}`);
    this.broadcast(room);
  }

  resumeSession(ws, message) {
    const code = normalizeCode(message.code);
    const token = String(message.token ?? '');
    if (!code || !token) {
      this.sendError(ws, 'That session could not be restored.', 'SESSION_INVALID');
      return;
    }

    const room = this.rooms.get(code);
    const player = room ? [...room.players.values()].find((candidate) => candidate.token === token) : null;
    if (!room || !player) {
      this.sendError(ws, 'That room or session has expired.', 'SESSION_INVALID');
      return;
    }

    if (player.socket && player.socket !== ws) {
      const oldSocket = player.socket;
      player.socket = null;
      try {
        oldSocket.close(4001, 'Session opened in another tab');
      } catch {
      }
    }

    if (player.removalTimer) {
      clearTimeout(player.removalTimer);
      player.removalTimer = null;
    }
    if (player.id === room.hostId && room.timers.host) {
      clearTimeout(room.timers.host);
      room.timers.host = null;
    }

    player.connected = true;
    room.lastActivity = Date.now();
    this.attachPlayer(ws, room, player);
    this.broadcast(room);
  }

  attachPlayer(ws, room, player) {
    ws.session = { roomCode: room.code, playerId: player.id };
    player.socket = ws;
    player.connected = true;
    if (player.removalTimer) {
      clearTimeout(player.removalTimer);
      player.removalTimer = null;
    }
    room.lastActivity = Date.now();
    this.send(ws, {
      type: 'session',
      playerId: player.id,
      token: player.token,
      code: room.code,
      name: player.name,
      avatar: player.avatar,
    });
  }

  createPlayer(name, avatar, now) {
    return {
      id: randomUUID(),
      token: randomUUID(),
      name,
      avatar,
      score: 0,
      totalWords: 0,
      roundWords: [],
      connected: true,
      socket: null,
      joinedAt: now,
      lastClaimAt: 0,
      claimTimes: [],
      lastReactionAt: 0,
      removalTimer: null,
    };
  }

  updateProfile(ws, message) {
    const context = this.contextFor(ws);
    if (!context) {
      this.sendError(ws, 'Join a room first.', 'NOT_IN_ROOM');
      return;
    }
    const { room, player } = context;
    if (room.status !== 'lobby') {
      this.sendError(ws, 'Names can only be changed in the lobby.', 'NOT_IN_LOBBY');
      return;
    }

    const nameResult = validateName(message.name, this.dictionary.blocked);
    if (!nameResult.ok) {
      this.sendError(ws, nameResult.error, 'NAME_INVALID');
      return;
    }
    const avatar = isValidAvatar(message.avatar) ? message.avatar : player.avatar;
    player.name = nameResult.name;
    player.avatar = avatar;
    room.lastActivity = Date.now();
    this.broadcast(room);
  }

  updateSettings(ws, message) {
    const context = this.contextFor(ws);
    if (!context) {
      this.sendError(ws, 'Join a room first.', 'NOT_IN_ROOM');
      return;
    }
    const { room, player } = context;
    if (room.hostId !== player.id) {
      this.sendError(ws, 'Only the host can change the settings.', 'NOT_HOST');
      return;
    }
    if (room.status !== 'lobby') {
      this.sendError(ws, 'Settings can only be changed in the lobby.', 'NOT_IN_LOBBY');
      return;
    }

    const rounds = Number(message.rounds);
    const roundSeconds = Number(message.roundSeconds);
    if (!ROUND_CHOICES.includes(rounds) || !TIME_CHOICES.includes(roundSeconds)) {
      this.sendError(ws, 'That game setting is not available.', 'BAD_SETTINGS');
      return;
    }

    room.settings = { rounds, roundSeconds };
    room.lastActivity = Date.now();
    this.broadcast(room);
  }

  startMatch(ws) {
    const context = this.contextFor(ws);
    if (!context) {
      this.sendError(ws, 'Join a room first.', 'NOT_IN_ROOM');
      return;
    }
    const { room, player } = context;
    if (room.hostId !== player.id) {
      this.sendError(ws, 'Only the host can start the game.', 'NOT_HOST');
      return;
    }
    if (room.status !== 'lobby') {
      this.sendError(ws, 'The game is already running.', 'ALREADY_STARTED');
      return;
    }
    if (room.players.size < 1) {
      this.sendError(ws, 'At least one player is needed.', 'NO_PLAYERS');
      return;
    }

    this.beginMatch(room);
  }

  beginMatch(room) {
    this.clearRoundTimers(room);
    if (room.timers.next) clearTimeout(room.timers.next);
    room.timers.next = null;

    room.roundNumber = 0;
    room.results = null;
    room.nextAt = null;
    room.feed = [];
    room.feedSeq += 1;

    for (const player of room.players.values()) {
      player.score = 0;
      player.totalWords = 0;
      player.roundWords = [];
      player.claimTimes = [];
      player.lastClaimAt = 0;
    }

    this.pushFeed(room, {
      kind: 'system',
      text: `${room.settings.rounds} rounds, ${room.settings.roundSeconds} seconds each. Good luck!`,
    });
    this.startRound(room);
  }

  startRound(room) {
    if (room.timers.next) {
      clearTimeout(room.timers.next);
      room.timers.next = null;
    }
    this.clearRoundTimers(room);

    let board;
    try {
      board = generateBoard(this.dictionary);
    } catch (error) {
      this.log.error?.('Board generation failed:', error);
      room.status = 'lobby';
      room.grid = null;
      room.boardWords = null;
      room.roundEndsAt = null;
      this.broadcast(room);
      return;
    }

    const now = Date.now();
    room.roundNumber += 1;
    room.status = 'playing';
    room.grid = board.grid;
    room.boardWords = board.words;
    room.roundStartedAt = now;
    room.roundEndsAt = now + room.settings.roundSeconds * 1000;
    room.nextAt = null;
    room.results = null;
    room.lastActivity = now;

    for (const player of room.players.values()) {
      player.roundWords = [];
      player.claimTimes = [];
      player.lastClaimAt = 0;
    }

    this.pushFeed(room, {
      kind: 'system',
      text: `Round ${room.roundNumber} — find as many words as you can.`,
    });

    room.timers.end = setTimeout(() => this.endRound(room), room.settings.roundSeconds * 1000 + 30);
    room.timers.sync = setInterval(() => {
      if (room.status === 'playing') this.broadcast(room);
    }, 5000);
    room.timers.sync.unref?.();

    this.broadcast(room);
  }

  endRound(room) {
    if (room.status !== 'playing') return;
    this.clearRoundTimers(room);

    const now = Date.now();
    room.roundEndsAt = null;
    room.results = this.computeResults(room);
    room.lastActivity = now;

    const top = room.results[0];
    if (top && top.roundPoints > 0) {
      this.pushFeed(room, {
        kind: 'system',
        text: `Round ${room.roundNumber} complete — ${top.name} led the round with ${top.roundPoints} point${top.roundPoints === 1 ? '' : 's'}.`,
      });
    } else {
      this.pushFeed(room, {
        kind: 'system',
        text: `Round ${room.roundNumber} complete.`,
      });
    }

    if (room.roundNumber >= room.settings.rounds) {
      room.status = 'gameOver';
      room.nextAt = null;
      const champion = [...room.players.values()]
        .sort((a, b) => b.score - a.score || b.totalWords - a.totalWords || a.name.localeCompare(b.name))[0];
      if (champion) {
        this.pushFeed(room, {
          kind: 'system',
          text: `Game over — ${champion.name} wins with ${champion.score} point${champion.score === 1 ? '' : 's'}!`,
        });
      }
      this.broadcast(room);
      return;
    }

    room.status = 'roundResult';
    room.nextAt = now + this.resultDelayMs;
    room.timers.next = setTimeout(() => this.nextRound(room), this.resultDelayMs);
    this.broadcast(room);
  }

  nextRound(room) {
    if (room.status !== 'roundResult') return;
    if (room.timers.next) {
      clearTimeout(room.timers.next);
      room.timers.next = null;
    }
    this.startRound(room);
  }

  nextRoundFromHost(ws) {
    const context = this.contextFor(ws);
    if (!context) {
      this.sendError(ws, 'Join a room first.', 'NOT_IN_ROOM');
      return;
    }
    const { room, player } = context;
    if (room.status !== 'roundResult') {
      this.sendError(ws, 'There is no round to advance right now.', 'NOT_BETWEEN_ROUNDS');
      return;
    }
    if (room.hostId !== player.id) {
      this.sendError(ws, 'Only the host can start the next round.', 'NOT_HOST');
      return;
    }
    this.nextRound(room);
  }

  rematch(ws) {
    const context = this.contextFor(ws);
    if (!context) {
      this.sendError(ws, 'Join a room first.', 'NOT_IN_ROOM');
      return;
    }
    const { room, player } = context;
    if (room.status !== 'gameOver') {
      this.sendError(ws, 'The game is not over yet.', 'NOT_GAME_OVER');
      return;
    }
    if (room.hostId !== player.id) {
      this.sendError(ws, 'Only the host can start a rematch.', 'NOT_HOST');
      return;
    }
    this.beginMatch(room);
  }

  claimWord(ws, message) {
    const context = this.contextFor(ws);
    if (!context) {
      this.sendError(ws, 'Join a room first.', 'NOT_IN_ROOM');
      return;
    }
    const { room, player } = context;
    if (room.status !== 'playing') {
      this.sendError(ws, 'The round is not running.', 'NOT_PLAYING');
      return;
    }
    if (!room.roundEndsAt || Date.now() >= room.roundEndsAt) {
      this.sendError(ws, "Time's up!", 'TIME_UP');
      return;
    }

    const now = Date.now();
    player.claimTimes = player.claimTimes.filter((time) => now - time < CLAIM_WINDOW_MS);
    if (player.claimTimes.length >= CLAIM_LIMIT) {
      this.sendError(ws, 'Slow down a touch — try again in a second.', 'RATE_LIMIT');
      return;
    }
    if (now - player.lastClaimAt < 90) {
      this.sendError(ws, 'Give that a moment.', 'RATE_LIMIT');
      return;
    }
    player.lastClaimAt = now;
    player.claimTimes.push(now);

    const word = normalizeWord(message.word);
    if (word.length < 3 || word.length > 12) {
      this.sendError(ws, 'Words must be 3–12 letters.', 'WORD_INVALID');
      return;
    }
    if (!isValidPath(room.grid, message.path, word)) {
      this.sendError(ws, 'That path does not match the board. Try selecting the letters again.', 'PATH_INVALID');
      return;
    }
    if (!room.boardWords?.has(word)) {
      this.sendError(ws, `“${word.toUpperCase()}” is not in this round's word list.`, 'WORD_INVALID');
      return;
    }
    if (player.roundWords.some((entry) => entry.word === word)) {
      this.sendError(ws, 'You already found that word this round.', 'WORD_DUPLICATE');
      return;
    }

    const points = scoreWord(word.length);
    player.score += points;
    player.totalWords += 1;
    player.roundWords.push({ word, points, at: now });
    room.lastActivity = now;

    this.pushFeed(room, {
      kind: 'word',
      playerId: player.id,
      name: player.name,
      avatar: player.avatar,
      length: word.length,
      points,
    });

    this.send(ws, {
      type: 'claimOk',
      word,
      points,
      total: player.score,
    });
    this.broadcast(room);
  }

  react(ws, message) {
    const context = this.contextFor(ws);
    if (!context) return;
    const { room, player } = context;
    if (!['playing', 'roundResult', 'gameOver'].includes(room.status)) return;
    if (!REACTIONS.includes(message.emoji)) {
      this.sendError(ws, 'That reaction is not available.', 'BAD_REACTION');
      return;
    }
    const now = Date.now();
    if (now - player.lastReactionAt < REACTION_COOLDOWN_MS) return;
    player.lastReactionAt = now;
    room.lastActivity = now;

    this.pushFeed(room, {
      kind: 'react',
      playerId: player.id,
      name: player.name,
      avatar: player.avatar,
      emoji: message.emoji,
    });
    this.broadcast(room);
  }

  leaveRoom(ws) {
    const context = this.contextFor(ws);
    if (!context) {
      ws.session = null;
      this.send(ws, { type: 'left' });
      return;
    }
    const { room, player } = context;
    ws.session = null;
    player.socket = null;
    player.connected = false;
    player.removalTimer && clearTimeout(player.removalTimer);
    player.removalTimer = null;

    room.players.delete(player.id);
    this.pushFeed(room, {
      kind: 'leave',
      playerId: player.id,
      name: player.name,
      avatar: player.avatar,
      text: 'left the room',
    });

    if (room.players.size === 0) {
      this.destroyRoom(room);
    } else {
      if (room.hostId === player.id) this.assignHost(room);
      room.lastActivity = Date.now();
      this.broadcast(room);
    }

    this.send(ws, { type: 'left' });
  }

  disconnect(ws) {
    if (!ws?.session) return;
    const room = this.rooms.get(ws.session.roomCode);
    if (!room) return;
    const player = room.players.get(ws.session.playerId);
    if (!player || player.socket !== ws) return;

    player.connected = false;
    player.socket = null;
    ws.session = null;
    room.lastActivity = Date.now();

    if (room.hostId === player.id && [...room.players.values()].some((p) => p.connected)) {
      this.scheduleHostTransfer(room);
    }

    player.removalTimer = setTimeout(() => {
      if (player.connected || !room.players.has(player.id)) return;
      room.players.delete(player.id);
      this.pushFeed(room, {
        kind: 'leave',
        playerId: player.id,
        name: player.name,
        avatar: player.avatar,
        text: 'left the room',
      });
      if (room.hostId === player.id) this.assignHost(room);
      if (room.players.size === 0) {
        this.destroyRoom(room);
      } else {
        this.broadcast(room);
      }
    }, this.offlineRemoveMs);
    player.removalTimer.unref?.();

    this.broadcast(room);
  }

  scheduleHostTransfer(room) {
    if (room.timers.host) return;
    room.timers.host = setTimeout(() => {
      room.timers.host = null;
      const host = room.players.get(room.hostId);
      if (host?.connected) return;
      const nextHost = [...room.players.values()].find((player) => player.connected);
      if (!nextHost) return;
      room.hostId = nextHost.id;
      this.pushFeed(room, {
        kind: 'system',
        text: `${nextHost.name} is now the host.`,
      });
      this.broadcast(room);
    }, this.hostTransferMs);
    room.timers.host.unref?.();
  }

  ensureHost(room) {
    if (!room.hostId || !room.players.has(room.hostId)) {
      const nextHost = [...room.players.values()].find((player) => player.connected)
        ?? [...room.players.values()][0];
      if (nextHost) room.hostId = nextHost.id;
      return;
    }
    const host = room.players.get(room.hostId);
    if (!host.connected && [...room.players.values()].some((player) => player.connected)) {
      this.scheduleHostTransfer(room);
    }
  }

  assignHost(room) {
    if (room.timers.host) {
      clearTimeout(room.timers.host);
      room.timers.host = null;
    }
    const nextHost = [...room.players.values()].find((player) => player.connected)
      ?? [...room.players.values()][0];
    if (!nextHost) {
      room.hostId = null;
      return;
    }
    if (room.hostId !== nextHost.id) {
      room.hostId = nextHost.id;
      this.pushFeed(room, {
        kind: 'system',
        text: `${nextHost.name} is now the host.`,
      });
    }
  }

  computeResults(room) {
    const results = [...room.players.values()].map((player) => {
      const words = player.roundWords
        .map(({ word, points }) => ({ word, points }))
        .sort((a, b) => b.points - a.points || a.word.localeCompare(b.word));
      const roundPoints = player.roundWords.reduce((sum, entry) => sum + entry.points, 0);
      return {
        playerId: player.id,
        name: player.name,
        avatar: player.avatar,
        connected: player.connected,
        roundPoints,
        total: player.score,
        totalWords: player.totalWords,
        words,
      };
    });

    results.sort((a, b) => b.roundPoints - a.roundPoints
      || b.total - a.total
      || a.name.localeCompare(b.name));
    return results;
  }

  pushFeed(room, event) {
    room.feedSeq += 1;
    room.feed.unshift({
      id: room.feedSeq,
      at: Date.now(),
      ...event,
    });
    if (room.feed.length > this.feedLimit) room.feed.length = this.feedLimit;
  }

  buildState(room, viewer) {
    const players = [...room.players.values()]
      .map((player) => ({
        id: player.id,
        name: player.name,
        avatar: player.avatar,
        score: player.score,
        connected: player.connected,
        isHost: player.id === room.hostId,
        roundPoints: player.roundWords.reduce((sum, entry) => sum + entry.points, 0),
        found: player.roundWords.length,
        totalWords: player.totalWords,
      }))
      .sort((a, b) => b.score - a.score
        || b.totalWords - a.totalWords
        || a.name.localeCompare(b.name));

    const me = room.players.get(viewer.id);
    const isHost = room.hostId === viewer.id;

    return {
      type: 'state',
      serverNow: Date.now(),
      room: {
        code: room.code,
        hostId: room.hostId,
        status: room.status,
        settings: room.settings,
        roundNumber: room.roundNumber,
        totalRounds: room.settings.rounds,
        maxPlayers: MAX_PLAYERS,
        grid: room.grid,
        roundEndsAt: room.status === 'playing' ? room.roundEndsAt : null,
        nextAt: room.status === 'roundResult' ? room.nextAt : null,
        players,
        feed: room.feed,
        results: room.results,
      },
      you: {
        id: viewer.id,
        name: me?.name ?? viewer.name,
        avatar: me?.avatar ?? viewer.avatar,
        words: me?.roundWords.map(({ word, points }) => ({ word, points })) ?? [],
        isHost,
        canStart: isHost && room.status === 'lobby',
        canNext: isHost && room.status === 'roundResult',
        canRematch: isHost && room.status === 'gameOver',
      },
    };
  }

  broadcast(room) {
    for (const player of room.players.values()) {
      if (player.connected && player.socket) {
        this.send(player.socket, this.buildState(room, player));
      }
    }
  }

  clearRoundTimers(room) {
    if (room.timers.end) {
      clearTimeout(room.timers.end);
      room.timers.end = null;
    }
    if (room.timers.sync) {
      clearInterval(room.timers.sync);
      room.timers.sync = null;
    }
  }

  cleanupRooms() {
    const now = Date.now();
    for (const room of [...this.rooms.values()]) {
      const hasConnectedPlayers = [...room.players.values()].some((player) => player.connected);
      const idleFor = now - room.lastActivity;
      const age = now - room.createdAt;
      if ((!hasConnectedPlayers && idleFor > this.roomIdleMs) || age > this.roomMaxAgeMs) {
        this.destroyRoom(room);
      }
    }
  }

  destroyRoom(room) {
    this.clearRoundTimers(room);
    for (const timer of [room.timers.next, room.timers.host]) {
      if (timer) clearTimeout(timer);
    }
    for (const player of room.players.values()) {
      if (player.removalTimer) clearTimeout(player.removalTimer);
    }
    this.rooms.delete(room.code);
  }

  shutdown() {
    clearInterval(this.cleanupTimer);
    for (const room of [...this.rooms.values()]) this.destroyRoom(room);
  }
}

export { normalizeCode };
