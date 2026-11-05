# Changelog

All notable changes to this project are documented here. Versions follow [Semantic Versioning](https://semver.org); the release workflow writes new entries from [Conventional Commits](https://www.conventionalcommits.org).

## [0.1.1] - 2026-11-05

### Fixes and performance

- fix: install from Git without node_modules (6690e2c)

Changes since v0.1.0.

## [0.1.0] - 2026-11-05

First release.

### Features

- Pi Rust screen with Overview, Extensions, Workflows, Runs, and Sessions tabs, and a workspace picker that lists Paseo workspaces by project and branch.
- Overview: pi version and binary, updates for pi, extensions, and model catalogs, the default model, `pi doctor`, subscription limits, usage by model, and a `settings.json` editor.
- Extensions: switches for built-in and installed extensions, package update and removal, the marketplace, and installs from npm, Git, a URL, or a path, globally or per workspace.
- Workflows: pipeline cards, a form and JSON editor with pi's validation, drafts written by a model, and the main checkout's workflows inside its worktrees. New workflows default to `anthropic/claude-opus-5-5` at medium thinking.
- Runs: start in this workspace, another workspace, or a new worktree; a live view with a step timeline, streaming output, reports, memory, and the runner log; approve, skip, stop, resume, steer, and switch between background and foreground.
- Status pill in each agent's composer with background tasks, workflow runs, goals, and timers, and their full status in a popover.
- `/workflow` and `/pi-ext` composer commands, a live run card in agent timelines, and the `pi_workflows` and `pi_extensions` agent tools.
- Workflows panel for each workspace, Command Center items, and plugin settings.
