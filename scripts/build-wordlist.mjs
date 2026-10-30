import fs from 'node:fs/promises';

const URLS = {
  frequent: 'https://raw.githubusercontent.com/first20hours/google-10000-english/master/20k.txt',
  enable: 'https://raw.githubusercontent.com/dolph/dictionary/master/enable1.txt',
  blocked: 'https://raw.githubusercontent.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words/master/en',
};

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not fetch ${url}: ${response.status}`);
  return response.text();
}

const [frequentRaw, enableRaw, blockedRaw] = await Promise.all([
  fetchText(URLS.frequent),
  fetchText(URLS.enable),
  fetchText(URLS.blocked),
]);

const enable = new Set(enableRaw.split(/\s+/).filter((word) => /^[a-z]{3,12}$/.test(word)));
const blocked = [...new Set(blockedRaw
  .split(/\r?\n/)
  .map((word) => word.trim().toLowerCase())
  .filter((word) => /^[a-z]{2,}$/.test(word)))].sort();

const blockedSet = new Set(blocked);
const words = [...new Set(frequentRaw
  .split(/\s+/)
  .filter((word) => /^[a-z]{3,12}$/.test(word) && enable.has(word) && !blockedSet.has(word)))]
  .sort();

await fs.mkdir('data', { recursive: true });
await fs.writeFile('data/words.txt', `${words.join('\n')}\n`);
await fs.writeFile('data/blocked.txt', `${blocked.join('\n')}\n`);
console.log(`Wrote ${words.length} words and ${blocked.length} blocked terms.`);
