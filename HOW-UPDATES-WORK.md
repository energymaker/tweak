# Keeping Tweak up to date

Three ways to move a change onto your machine, from least to most effort saved.

## 1. Testing a change: no installer needed

```
npm start
```

That opens Tweak from the source you have. Use this while trying things. You only need `npm run dist` when you want the version in your Start menu, or a file to give someone else.

## 2. Your own copy, updated with one command

Put this folder in a Git repository once:

```
git init
git add .
git commit -m "Tweak"
```

Then, when there are changes, applying them is `git pull` (if you host it) and `npm start`. Your Claude Code on this computer can also apply changes straight into the folder, so nothing is downloaded at all.

## 3. Everyone else: updates arrive on their own

The app already knows how to update itself. Two things to set up once:

1. Make a GitHub repository (it can be private) and put this folder in it.
2. In `package.json`, change `build.publish.owner` to your GitHub username, and `repo` if you name it something other than `tweak`.

From then on:

```
git tag v1.6.1
git push origin v1.6.1
```

GitHub builds the installer for Windows by itself (see `.github/workflows/build.yml`) and publishes it. Every copy of Tweak checks on startup, asks the person whether they want it, downloads in the background and installs when they close the app. Nobody visits a download page again.

Notes:

- The version in `package.json` and the tag must match.
- A private repository needs a token in the app to download updates; a public one does not. Public is simpler while you are starting.
- Windows will still warn about an unsigned app until you buy a code signing certificate.
