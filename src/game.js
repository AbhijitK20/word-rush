import fs from 'node:fs';
import path from 'node:path';

export const BOARD_SIZE = 4;
export const BOARD_CELLS = BOARD_SIZE * BOARD_SIZE;
export const MIN_WORD_LENGTH = 3;
export const MAX_WORD_LENGTH = 12;
export const MAX_NAME_LENGTH = 14;
export const MAX_PLAYERS = 10;

export const AVATARS = [
  '🦊', '🐼', '🐸', '🦁', '🐙', '🐝',
  '🦄', '🐯', '🐨', '🦉', '🐳', '🦖',
];

const DICE = [
  'AAEEGN', 'ABBJOO', 'ACHOPS', 'AFFKPS',
  'AOOTTW', 'CIMOTU', 'DEILRX', 'DELRVY',
  'DISTTY', 'EEGHNW', 'EEINSU', 'EHRTVW',
  'EIOSST', 'ELRTTY', 'HIMNQU', 'HLNNRZ',
];

const POINTS_BY_LENGTH = [0, 0, 0, 1, 2, 3, 5, 8, 12, 12, 12, 12, 12];

function shuffle(items, rng) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function buildTrie(words) {
  const root = Object.create(null);
  for (const word of words) {
    let node = root;
    for (const letter of word) {
      if (!node[letter]) node[letter] = Object.create(null);
      node = node[letter];
    }
    node.$ = 1;
  }
  return root;
}

export function loadDictionary(options = {}) {
  const dataDir = options.dataDir ?? path.resolve(process.cwd(), 'data');
  const wordsPath = options.wordsPath ?? path.join(dataDir, 'words.txt');
  const blockedPath = options.blockedPath ?? path.join(dataDir, 'blocked.txt');

  const blocked = new Set();
  if (fs.existsSync(blockedPath)) {
    for (const line of fs.readFileSync(blockedPath, 'utf8').split(/\r?\n/)) {
      const word = line.trim().toLowerCase();
      if (word) blocked.add(word);
    }
  }

  const words = new Set();
  for (const line of fs.readFileSync(wordsPath, 'utf8').split(/\r?\n/)) {
    const word = line.trim().toLowerCase();
    if (word.length < MIN_WORD_LENGTH || word.length > MAX_WORD_LENGTH) continue;
    if (!/^[a-z]+$/.test(word)) continue;
    if (blocked.has(word)) continue;
    words.add(word);
  }

  if (words.size < 500) {
    throw new Error(`Dictionary looks too small (${words.size} words). Check ${wordsPath}.`);
  }

  return {
    words,
    blocked,
    trie: buildTrie(words),
    wordsPath,
  };
}

export function rollGrid(rng = Math.random) {
  const rolledDice = shuffle(DICE, rng);
  return rolledDice.map((die) => {
    const letter = die[Math.floor(rng() * die.length)];
    return letter === 'Q' ? 'K' : letter;
  });
}

export function findBoardWords(grid, trie, maxLength = MAX_WORD_LENGTH) {
  if (!Array.isArray(grid) || grid.length !== BOARD_CELLS) {
    throw new Error(`A board must have ${BOARD_CELLS} cells.`);
  }

  const words = new Set();
  const used = new Uint8Array(BOARD_CELLS);

  function visit(index, node, text) {
    if (node.$) words.add(text);
    if (text.length >= maxLength) return;

    const row = Math.floor(index / BOARD_SIZE);
    const col = index % BOARD_SIZE;

    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        if (dr === 0 && dc === 0) continue;
        const nextRow = row + dr;
        const nextCol = col + dc;
        if (nextRow < 0 || nextRow >= BOARD_SIZE || nextCol < 0 || nextCol >= BOARD_SIZE) continue;

        const nextIndex = nextRow * BOARD_SIZE + nextCol;
        if (used[nextIndex]) continue;

        const letter = grid[nextIndex].toLowerCase();
        const nextNode = node[letter];
        if (!nextNode) continue;

        used[nextIndex] = 1;
        visit(nextIndex, nextNode, text + letter);
        used[nextIndex] = 0;
      }
    }
  }

  for (let index = 0; index < BOARD_CELLS; index += 1) {
    const letter = grid[index].toLowerCase();
    const node = trie[letter];
    if (!node) continue;
    used[index] = 1;
    visit(index, node, letter);
    used[index] = 0;
  }

  return words;
}

