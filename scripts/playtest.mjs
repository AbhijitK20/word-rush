import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createGameServer } from '../src/app.js';
import { findBoardWords } from '../src/game.js';

const quietLog = { log() {}, warn() {}, error() {} };
const artifacts = path.resolve('test-artifacts');
fs.mkdirSync(artifacts, { recursive: true });

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
  function search(index) {
    if (index === word.length) return true;
    for (let cell = 0; cell < 16; cell += 1) {
      if (used.has(cell)) continue;
      if (grid[cell].toLowerCase() !== word[index]) continue;
      if (path.length && !areAdjacent(path[path.length - 1], cell)) continue;
      used.add(cell);
      path.push(cell);
      if (search(index + 1)) return true;
      path.pop();
      used.delete(cell);
    }
    return false;
  }
  return search(0) ? [...path] : null;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const server = createGameServer({
  log: quietLog,
  resultDelayMs: 1100,
  hostTransferMs: 15000,
  offlineRemoveMs: 60_000,
});
await server.start(0, '127.0.0.1');
const { port } = server.server.address();
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox'],
});

const errors = [];
const contextA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const pageA = await contextA.newPage();
const contextB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const pageB = await contextB.newPage();
const contextC = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});

for (const [name, page] of [['A', pageA], ['B', pageB]]) {
  page.on('pageerror', (error) => errors.push(`${name} pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`${name} console: ${message.text()}`);
  });
}

try {
  await pageA.goto(base);
  await pageA.waitForSelector('#create-btn:not([disabled])');
  await pageA.fill('#name-input', 'Ana');
  await pageA.click('#create-btn');
  await pageA.waitForSelector('#screen-lobby:not([hidden])');
  const roomCode = (await pageA.locator('#room-code').innerText()).replace(/[^A-Z0-9]/g, '');
  assert(/^[A-Z0-9]{4}$/.test(roomCode), `unexpected room code: ${roomCode}`);
  await pageA.waitForSelector('#qr-img');
  assert(await pageA.locator('#lobby-count').innerText() === '1/10', 'host lobby should show one player');

  await pageB.goto(base);
  await pageB.waitForSelector('#join-btn:not([disabled])');
  await pageB.fill('#name-input', 'Ben');
  await pageB.fill('#code-input', roomCode);
  await pageB.click('#join-btn');
  await pageB.waitForSelector('#screen-lobby:not([hidden])');
  await pageB.waitForFunction(() => document.querySelector('#lobby-count')?.textContent === '2/10');
  await pageA.waitForFunction(() => document.querySelector('#lobby-count')?.textContent === '2/10');

  await pageA.click('#start-btn');
  await pageA.waitForSelector('#screen-game:not([hidden])');
  await pageB.waitForSelector('#screen-game:not([hidden])');
  await pageA.waitForFunction(() => document.querySelectorAll('.tile').length === 16);

  const grid = await pageA.$$eval('.tile', (tiles) => tiles.map((tile) => tile.dataset.letter));
  const boardWords = [...findBoardWords(grid, server.dictionary.trie)]
    .filter((word) => word.length >= 3 && word.length <= 6)
    .sort((a, b) => a.length - b.length);
  let chosen = null;
  for (const word of boardWords) {
    const wordPath = findPath(grid, word);
    if (wordPath) {
      chosen = { word, path: wordPath };
      break;
    }
  }
  assert(chosen, `could not find a playable word on ${grid.join('')}`);

  for (const cell of chosen.path) {
    await pageA.click(`.tile[data-index="${cell}"]`);
  }
  const displayed = (await pageA.locator('#word-display').innerText()).replace(/\s+/g, '');
  assert(displayed === chosen.word.toUpperCase(), `word display showed ${displayed}, expected ${chosen.word.toUpperCase()}`);
  await pageA.click('#submit-btn');
  await pageA.waitForFunction(
    (word) => [...document.querySelectorAll('#your-words .word-chip')].some((chip) => chip.textContent.includes(word.toUpperCase())),
    chosen.word,
  );
  await pageB.waitForFunction(
    (wordLength) => [...document.querySelectorAll('#feed .feed-item')].some((item) => item.textContent.includes(`found a ${wordLength}-letter word`)),
    chosen.word.length,
  );
  const scoreA = Number((await pageA.locator('#scoreboard .scoreboard-score').first().innerText()).trim());
  assert(scoreA > 0, 'host score should increase after a valid word');
  await pageA.waitForTimeout(350);
  await pageA.screenshot({ path: path.join(artifacts, 'desktop-game.png'), fullPage: false });

  const room = server.manager.rooms.get(roomCode);
  assert(room, 'room should exist on the server');
  server.manager.endRound(room);
  await pageA.waitForSelector('#results-overlay:not([hidden])');
  await pageB.waitForSelector('#results-overlay:not([hidden])');
  const resultsText = await pageA.locator('#results-list').innerText();
  assert(resultsText.includes(chosen.word.toUpperCase()), 'round results should reveal the claimed word');
  await pageA.waitForTimeout(350);
  await pageA.screenshot({ path: path.join(artifacts, 'desktop-round-results.png'), fullPage: false });

  await pageA.waitForFunction(() => document.querySelector('#round-current')?.textContent === '2', null, { timeout: 8000 });
  await pageA.waitForSelector('#results-overlay', { state: 'hidden' });

  await pageA.reload();
  await pageA.waitForSelector('#screen-game:not([hidden])', { timeout: 8000 });
  await pageA.waitForFunction(() => document.querySelectorAll('.tile').length === 16);
  assert((await pageA.locator('#round-current').innerText()) === '2', 'host should reconnect to the current round');

  const pageC = await contextC.newPage();
  pageC.on('pageerror', (error) => errors.push(`C pageerror: ${error.message}`));
  pageC.on('console', (message) => {
    if (message.type() === 'error') errors.push(`C console: ${message.text()}`);
  });
  await pageC.goto(base);
  await pageC.waitForSelector('#join-btn:not([disabled])');
  await pageC.fill('#name-input', 'Cleo');
  await pageC.fill('#code-input', roomCode);
  await pageC.click('#join-btn');
  await pageC.waitForSelector('#screen-game:not([hidden])', { timeout: 8000 });
  await pageC.waitForFunction(() => document.querySelectorAll('.tile').length === 16);
  await pageC.waitForTimeout(350);
  await pageC.screenshot({ path: path.join(artifacts, 'mobile-game.png'), fullPage: false });

  server.manager.endRound(room);
  await pageA.waitForSelector('#results-overlay:not([hidden])');
  await pageA.waitForFunction(() => document.querySelector('#round-current')?.textContent === '3', null, { timeout: 8000 });
  server.manager.endRound(room);
  await pageA.waitForSelector('#results-overlay:not([hidden])');
  const finalTitle = await pageA.locator('#overlay-title').innerText();
  assert(/wins|tie|Game over/i.test(finalTitle), `unexpected final title: ${finalTitle}`);
  assert(await pageA.locator('#overlay-leave-btn').isVisible(), 'final overlay should offer a leave button');
  await pageA.waitForTimeout(500);
  await pageA.screenshot({ path: path.join(artifacts, 'desktop-final.png'), fullPage: false });
  await pageC.waitForTimeout(500);
  await pageC.screenshot({ path: path.join(artifacts, 'mobile-final.png'), fullPage: false });

  await pageA.click('#rematch-btn');
  await pageA.waitForFunction(() => document.querySelector('#round-current')?.textContent === '1', null, { timeout: 8000 });
  await pageA.waitForSelector('#results-overlay', { state: 'hidden' });
  const scoreAfterRematch = Number((await pageA.locator('#scoreboard .scoreboard-score').first().innerText()).trim());
  assert(scoreAfterRematch === 0, 'rematch should reset scores');

  if (errors.length) {
    throw new Error(`browser errors:\n${errors.join('\n')}`);
  }

  console.log(`UI flow passed in room ${roomCode}. Word: ${chosen.word.toUpperCase()} (+${scoreA}).`);
  console.log(`Screenshots written to ${artifacts}`);
} finally {
  await browser.close();
  await server.close();
}
