# Tweak

Change the websites you use by describing what you want. Open models running on your own computer write the change, a real browser tests it on the page, and you decide whether to keep it.

Everything runs on your machine. Nothing is sent anywhere unless you choose to use a bigger model online.

## Getting it running

You need Node.js 20 or newer once, to build the app. After that it is a normal program.

1. Unzip this folder.
2. Open a terminal in it and run:

   ```
   npm install
   npm start
   ```

   That opens Tweak. Nothing else to download: the test browser is part of the app.

3. To make a proper installer you can double-click from then on:

   ```
   npm run dist
   ```

   The installer appears in the `dist` folder as `Tweak-Setup-1.0.0.exe` on Windows, a `.dmg` on a Mac, or an AppImage on Linux. Install it once and Tweak lives in your Start menu like any other program.

## What you need

- **Ollama**, with at least one model, for the free local part. `ollama pull qwen2.5-coder:7b` is the one that does best in testing.
- Optionally a **Hugging Face token**, added in Settings, so a bigger model can take over when a change is too hard for the local one. That part uses your own account and costs about a penny per rescue.

## How to use it

1. Type the address of the page and what you want changed.
2. Tweak reads the page, writes the change, tests it, and fixes it up to three times.
3. You get one of three honest answers:
   - **Works**: the checks passed and at least one of them was false before, so the test proves it.
   - **Not proven**: the checks passed but were already true. Look at the screenshots.
   - **Didn't work**: it could not get there.
4. Open **See and change the code** to edit it yourself, then **Test my changes** to prove your version the same way.
5. Press **Keep** to save it, then load it into Chrome: `chrome://extensions`, turn on Developer mode, Load unpacked, choose the folder.

Tick **Watch the test** to see the test browser while it works.

## The Tweak bar in Chrome

Change a page without leaving it. Press a shortcut, say what you want, watch it happen, keep it.

1. Open Tweak, go to **Settings**, and copy the folder shown under "The Tweak bar in Chrome" (it is `Tweak\chrome-bar` in your user folder).
2. In Chrome, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose that folder.
3. On any page press **Alt + Shift + T**, type what you want, press Enter.

The bar reads the page you are on, asks the app for a change, applies it in your own tab, and checks it there. Keep saves it like any other tweak. Tweak must be open for the bar to work, since the models live in the app.

Changes that need code running on the page are not supported in the bar yet: it will tell you and you can make those in the app.

## Cookie pages

Sites like YouTube and Google show a cookie page to a fresh browser. If Tweak says it hit one, click **Open test browser**, accept or reject it once, close that window, and try again. Your choice is remembered.

## What it will not do

Tweaks only change the page they run on. Tweak refuses code that makes network requests, reads cookies, uses `eval`, asks for browser permissions, or loads outside files. Extensions it writes ask for no permissions.

## Where your things are kept

In a folder called `Tweak` in your user folder:

- `tweaks/` the tweaks you kept
- `runs/` screenshots and every attempt
- `runs.jsonl` one line per run, so you can see how often it works
- `settings.json` your settings
- `cookies.json` the cookie choices you made in the test browser
- `what-worked.json` the selectors that worked on each site, used to make later tweaks on the same site better

## Checking how well it works

```
npm run bench -- ollama:qwen2.5-coder:7b
```

Ten everyday tasks on real sites, with the result of each measured by a real browser test. Add `--tasks 3` for a quick run, or `--fallback api:Qwen/Qwen3.8-27B` to let a bigger model take over after two failures.

## Settings you can change by hand

Set these as environment variables if you want to override what is in Settings:

| Variable | Default | What it does |
|---|---|---|
| `OLLAMA_HOST` | http://127.0.0.1:11434 | Where your local models run |
| `TWEAK_HF_TOKEN` | none | Hugging Face token for bigger models |
| `TWEAK_FALLBACK_MODEL` | none | The bigger model to fall back on |
| `TWEAK_HOME` | Tweak in your user folder | Where tweaks and records are kept |
| `TWEAK_SETTLE_MS` | 3500 | How long to wait for a page to finish loading |
| `TWEAK_NUM_CTX` | 8192 | Context size for local models |
| `TWEAK_MODEL_TIMEOUT` | 300 | Seconds to wait for one model answer |
