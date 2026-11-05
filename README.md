![Pi Rust for Paseo: a live workflow run in the Pi Rust screen, with the status popover of a pi agent in front of it](assets/hero.png)

# Pi Rust for Paseo

A [Paseo](https://paseo.sh) plugin for [Pi Rust](https://github.com/yannelli/pi-rust). Manage pi, its extensions, Claude Code plugins, skills, prompts, context, and the `workflows` extension's multi-agent workflows from desktop or your phone. Paseo and pi's TUI use the same files and commands, so a change in one shows up in the other.

- See pi's version, health, default model, subscription limits, and usage. Update pi, extensions, and model catalogs.
- Turn extensions on and off, update or remove packages, and install from the marketplace, npm, Git, or a path, globally or for one workspace.
- Run any extension's commands, edit its config files, and manage deferred's rules for tools, skills, context files, and prompt sections.
- Add Claude Code plugin marketplaces, and install, update, turn off, and uninstall their plugins.
- See every skill and prompt template pi loads, from every folder, plugin, and package. Turn them on and off, edit them, and create new ones.
- Edit SYSTEM.md, APPEND_SYSTEM.md, and the AGENTS.md and CLAUDE.md files pi loads for a workspace, and check their `@path` includes.
- Create, edit, copy, and delete workflows in a form or as JSON, with the same validation as pi. A model can draft one from a description.
- Start a run in the current workspace, another workspace, or a new worktree. Watch the step timeline, agent output, reports, and memory live.
- Approve or skip waiting tasks, end waits, message working agents, and stop, resume, or delete runs.
- See each agent's background tasks, runs, goal, and timers in a pill in its composer.
- Give Paseo agents tools to run workflows and manage extensions.

## Table of contents

- [What you need](#what-you-need)
- [Install](#install)
- [Use](#use)
  - [Overview](#overview)
  - [Extensions](#extensions)
  - [Claude plugins](#claude-plugins)
  - [Skills](#skills)
  - [Context](#context)
  - [Workflows](#workflows)
  - [Runs](#runs)
  - [Status in the chat](#status-in-the-chat)
  - [Composer and agents](#composer-and-agents)
- [Settings](#settings)
- [Data and permissions](#data-and-permissions)
- [How it works](#how-it-works)
- [Development](#development)
- [Releases](#releases)
- [Credits](#credits)
- [License](#license)

![Overview with tiles for pi, extensions, workflows, and runs, the default model, maintenance actions, health, and subscription limits](assets/screenshots/overview.png)

![A running workflow: the step timeline on the left, and the docs-check step's output on the right with tool calls and a message from the user](assets/screenshots/run.png)

![Workflows of a worktree: one saved in the worktree, one from the main checkout with a Run here button, and global workflows drawn as pipelines of steps](assets/screenshots/workflows.png)

![Three phone screens: runs in a worktree, the status popover with background tasks and an approval, and the overview in the light theme](assets/screenshots/mobile.png)

The screenshots use sample data. See [CONTRIBUTING.md](CONTRIBUTING.md#screenshots) to render them again.

## What you need

- Paseo 0.15.0 or newer, with **Enable plugins** turned on in **Settings → Plugins**.
- [Pi Rust](https://github.com/yannelli/pi-rust) on the machine that runs the Paseo daemon.
- Workflows need the `workflows` extension. Run `pi install marketplace:workflows` or install it from the plugin's Extensions tab. The status pill also reads the `background-tasks`, `goal`, and `timers` extensions when they are installed.

## Install

```sh
paseo plugin add github:yannelli/pi-rust-paseo
paseo plugin ls pi-rust
```

To pin a release, add `--ref` and a tag, for example `--ref v0.3.0`. Plugins run trusted code with the daemon user's access.

The plugin finds pi through its settings, then `$PI_BIN`, then `pi` on the daemon's `PATH`, `~/.local/bin`, or `~/.cargo/bin`. It reads `~/.pi/agent` unless `PI_CODING_AGENT_DIR` or the plugin settings name another directory.

## Use

Open **Pi Rust** from the sidebar or the Command Center (**⌘K**). Use the workspace picker at the top to choose the project for settings, extensions, workflows, and sessions. It lists Paseo workspaces by project and branch and remembers your choice.

### Overview

Tiles show pi's version, enabled extensions, workflows, and runs. Below them, you can change the default model, update pi, extensions, or model catalogs, run `pi doctor`, check subscription limits, and read usage by model. **Use claude-opus-5-5 · medium** sets the recommended model. **settings.json** edits pi's global or workspace settings.

### Extensions

Switch built-in and installed extensions on or off, update or remove packages, search the marketplace, and install from `npm:`, `git:`, a URL, or a path. **Global** changes `~/.pi/agent/settings.json`; **This workspace** changes the workspace's `.pi/settings.json`. Running pi sessions pick up changes on `/reload`.

![Extensions as a grid of cards with switches, followed by packages and the marketplace](assets/screenshots/extensions.png)

Tap an extension to manage it:

- **Commands.** Run its slash commands, such as `/deferred status`, `/goal-status`, `/todos`, or `/bg-clear`, and read their output. Each runs in a temporary pi session in the workspace; a command that would start an agent turn is stopped, and questions that need pi's UI are cancelled.
- **Config files.** Edit `ext/<name>.json` in pi's agent directory and in the workspace's `.pi` folder.
- **Docs.** Open the extension's README.

**deferred** gets its own manager. It lists every rule from the 5 places the extension reads (global and workspace `deferred.json`, the global and workspace `deferred` setting, and repo blocks) in the order they apply, with a one-tap mode switch for each: `on`, `names`, `deferred`, `user` (skills), or `off`. Add a rule for tools, skills, context files, or prompt sections, globally, for the workspace, or for the workspace's GitHub repository, with suggestions from pi's skills, MCP servers, and tools. **Check a name** shows which rule decides a tool or skill. It also sets `auto` and `maxResults` and shows `/deferred status`. Rules in `deferred.json` files are read-only, as in pi.

![The deferred manager: status, options, a name check that resolves mcp__github__delete_repo to off by a repo rule, and the tool rules with mode switches](assets/screenshots/deferred.png)

### Claude plugins

The `claude-marketplace` extension installs Claude Code plugins into pi: their commands become prompt templates, and their skills, agents, hooks, and MCP servers load in pi sessions. The tab lists your marketplaces and their plugins.

- **Add marketplace** takes a GitHub `owner/repo`, a git URL, a local folder, or `claude-plugins-official`, for every workspace or for this one. **Import from Claude Code** adds the marketplaces and plugins of your Claude Code settings.
- Each marketplace has an auto-update switch, **Update**, and **Remove**.
- Install a plugin for every workspace or for this one. Its switch turns it off (pi stops loading what it added) and on again. **Update**, **Reinstall**, and **Uninstall** are in its row, with the skills, commands, agents, hooks, and MCP servers it added, and the parts pi does not support.

Each change runs `/claude-plugins …` in a temporary pi session, just as it would in pi. Running pi sessions pick changes up on `/reload`. If the extension is missing or off, the tab installs or turns it on.

![The Claude plugins tab: two marketplaces with auto-update switches, and the installed plugins, one opened to show its commands and agents](assets/screenshots/plugins.png)

### Skills

The tab lists every skill pi loads for the workspace, grouped by source and ranked the way pi ranks them: packages and settings entries, the workspace's `.pi/skills` and `.agents/skills`, pi's `skills` folder, `~/.agents/skills`, and Claude plugins. It marks overridden skills, skills that only `/skill:name` runs, and name or description problems. When `deferred` is on, it shows each skill's deferred mode.

- A skill's switch writes a `+` or `-` entry to the `skills` list in settings.json, as `pi config` does: global for global skills, the workspace's for workspace skills.
- Tap a skill to read or edit its `SKILL.md`, or to delete it. Skills from Claude plugins and packages are read-only here; their plugin or package owns them.
- **New skill** writes `<name>/SKILL.md` in pi's folder, `~/.agents/skills` (which other coding agents read too), or the workspace's `.pi/skills` or `.agents/skills`.

**Prompt templates** works the same way for `/name` templates in pi's `prompts` folder, the workspace's `.pi/prompts`, and Claude plugins, with the `prompts` settings list.

![The Skills tab: a workspace skill, pi's skills with one turned off and one that only /skill:name runs, ~/.agents skills, and a skill from a Claude plugin, each with its deferred mode](assets/screenshots/skills.png)

### Context

- **System prompt.** `SYSTEM.md` replaces pi's built-in prompt, and `APPEND_SYSTEM.md` adds to it. Create, edit, or delete the global and workspace files. The tab shows which ones pi uses here.
- **Context files.** The `AGENTS.md` or `CLAUDE.md` files pi adds to every session in the workspace, in pi's order: the agent directory's, then one per directory from `/` down to the workspace. Each lists its `@path` lines and whether those files exist. Create the global or workspace file if it is missing.
- **Includes.** The config of the `context-include` extension, which inlines `@path` lines.

![The Context tab: the system prompt files with the global APPEND_SYSTEM.md in use, and the context files with their includes](assets/screenshots/context.png)

### Workflows

Each workflow appears as a pipeline: its steps, their models, and markers for approvals, loops, and waits. The editor supports the full format: models (or **Ask at run**), thinking, tools, skills, MCP servers, subagent rules, environment, limits, and the task options for waits, repeats, goals, approvals, and skills. New workflows start with `anthropic/claude-opus-5-5` at medium thinking.

![The workflow editor with the pipeline rail on the left and the docs-check step's tasks and agent settings on the right](assets/screenshots/editor.png)

In a worktree, the tab also lists workflows saved in the main checkout and runs them in the worktree. It notes that `.pi` files go away with the worktree unless you commit them. It also shows when pi does not trust a directory and ignores its `.pi` folder.

### Runs

**Run** asks for `{{inputs}}`, any models marked **Ask at run**, and where to run: this workspace, another workspace, or a new worktree that Paseo creates. Runs that wait for you come first in the Runs tab. A run's view follows the working step, streams the agent's output, and lets you message the agent.

![The run dialog with New worktree selected: the project, an optional branch and base, and the workspace title](assets/screenshots/run-dialog.png)

![Runs grouped into Needs you, Active, and Finished, each with its workspace, progress, and cost](assets/screenshots/runs.png)

### Status in the chat

Each pi agent's composer has a **Pi Rust** pill next to Tasks and Subagents; other agents get it while a run is active in their workspace. The label sums up the agent's work, such as `Approve · 1 bg · 2 runs`. The popover shows approvals, workflow runs, the workspace's goal, timers, and background tasks with output from the agent's pi session. It refreshes every second or two.

![The composer of a pi agent with the Pi Rust pill open: an approval, a running E2E suite with its output, a failed lint, a finished type check, runs, a goal, and a timer](assets/screenshots/composer.png)

### Composer and agents

- `/workflow run <name> key=value` starts a run and adds a live card to the agent's timeline; `--worktree[=branch]` runs it in a new worktree. `/workflow approve`, `stop`, `resume`, and `skip` control runs.
- `/pi-ext install|remove|enable|disable|update <source> [-l]` manages extensions.
- Paseo agents get the `pi_workflows` and `pi_extensions` tools; `pi_extensions` can also run an extension's command, such as `deferred status`. An agent that starts a run gets the step reports as a message when the run ends. The tools cannot approve tasks.

## Settings

**Settings → Plugins → Pi Rust**:

| Setting | Default | What it does |
| --- | --- | --- |
| pi binary | `$PI_BIN`, then `PATH` | The pi executable. |
| Agent directory | `$PI_CODING_AGENT_DIR`, then `~/.pi/agent` | pi's settings, extensions, and workflow files. |
| Workflow runner | The installed `workflows` extension | The `pi-rust-ext` binary that runs workflows. |
| Run in the background by default | On | Background runs keep going when the plugin stops. Foreground runs stop as interrupted and can resume. |
| Report run ends to the agent | On | Sends the step reports to the agent that started a run. |
| Agents with the tools | Every agent | Every agent, every agent except pi agents (they have the `workflow` tool), or none. |

## Data and permissions

The plugin runs `pi` and `git` on the daemon machine. It also:

- Reads and writes pi's settings, workflow definitions, run directories, and session files.
- Reads and writes the system prompt, context, skill, and prompt files you edit.
- Reads state from the `background-tasks`, `goal`, and `timers` extensions.
- Starts the workflows runner as a detached process.
- Signals a background task's process group when you stop it.
- Creates Paseo worktrees only when you ask for one.

Updates and installs download from the Pi Rust releases, the extension marketplace, npm, or Git, as `pi` does. The `claude-marketplace` extension clones Claude plugin marketplaces and plugins from Git. The plugin sends nothing anywhere else.

Project workflows and settings follow pi's project trust: the plugin does not save project workflows where pi does not trust the directory.

## How it works

Runs start the same way they do in pi. The plugin writes `run.json` in `<agentDir>/ext/workflows/runs/<id>/` and starts `pi-rust-ext workflows --runner <dir>` detached, so runs outlive the plugin. Commands to a runner (`stop`, `skip`, `approve`, `mode`, `interrupt`) are JSON files in the run's `commands/` folder, and messages to the working agent are JSON strings in `inbox/`. The plugin keeps `sessions/<pid>` fresh, so a foreground run stops when the plugin stops, as it does when pi quits.

The skill catalog comes from `pi --mode rpc` with `PI_WORKFLOW_RUN` set, so pi does not watch or report runs. A Paseo pi agent's persistence session id is its pi session id; the status pill uses it to find the agent's background tasks and timers.

| Path | Contents |
| --- | --- |
| `shared/` | The workflow format and its validation (matching `extensions/workflows/src/model.rs`), run and status types, and RPC contracts |
| `server/` | pi commands, workflow files, the runner protocol, status readers, skills, prompts, context, Claude plugins, agent tools |
| `client/` | The Pi Rust screen, the Workflows panel, the run card, the status pill, and settings |
| `test/` | Node tests with a fake `pi`, a fake runner, and temporary agent directories |
| `scripts/` | Releases and screenshots |

## Development

```sh
npm ci
npm run check            # type check and tests
paseo plugin add "$PWD"  # then: paseo plugin reload pi-rust
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow, commit messages, and releases.

## Releases

Versions follow [Semantic Versioning](https://semver.org). Commit messages follow [Conventional Commits](https://www.conventionalcommits.org): `fix:` makes a patch release, `feat:` a minor release, and `!` or `BREAKING CHANGE:` a major release. Each push to `main` releases the changes since the last tag: it updates `package.json` and [CHANGELOG.md](CHANGELOG.md), tags `vX.Y.Z`, and publishes a GitHub release.

## Credits

[Ryan Yannelli](https://ryanyannelli.com) · [GitHub](https://github.com/yannelli)

## License

[MIT](LICENSE)
