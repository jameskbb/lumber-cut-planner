# Lumber Cut Planner

**Use it now: [jameskbb.github.io/lumber-cut-planner](https://jameskbb.github.io/lumber-cut-planner/)**

Plan how to cut plywood sheets and boards into the parts for a project. Type in the stock you have and the parts you need, and the cut diagram updates as you type. You get a numbered cut order to tick off at the saw and a list of offcuts worth keeping.

Nothing to install and no account. It runs in your browser, on a phone or a laptop, and keeps working offline once it has loaded.

[![The cut plan for a small bookcase: two plywood sheets with numbered cuts and a checklist of cuts](docs/screenshot.png)](https://jameskbb.github.io/lumber-cut-planner/)

## How it works

1. **Add your stock.** Each sheet or board, its size, and how many you have.
2. **Add your parts.** Name, size and quantity. Lock a part's grain, or say which stock it must come from.
3. **Read the plan.** Each sheet is drawn with its cuts numbered. The cut order tells you where to rip and crosscut, measured from the edge, so you can follow it at the saw.

Open the app on first visit and it shows an example bookcase already laid out, so you can see a plan before typing anything.

## Features

- **Live layout.** The plan redraws as you type.
- **Real saw cuts.** Every cut runs edge to edge (guillotine cuts), so the plan works on a table saw or track saw. The blade kerf is taken out between parts.
- **Cut order with checkboxes.** Each sheet gets numbered rip and crosscut steps. Ticked cuts are remembered when you come back.
- **Grain direction.** Keep a part's length along the grain, or let the planner turn it for a better fit.
- **Mixed materials.** List several kinds of stock and choose which one each part is cut from, like ¾" plywood for the carcass and ¼" for the back.
- **Help when it doesn't fit.** Parts that don't fit are listed with the reason, and the app says how many more sheets to buy. Adding them is one click.
- **Sizes the way woodworkers write them.** `23 5/8`, `23-5/8`, `23.625`, `2' 6"` or `600mm` all work. Switch between inches and millimetres at any time.
- **Save and share.** Projects save automatically in your browser. You can also save to a file, open one, or share a link that carries the whole project.
- **Print.** One page per sheet, with the diagram and a paper checklist.
- **Phone friendly.** Add it to your home screen and it opens like an app.

## Privacy

Nothing leaves your device. Projects are stored in your browser's local storage. A share link carries the project inside the link itself, after the `#`, which browsers don't send to any server.

## Run it yourself

The live site above is the easiest way. To run a copy locally you need [Node.js](https://nodejs.org) 20 or newer; there are no dependencies to install:

```bash
git clone https://github.com/jameskbb/lumber-cut-planner.git
cd lumber-cut-planner
npm start
```

Then open http://localhost:8000. A local server is needed because browsers won't load JavaScript modules from `file://`.

To host your own copy, fork the repo and turn on GitHub Pages (**Settings → Pages → Deploy from a branch → `main` / root**). There's no build step; the files in the repo are the site.

## Develop

```bash
npm test
```

Tests use Node's built-in runner. They cover size parsing and formatting, project validation and share links, and check that random projects always produce plans that can really be built: parts inside the sheet, at least a kerf apart, grain respected, and no saw cut passing through a part.

| Path | What it does |
| --- | --- |
| `src/planner.js` | The cut planner. Pure functions with no browser code, so it can be reused elsewhere. |
| `src/units.js` | Parses and formats lengths (fractions, feet and inches, metric). |
| `src/store.js` | Project defaults, validation of files and links, share-link encoding. |
| `src/sheet-view.js` | Draws a sheet as SVG. |
| `src/app.js` | The interface. |
| `sw.js`, `manifest.webmanifest` | Offline support and home-screen install. |

## Legacy version

The original Python and Matplotlib script is in [`legacy/`](legacy/) for reference. The web app replaces it.

## Credits

The interface uses [Archivo](https://github.com/Omnibus-Type/Archivo) by Omnibus-Type, licensed under the SIL Open Font License ([`fonts/OFL.txt`](fonts/OFL.txt)).