export function generateBoard(dictionary, options = {}) {
  const rng = options.rng ?? Math.random;
  const minWords = options.minWords ?? 20;
  const minLongWords = options.minLongWords ?? 2;
  const maxAttempts = options.maxAttempts ?? 400;

  let best = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const grid = rollGrid(rng);
    const words = findBoardWords(grid, dictionary.trie);
    const longWords = [...words].filter((word) => word.length >= 5).length;

    if (!best || words.size > best.words.size
      || (words.size === best.words.size && longWords > best.longWords)) {
      best = { grid, words, longWords };
    }

    if (words.size >= minWords && longWords >= minLongWords) {
      return { grid, words };
    }
  }

  if (!best || best.words.size < 8) {
    throw new Error('Could not generate a playable board. Check the dictionary.');
  }

  return { grid: best.grid, words: best.words };
}

export function normalizeWord(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKC').toLowerCase().replace(/[^a-z]/g, '');
}

export function scoreWord(word) {
  const length = typeof word === 'number' ? word : [...String(word)].length;
  if (length < MIN_WORD_LENGTH || length > MAX_WORD_LENGTH) return 0;
  return POINTS_BY_LENGTH[length] ?? 0;
}

export function isValidPath(grid, candidatePath, word) {
  if (!Array.isArray(grid) || grid.length !== BOARD_CELLS) return false;
  if (!Array.isArray(candidatePath)) return false;
  if (typeof word !== 'string' || word.length < MIN_WORD_LENGTH || word.length > MAX_WORD_LENGTH) return false;
  if (candidatePath.length !== word.length) return false;

  const seen = new Set();
  let previousIndex = null;

  for (let i = 0; i < candidatePath.length; i += 1) {
    const index = candidatePath[i];
    if (!Number.isInteger(index) || index < 0 || index >= BOARD_CELLS) return false;
    if (seen.has(index)) return false;
    seen.add(index);

    if (String(grid[index]).toLowerCase() !== word[i]) return false;

    if (previousIndex !== null) {
      const prevRow = Math.floor(previousIndex / BOARD_SIZE);
      const prevCol = previousIndex % BOARD_SIZE;
      const row = Math.floor(index / BOARD_SIZE);
      const col = index % BOARD_SIZE;
      const rowDistance = Math.abs(row - prevRow);
      const colDistance = Math.abs(col - prevCol);
      if (rowDistance > 1 || colDistance > 1 || (rowDistance === 0 && colDistance === 0)) return false;
    }

    previousIndex = index;
  }

  return true;
}

export function validateName(rawName, blocked = new Set()) {
  if (typeof rawName !== 'string') {
    return { ok: false, error: 'Please enter a name.' };
  }
  const cleaned = rawName
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[^\p{L}\p{N} '._-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

  const length = [...cleaned].length;
  if (length < 2 || length > MAX_NAME_LENGTH) {
    return { ok: false, error: `Name must be 2–${MAX_NAME_LENGTH} characters.` };
  }
  if (!/\p{L}/u.test(cleaned)) {
    return { ok: false, error: 'Please use at least one letter in your name.' };
  }

  const normalized = cleaned.toLowerCase();
  const tokens = normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (blocked.has(normalized) || tokens.some((token) => blocked.has(token))) {
    return { ok: false, error: 'Please pick a friendlier name.' };
  }

  return { ok: true, name: cleaned };
}

export function isValidAvatar(value) {
  return AVATARS.includes(value);
}

export { POINTS_BY_LENGTH };
