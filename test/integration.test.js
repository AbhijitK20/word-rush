import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createGameServer } from '../src/app.js';
import { findBoardWords } from '../src/game.js';

const quietLog = { log() {}, warn() {}, error() {} };

class Client {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.queue = [];
    this.waiters = [];
    this.closed = false;
    this.ws.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (waiterIndex >= 0) {
        const [waiter] = this.waiters.splice(waiterIndex, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        this.queue.push(message);
      }
    });
    this.ws.on('close', () => {
      this.closed = true;
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('socket closed while waiting for a message'));
      }
    });
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
  }

  send(message) {
    this.ws.send(JSON.stringify(message));
  }

  next(predicate, timeout = 3000) {
    const index = this.queue.findIndex(predicate);
    if (index >= 0) {
      const [message] = this.queue.splice(index, 1);
      return Promise.resolve(message);
    }
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      waiter.timer = setTimeout(() => {
        const position = this.waiters.indexOf(waiter);
        if (position >= 0) this.waiters.splice(position, 1);
        reject(new Error(`timed out waiting for message; queued: ${JSON.stringify(this.queue.map((item) => item.type))}`));
      }, timeout);
      this.waiters.push(waiter);
    });
  }

  async nextState(predicate = () => true, timeout = 3000) {
    return this.next((message) => message.type === 'state' && predicate(message.room), timeout);
  }

  close() {
    if (this.closed) return;
    this.ws.close();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function areAdjacent(a, b) {
  const rowA = Math.floor(a / 4);
  const colA = a % 4;
  const rowB = Math.floor(b / 4);
  const colB = b % 4;
  return Math.abs(rowA - rowB) <= 1 && Math.abs(colA - colB) <= 1 && a !== b;
}

function findPath(grid, word) {
  const used = new Set();
  const path = [];

  function search(position) {
    if (position === word.length) return true;
    for (let index = 0; index < 16; index += 1) {
      if (used.has(index)) continue;
      if (grid[index].toLowerCase() !== word[position]) continue;
      if (path.length && !areAdjacent(path[path.length - 1], index)) continue;
      used.add(index);
      path.push(index);
      if (search(position + 1)) return true;
      path.pop();
      used.delete(index);
    }
    return false;
  }

  return search(0) ? [...path] : null;
}

test('real-time multiplayer flow stays in sync', async (t) => {
  const server = createGameServer({
    log: quietLog,
    resultDelayMs: 120,
    hostTransferMs: 120,
    offlineRemoveMs: 60_000,
  });
  await server.start(0, '127.0.0.1');
  const { port } = server.server.address();
  const url = `ws://127.0.0.1:${port}/ws`;
  const clients = [];

  t.after(async () => {
    for (const client of clients) client.close();
    await server.close();
  });

  const host = new Client(url);
  clients.push(host);
  await host.open();
  await host.next((message) => message.type === 'hello');

  host.send({ type: 'create', name: 'Ana', avatar: '🦊' });
  const hostSession = await host.next((message) => message.type === 'session');
  assert.match(hostSession.code, /^[A-Z0-9]{4}$/);
  const lobby = await host.nextState((room) => room.players.length === 1);
  assert.equal(lobby.room.status, 'lobby');
  assert.equal(lobby.room.hostId, hostSession.playerId);
  assert.equal(lobby.you.isHost, true);

  const guest = new Client(url);
  clients.push(guest);
  await guest.open();
  await guest.next((message) => message.type === 'hello');
  guest.send({ type: 'join', code: hostSession.code, name: 'Ben', avatar: '🐼' });
  const guestSession = await guest.next((message) => message.type === 'session');
  const guestLobby = await guest.nextState((room) => room.players.length === 2);
  assert.equal(guestLobby.room.status, 'lobby');
  assert.equal(guestLobby.room.players.length, 2);
  await host.nextState((room) => room.players.length === 2);

  host.send({ type: 'start' });
  const hostPlaying = await host.nextState((room) => room.status === 'playing');
  const guestPlaying = await guest.nextState((room) => room.status === 'playing');
  assert.equal(hostPlaying.room.grid.join(''), guestPlaying.room.grid.join(''));
  assert.ok(hostPlaying.room.roundEndsAt > Date.now());

  const words = [...findBoardWords(hostPlaying.room.grid, server.dictionary.trie)]
    .filter((word) => word.length >= 4)
    .sort((a, b) => a.length - b.length);
  assert.ok(words.length > 0, 'the generated board should contain words');
  const word = words[0];
  const path = findPath(hostPlaying.room.grid, word);
  assert.ok(path, `expected a path for ${word}`);

  guest.send({ type: 'claim', word, path });
  const claimOk = await guest.next((message) => message.type === 'claimOk');
  assert.equal(claimOk.word, word);
  assert.ok(claimOk.points >= 2);

  const guestAfter = await guest.nextState((room) => room.players.some((player) => player.score > 0));
  const hostAfter = await host.nextState((room) => room.players.some((player) => player.score > 0));
  const guestPlayer = guestAfter.room.players.find((player) => player.id === guestSession.playerId);
  const hostVisibleGuest = hostAfter.room.players.find((player) => player.id === guestSession.playerId);
  assert.equal(guestPlayer.score, claimOk.points);
  assert.equal(hostVisibleGuest.score, claimOk.points);
  assert.ok(guestAfter.you.words.some((entry) => entry.word === word));
  assert.ok(hostAfter.room.feed.some((item) => item.kind === 'word' && item.length === word.length));
  assert.equal(JSON.stringify(hostAfter.room.feed).includes(word), false, 'other players must not see the word during play');
  assert.equal(hostAfter.room.results, null);

  const room = server.manager.rooms.get(hostSession.code);
  server.manager.endRound(room);
  const hostResults = await host.nextState((roomState) => roomState.status === 'roundResult');
  const guestResults = await guest.nextState((roomState) => roomState.status === 'roundResult');
  assert.ok(hostResults.room.results.some((result) => result.words.some((entry) => entry.word === word)));
  assert.equal(guestResults.room.results[0].roundPoints, claimOk.points);

  const hostNextRound = await host.nextState((roomState) => roomState.status === 'playing' && roomState.roundNumber === 2);
  assert.notEqual(hostNextRound.room.grid.join(''), hostPlaying.room.grid.join(''));

  host.close();
  const guestNewHost = await guest.nextState((roomState) => roomState.hostId === guestSession.playerId, 3000);
  assert.equal(guestNewHost.you.isHost, true);

  const reconnectedHost = new Client(url);
  clients.push(reconnectedHost);
  await reconnectedHost.open();
  await reconnectedHost.next((message) => message.type === 'hello');
  reconnectedHost.send({ type: 'resume', code: hostSession.code, token: hostSession.token });
  const resumedSession = await reconnectedHost.next((message) => message.type === 'session');
  assert.equal(resumedSession.playerId, hostSession.playerId);
  const resumedState = await reconnectedHost.nextState((roomState) => roomState.players.length === 2);
  assert.equal(resumedState.room.status, 'playing');
  assert.equal(resumedState.you.isHost, false);
  assert.equal(resumedState.room.hostId, guestSession.playerId);

  await sleep(20);
  const health = await fetch(`http://127.0.0.1:${port}/healthz`).then((response) => response.json());
  assert.equal(health.ok, true);
  assert.ok(health.rooms >= 1);
});
