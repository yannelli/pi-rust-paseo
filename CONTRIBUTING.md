# Contributing

Thanks for helping with Pi Rust for Paseo. Bug reports, ideas, docs fixes, and code are all welcome. This guide covers the setup, the checks, and how a change becomes a release.

## Quick start

You need Node.js 24 (see `.nvmrc`). To try the plugin in Paseo, you also need Paseo 0.15.0 or newer and [Pi Rust](https://github.com/yannelli/pi-rust).

```sh
git clone https://github.com/yannelli/pi-rust-paseo.git
cd pi-rust-paseo
npm ci
npm run check
```

`npm run check` must pass before you open a pull request. It runs:

| Command | What it does |
| --- | --- |
| `npm run typecheck` | Type checks all TypeScript |
| `npm test` | Compiles `shared/`, `server/`, and `test/` and runs them with `node --test`, plus the release script tests |

The tests use a fake `pi` that answers RPC requests, a fake workflow runner, real short-lived processes for background tasks, and temporary agent directories. They do not call a model provider and do not touch your `~/.pi`.

## Try your change in Paseo

1. Turn on **Enable plugins** in **Settings → Plugins**.
2. Install your checkout:

   ```sh
   paseo plugin add "$PWD"
   paseo plugin ls pi-rust
   ```

3. After each edit, type check and reload the plugin. If something fails, read its output:

   ```sh
   npm run typecheck
   paseo plugin reload pi-rust
   paseo plugin logs pi-rust
   ```

Check a change on a wide window and on a phone or narrow window, in a dark and a light theme.

## Where things live

| Path | Contents |
| --- | --- |
| `index.client.tsx`, `client/` | App code: the Pi Rust screen, the Workflows panel, the run card, the status pill, settings |
| `index.server.ts`, `server/` | Daemon code: pi commands, workflow files, the runner protocol, status readers, agent tools |
| `shared/` | Code both sides import: Zod contracts, the workflow format and validation, plain helpers |
| `test/` | Tests |
| `scripts/release*.mjs` | The release script |
| `scripts/snapshots/` | The screenshot renderer and its demo data |

Paseo compiles each side from its entry. App code must not import `server/` or Node modules, daemon code must not import `client/`, and `shared/` imports neither.

## Make a change

- Keep the plugin compatible with pi: the workflow format in `shared/workflow.ts` mirrors `extensions/workflows/src/model.rs` in [pi-rust-extensions](https://github.com/yannelli/pi-rust-extensions), field for field and message for message. Change both together.
- App code uses React Native primitives only (`View`, `Text`, `Pressable`, `ScrollView`, `TextInput`), takes every color from the theme, and checks `layout.compact`. No HTML elements, `className`, or DOM globals.
- Use the primitives in `client/ui.tsx` and the workspace helpers in `client/workspaces.tsx` rather than new styles.
- Add a test for new behavior in `shared/` or `server/`. Tests must not call a real model provider.
- Keep comments short, and only where the code cannot say it.

## Commit messages and pull request titles

Use [Conventional Commits](https://www.conventionalcommits.org). The release script reads them to choose the next version:

| Type | Example | Release |
| --- | --- | --- |
| `fix` | `fix(status): count lost background tasks as failed` | patch |
| `perf`, `revert` | `perf(runs): read run.json once per poll` | patch |
| `feat` | `feat(workflows): copy a workflow between workspaces` | minor |
| `!` or `BREAKING CHANGE:` | `feat(settings)!: rename the runner setting` | major |
| `docs`, `test`, `refactor`, `chore`, `ci`, `style`, `build` | `docs: explain project trust` | none |

Write pull request titles in the same form: a squash merge makes the title the commit message.

## Pull request checklist

- `npm run check` passes.
- New behavior has a test.
- UI changes work on a phone width and in both themes. If a change alters a screen shown in the README, render the screenshots again.
- The README and `OVERVIEW.md` describe any change people will notice.
- One change per pull request.

## Report a bug

Open an issue with:

- the Paseo version (`paseo --version`), the pi version (`pi --version`), and the operating system;
- what you did, what you expected, and what happened;
- the output of `paseo plugin logs pi-rust`, with paths or names you consider private removed.

## Security problems

Do not open a public issue. See [SECURITY.md](SECURITY.md).

## Screenshots

The README images come from `scripts/snapshots`. It renders the plugin's real components with react-native-web against made-up data: a developer called Ada with an `acme-api` repository, two worktrees, demo runs, background tasks, a goal, and a timer. Nothing from your machine appears in them.

```sh
npm --prefix scripts/snapshots ci
npm run snapshots
```

It writes `assets/screenshots/*.png` and `assets/hero.png`. It needs Chromium: set `CHROME_PATH`, run `npx playwright install chromium`, or have Google Chrome installed.

## Releases

Every push to `main` runs the release workflow. It looks at the commits since the last `vX.Y.Z` tag and, if any is a `fix`, `perf`, `revert`, `feat`, or breaking change, it:

1. sets the next version in `package.json` and `package-lock.json`,
2. adds the release notes to the top of `CHANGELOG.md`,
3. commits `chore(release): X.Y.Z`, tags `vX.Y.Z`, and pushes both,
4. publishes a GitHub release with the notes.

Do not edit the version or the changelog by hand. `npm run release:dry-run` prints the notes of the next release.

When GitHub Actions cannot run, a maintainer can run the same release from a clean, up-to-date `main`:

```sh
GH_TOKEN="$(gh auth token)" GITHUB_REPOSITORY=yannelli/pi-rust-paseo node scripts/release.mjs --publish
```

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
