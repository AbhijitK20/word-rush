# Data files

- `words.txt` is the dictionary used for board generation and word validation. Every entry is lowercase, alphabetic, and 3–12 letters.
- `blocked.txt` is used to reject player names and to keep the dictionary clean.

The committed files are enough to run the app. To regenerate them from the upstream sources:

```bash
npm run words:build
```

See `../NOTICE.md` for sources and licenses.
