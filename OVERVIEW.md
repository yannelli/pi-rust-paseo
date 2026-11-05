Manage [Pi Rust](https://github.com/yannelli/pi-rust) from Paseo: pi itself, its extensions, Claude Code plugins, skills, prompts, and context, and the multi-agent workflows of its `workflows` extension. Everything runs on the daemon machine through the `pi` binary and the files pi uses, so a change made here and one made in pi's own TUI are the same change.

## What it does

- **Overview.** The pi version, extensions, workflows, and runs at a glance; updates for pi, extensions, and model catalogs; the default provider, model, and thinking level; health from `pi doctor`; subscription limits; usage; and an editor for the global or workspace `settings.json`.
- **Extensions.** Built-in and installed extensions with on/off switches, installed packages with update and remove, the marketplace with install and update, and installs from `npm:`, `git:`, or a path. Each works globally or for one workspace. An extension's page runs its slash commands (in a temporary pi session, without a model turn), edits its `ext/<name>.json` config files, and links its docs. **deferred** has a rule manager: every rule in the order it applies, one-tap modes, new global, workspace, or repo rules, a check of which rule decides a name, `auto` and `maxResults`, and `/deferred status`.
- **Claude plugins.** Claude Code plugin marketplaces (GitHub, git, or a folder) with auto-update, update, and remove, and their plugins with install (globally or for one workspace), on/off, update, reinstall, and uninstall, through the `claude-marketplace` extension. Each plugin lists the skills, commands, agents, hooks, and MCP servers it added.
- **Skills.** Every skill and prompt template pi loads for the workspace, from each folder, Claude plugin, and package, in the order pi ranks them, with overrides, problems, and deferred modes marked. Turn them on and off as `pi config` does, read and edit them, delete them, and create new ones.
- **Context.** The global and workspace `SYSTEM.md` and `APPEND_SYSTEM.md`, and which ones pi uses; the `AGENTS.md` and `CLAUDE.md` files pi loads for the workspace, in order, with their `@path` includes; and the `context-include` config.
- **Workflows.** Workflows shown as pipelines of steps with their models, approvals, loops, and waits. Create, edit, copy, and delete them in a form or as JSON, with the same validation as pi. A model can draft one from a description. New workflows start with `anthropic/claude-opus-5-5` at medium thinking.
- **Runs.** A live view of every run: a step timeline, the agent's output as it writes, step reports, shared memory, and the runner log. Approve or skip a task that waits, end a wait, message the working agent, stop, resume, switch between background and foreground, and delete runs. Runs waiting for you come first.
- **Sessions.** pi's saved sessions grouped by workspace, with delete and prune.

## Workspaces and worktrees

The screen works in a Paseo workspace you pick from a list grouped by project and branch, and remembers it. Runs and sessions show the workspace they belong to, with a link to open it. A run can start in the current workspace, in another one, or in a new worktree of the project that Paseo creates for it. In a worktree, the Workflows tab also lists the workflows saved in the main checkout and can run them there. The plugin says when a directory is a worktree, whose `.pi` files go away with it unless committed, and when pi does not trust a directory and so ignores its `.pi` folder.

## Status in the chat

Each pi agent's composer gets a **Pi Rust** pill beside Tasks and Subagents, and so does any other agent while a workflow runs in its workspace. Its label sums up what is going on, such as `Approve · 2 bg · 1 run` or `goal 3/7 · 1 timer`, and its icon shows a hand when a run waits for your approval, an alert when a background task failed in the last 30 minutes, and a pulsing dot while something runs. Tapping it opens the full status, refreshed every second or two:

- **Background tasks** of the agent's pi session (from the `background-tasks` extension): running, completed, failed with the exit code, timed out, stopped, or lost when the process is gone. Each shows its command and the end of its output, and a running task can be stopped.
- **Workflow runs** in the workspace or started by the agent, with Approve, Skip task, and Stop run for a task that waits.
- **Goals** of the workspace (from the `goal` extension) with task progress, the current task, and waits.
- **Timers** of the session (from the `timers` extension): heartbeats and schedules with when they fire next.

A **Workflows** panel in each workspace shows that workspace's workflows and runs. The sidebar row counts active runs and runs waiting for approval. In an agent's composer, `/workflow run <name> key=value` starts a run and adds a live run card to that agent's timeline, and `--worktree` runs it in a new worktree. `/workflow approve`, `stop`, `resume`, and `skip` control runs, and `/pi-ext install <source>` manages extensions.

Paseo agents get two tools, `pi_workflows` and `pi_extensions`, so an agent can create, run (also in a new worktree), and watch workflows, or manage extensions. An agent that starts a run gets the step reports as a message when the run ends. The tools cannot approve tasks; you approve them in Paseo or pi.

## Setup

Install Pi Rust on the daemon machine, and install the `workflows` extension (`marketplace:workflows`) for workflows; the Extensions tab can install it. The plugin finds pi through its settings, `$PI_BIN`, or `PATH`, and reads `~/.pi/agent` unless `PI_CODING_AGENT_DIR` or the plugin settings name another directory. It needs Paseo 0.15.0 or later. It has been tested on Linux.

## Settings

- **pi binary, agent directory, workflow runner.** Paths, when the defaults do not find them.
- **Run in the background by default.** Background runs keep going when the plugin stops. Foreground runs belong to the plugin and stop as interrupted when it stops or reloads; they can resume.
- **Report run ends to the agent that started the run.** Sends the step reports to that agent as a message.
- **Agents with the tools.** Every agent, every agent except pi agents (which have their own `workflow` tool), or none.

## What it reads and changes

It runs `pi` and `git` commands, reads and writes pi's settings, workflow definitions, run directories, and session files, starts the workflows runner as a detached process, and creates Paseo worktrees when you ask for one. Project workflows and settings follow pi's project trust: the plugin does not save project workflows where pi does not trust the directory. Updates and installs download from the Pi Rust releases, the extension marketplace, npm, or Git, as `pi` does. The plugin sends nothing anywhere else.
