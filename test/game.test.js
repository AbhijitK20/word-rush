import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findBoardWords,
  generateBoard,
  isValidPath,
  loadDictionary,
  scoreWord,
  validateName,
} from '../src/game.js';

const dictionary = loadDictionary();
const grid = [
  'A', 'B', 'C', 'D',
  'E', 'F', 'G', 'H',
  'I', 'J', 'K', 'L',
  'M', 'N', 'O', 'P',
];

test('scoreWord follows the published scoring table', () => {
  assert.equal(scoreWord(2), 0);
  assert.equal(scoreWord(3), 1);
  assert.equal(scoreWord(4), 2);
  assert.equal(scoreWord(5), 3);
  assert.equal(scoreWord(6), 5);
  assert.equal(scoreWord(7), 8);
  assert.equal(scoreWord(8), 12);
  assert.equal(scoreWord(12), 12);
  assert.equal(scoreWord(13), 0);
  assert.equal(scoreWord('tiger'), 3);
});

test('isValidPath accepts adjacent paths and rejects bad ones', () => {
  assert.equal(isValidPath(grid, [0, 1, 2], 'abc'), true);
  assert.equal(isValidPath(grid, [0, 4, 8], 'aei'), true);
  assert.equal(isValidPath(grid, [0, 5, 10], 'afk'), true);
  assert.equal(isValidPath(grid, [0, 2, 3], 'acd'), false, 'non-adjacent step');
  assert.equal(isValidPath(grid, [0, 1, 0], 'aba'), false, 'reused tile');
  assert.equal(isValidPath(grid, [0, 1], 'ab'), false, 'too short');
  assert.equal(isValidPath(grid, [0, 1, 2], 'abd'), false, 'wrong letters');
  assert.equal(isValidPath(grid, [0, 1, 2, 3], 'abc'), false, 'path length mismatch');
  assert.equal(isValidPath(grid, [0, 1, 99], 'abc'), false, 'out of range');
  assert.equal(isValidPath(grid, [0, 1, '2'], 'abc'), false, 'non-integer index');
});

test('generated boards are playable and consistent', () => {
  for (let i = 0; i < 8; i += 1) {
    const board = generateBoard(dictionary);
    assert.equal(board.grid.length, 16);
    for (const letter of board.grid) {
      assert.match(letter, /^[A-Z]$/);
    }
    assert.ok(board.words.size >= 20, `board ${i} had only ${board.words.size} words`);
    const recomputed = findBoardWords(board.grid, dictionary.trie);
    assert.deepEqual([...board.words].sort(), [...recomputed].sort());
    for (const word of board.words) {
      assert.match(word, /^[a-z]{3,12}$/);
      assert.ok(word.length >= 3 && word.length <= 12);
    }
  }
});

test('names are cleaned and screened', () => {
  assert.equal(validateName('  Sam  ', dictionary.blocked).name, 'Sam');
  assert.equal(validateName('Maya_7', dictionary.blocked).ok, true);
  assert.equal(validateName('A', dictionary.blocked).ok, false);
  assert.equal(validateName('Sam <script>', dictionary.blocked).name, 'Sam script');
  assert.equal(validateName({ name: 'Sam' }, dictionary.blocked).ok, false);

  const blockedWord = [...dictionary.blocked].find((word) => /^[a-z]{3,}$/.test(word));
  assert.ok(blockedWord, 'blocklist should contain a testable word');
  assert.equal(validateName(blockedWord, dictionary.blocked).ok, false);
});
