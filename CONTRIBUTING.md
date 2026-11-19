# Working on Matriarch

[DESIGN.md](DESIGN.md) explains how Matriarch works and why; read its overview before changing
the engine. [SECURITY.md](SECURITY.md) says how to report a vulnerability privately.

## Develop

```sh
pnpm install            # TypeScript, and Node's typings
pnpm types              # Orca's plugin typings, into .orca/ (from Orca, or from GitHub without it)
pnpm verify             # typecheck, orca plugin test, orca plugin validate, binary check
pnpm preview            # the panel with sample data at http://127.0.0.1:8765
orca plugin dev load .  # run it in Orca; it reloads as you edit
```

Run `pnpm types` before `pnpm typecheck`: without Orca's typings, `tsc` writes `.js` files next
to the sources, and the tests then run twice.

The repository root is the plugin, and Orca installs every tracked file in it. `node_modules`
is flat with no symlinks (`pnpm-workspace.yaml`), because Orca refuses to load a folder that
holds one.

Tests never start a process: every command goes through an injected `Exec`, and Orca's host is
Orca's own mock. What Orca's CLI answers is pinned by recordings of the real thing under
`src/testing/` (such as `orca-1.4.263-worker-list.json`, with names and paths replaced): when
Orca changes a shape Matriarch reads, record the new one beside it and keep the old test passing
while Matriarch still supports that Orca.

CI runs the same checks on every push and pull request, with the Orca CLI from the Linux package
of the Orca in `config.orcaVersion`. Every Monday it runs them on Orca's newest release too, and
the Actions tab can run both by hand. CI cannot run Orca itself, so before a release that moves
to a newer Orca, run Matriarch on a real project with that Orca and record what it answers.

## Releasing

1. Raise `version` in `orca-plugin.json` and `PLUGIN_VERSION` in `src/worker.ts` (a test keeps
   them equal), and add the version to `CHANGELOG.md`. When moving to a newer Orca, raise
   `config.orcaVersion` in `package.json`, `TESTED_ORCA` and `engines.orca` together (a test
   keeps them equal), and set `config.orcaDebSha512` to the sha512 that release's
   `latest-linux.yml` gives `orca-ide_<version>_amd64.deb` (`gh release download v<version> -R
   stablyai/orca -p latest-linux.yml -O -`).
2. `pnpm verify`, then commit.
3. Tag the commit and push the tag:

   ```sh
   git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z
   ```

4. Publish a GitHub release for the tag, with that version's `CHANGELOG.md` section as its notes:
   `gh release create vX.Y.Z --verify-tag --title "Matriarch X.Y.Z" --notes-file <section>`.

Orca's community catalog lists a repository with the `orca-plugin` topic at its newest `vX.Y.Z`
tag, pinned to its commit and file hash, on its next run after the tag is pushed. A plugin that
runs code may first be held for an Orca maintainer to read it. Its status page is
<https://orca.dev/plugins/verifiedorganic/orca-matriarch> (the plugin page users install from is
`/plugins/verifiedorganic.matriarch`); when a version is held back, the
repository's entry in the catalog's
[`status.json`](https://github.com/stablyai/orca-community-plugins/blob/main/status.json) says
why. A listed version never changes, and its tag cannot be moved: a mistake takes a new version.

## Screenshots and listing art

`docs/*.png` and `assets/screenshot-1.png`, `-2.png` are the panel drawn by `pnpm preview`, always
with `?clean=1` (no sample warnings):

| Image | Query | Window |
| --- | --- | --- |
| `docs/timeline.png`, `assets/screenshot-1.png` | `&page=all&log=1` | 1280×800 |
| `docs/board.png` | `&view=board` | 1280×780 |
| `assets/screenshot-2.png` | `&view=board` | 1280×800 |
| `docs/sidebar.png` | `&width=400` | 400×712 at 2× |
| `docs/settings.png` | `&width=400&page=settings` | 400×1060 at 2× |
| `docs/picker.png` | `&width=400&page=picker&q=deep` | 400×1400 at 2×, cropped to 800×1240 from y 1020 |

`assets/icon.png` (256×256), `assets/cover.png` (1600×1000) and `assets/screenshot-3.png`
(1280×800) are drawn from `art/*.html` (the cover and `screenshot-3` show `docs/sidebar.png` and
`docs/settings.png`, so take those first): open each at that size and save it as PNG. The plugin
page shows only the middle band of the cover (about y 380 to 620), so the name and tagline stay
inside it.
