# Credits and licenses

## Word list

`data/words.txt` is derived from two sources:

- The **google-10000-english** 20,000-word list (Josh Kaufman), based on the Google Web Trillion Word Corpus, Peter Norvig’s frequency compilation, and LDC data. The upstream README permits educational and personal/research use. Review the upstream terms before commercial use.
- **ENABLE** (Enhanced North American Benchmark Lexicon), a public-domain word list commonly used by word games, used here to keep entries to real words.

Generation keeps lowercase alphabetic words of 3–12 letters that appear in both lists, removes entries present in the profanity blocklist, and sorts the result. The reproducible script is `scripts/build-wordlist.mjs`.

Source URLs:

- https://github.com/first20hours/google-10000-english
- https://github.com/dolph/dictionary
- https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words

`data/blocked.txt` is derived from the LDNOOBW English list, licensed under CC BY 4.0. It is used to screen player names and remove blocked words from the dictionary.

## Fonts

- **Fraunces** by Undercase Type — SIL Open Font License 1.1.
- **DM Sans** by Colophon Foundry and Google — SIL Open Font License 1.1.

Both are self-hosted from `public/fonts/`.

## Libraries

- Express — MIT
- ws — MIT
- qrcode — MIT
- compression — MIT
- playwright-core (development only) — Apache-2.0

## Artwork

The word tiles, favicon, colors, and layout are original to this project. Emoji glyphs are rendered by the player’s operating system.
