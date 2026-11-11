# How herdr restores AI coding sessions, and how sshtab does it

A study for [#10](https://github.com/luongnv89/rex-extensions/issues/10): after Rex restarts, the Claude Code and other agent sessions that were running should come back in their panes. [herdr](https://github.com/herdrdev/herdr), another terminal multiplexer for agents, already does this. This page explains how herdr does it, then how sshtab's restore works in Rex and why it differs.

Sources are herdr's repository at commit [`ee5bfb5`](https://github.com/herdrdev/herdr/tree/ee5bfb5041bb3e4a49d591c72308aae3c81ecdde) (November 2026). Every path below links to that commit.

## herdr

### What survives a restart

herdr's [session state page](https://github.com/herdrdev/herdr/blob/ee5bfb5041bb3e4a49d591c72308aae3c81ecdde/docs/next/website/src/content/docs/session-state.mdx) separates four cases. Detaching keeps the server and every process running. A **server restart** keeps none of the processes: herdr saves the layout (workspaces, tabs, panes, each pane's folder and the focus) in `session.json`, and keeps up to 48 older layouts in `session-snapshots/`. On start it rebuilds that layout, and each pane comes back as a new shell in its saved folder. The [persistence page](https://github.com/herdrdev/herdr/blob/ee5bfb5041bb3e4a49d591c72308aae3c81ecdde/docs/next/website/src/content/docs/persistence-remote.mdx) says the same for remote sessions.

On top of that, **native agent session restore** starts the agent again in a pane that had one, on the same conversation. It is on by default and turned off with `[session] resume_agents_on_restore = false`.

### Where the session id comes from

herdr doesn't read an agent's id from the process. The agent reports it.

- **herdr's own integrations.** `herdr integration install claude` writes a hook script into the agent's config folder and registers it in the agent's settings: for Claude Code, `hooks/herdr-agent-state.sh` and a `SessionStart` entry in `settings.json`, under `~/.claude` or `CLAUDE_CONFIG_DIR` ([integrations page](https://github.com/herdrdev/herdr/blob/ee5bfb5041bb3e4a49d591c72308aae3c81ecdde/docs/next/website/src/content/docs/integrations.mdx)). Codex gets a `hooks.json` entry and `[features] hooks = true` in `config.toml`.
- **The hook.** On `SessionStart`, [`herdr-agent-state.sh`](https://github.com/herdrdev/herdr/blob/ee5bfb5041bb3e4a49d591c72308aae3c81ecdde/src/integration/assets/claude/herdr-agent-state.sh) reads the hook input, skips subagents, and sends `pane.report_agent_session` with the `session_id` and transcript path to `$HERDR_SOCKET_PATH`, for the pane in `$HERDR_PANE_ID`. Every pane inherits those variables.
- **Agents that report themselves.** An agent can also send its own resume command with `herdr pane report-agent ... -- my-agent --resume ID` ([add herdr support](https://github.com/herdrdev/herdr/blob/ee5bfb5041bb3e4a49d591c72308aae3c81ecdde/docs/next/website/src/content/docs/add-herdr-support.mdx)). herdr checks it: the first word must be a bare command name on `PATH`, no argument may hold an apostrophe or a control character, and the whole command is at most 64 arguments and 8 KiB (`validate_resume_argv` in [`src/agent_resume.rs`](https://github.com/herdrdev/herdr/blob/ee5bfb5041bb3e4a49d591c72308aae3c81ecdde/src/agent_resume.rs)).
- **Codex started with an id.** `persisted_session_from_launch_args` in the same file records a Codex pane started exactly as `codex resume ID`.
- **Which agent runs.** [`src/detect/mod.rs`](https://github.com/herdrdev/herdr/blob/ee5bfb5041bb3e4a49d591c72308aae3c81ecdde/src/detect/mod.rs) (`identify_agent`) names the agent from the foreground process: its name or `argv0`, and the script a runtime such as node runs.

The reference is saved with the pane in `session.json`.

### The command it runs

`plan()` in [`src/agent_resume.rs`](https://github.com/herdrdev/herdr/blob/ee5bfb5041bb3e4a49d591c72308aae3c81ecdde/src/agent_resume.rs) turns a saved reference into a command from a fixed table, one form per agent: `claude --resume ID`, `codex resume ID`, `opencode --session ID`, `cursor-agent --resume ID`, `copilot --resume=ID`, `qwen --resume ID`, `kimi --session ID`, `pi --session ID`, and others. The session-state page lists 18 agents. Gemini and Amp aren't among them. An unsupported, missing, invalid, duplicated or stale reference gives a plain shell.

`start_pending_agent_resume` in [`src/app/agent_resume.rs`](https://github.com/herdrdev/herdr/blob/ee5bfb5041bb3e4a49d591c72308aae3c81ecdde/src/app/agent_resume.rs) then:

1. waits until a client is attached and the pane's size and theme are known;
2. checks that the saved folder exists, and otherwise leaves the pane with an error;
3. starts the pane's shell itself, in that folder;
4. quotes the command (`shell_command_from_argv`) and writes it, with a carriage return, into the new shell's input at once.

Because herdr owns the pane and starts its shell, nothing else can have typed into it, so it doesn't wait for a prompt. It starts the resumes one by one, with a short delay between agents.

## sshtab in Rex

### What Rex gives

- When the Rex server restarts, every session, window and block comes back with the **same block id** and folder. The command a block ran is dropped, so each pane is a plain login shell again: after `rex server stop` and a new `rex server run`, a pane that ran an agent is `-zsh` in the same folder, under the same block id.
- `server.status` gives the server's `instance_id` and `started_at`, so a restart can be told from a watcher that merely restarted.
- A terminal block's `process` method names the foreground process (`name`, `path`, `invoked_path`, `argv0`, `script`, `cwd`, `pid`). It never returns the other arguments.
- `input_mode` tells whether a shell's line editor is reading, `format` returns the screen as text, and `write` types into the terminal.

Rex has no hook for "a pane is being restored", and no API for an agent to report its session. An extension can't start a pane's shell itself: Rex starts it, and the extension can only type into it afterwards.

### How it works

The sshtab watcher (`watcher.lua`) already runs in the background for every session. It now also:

1. **Records** which agent each pane runs, every 15 seconds and whenever a pane's program changes. It identifies the agent from the process name, as herdr does. It takes the session id from places the agent itself writes:
   - **Claude Code:** `$CLAUDE_CONFIG_DIR/sessions/<pid>.json` (default `~/.claude`), which Claude writes for every running process. It must name that very pid and say `"kind": "interactive"`. A `CLAUDE_CONFIG_DIR` read from the process's environment counts only if that file is in it.
   - **Codex, OpenCode, Cursor Agent, pi:** the id on the command line, but only in an exact allowed form, such as `codex [options] resume UUID` or `opencode -s ID`.
   - It writes `agents.json`: agent, session id, folder, at most one verified config folder, the server instance, and when it was last seen.
2. **Restores** at watcher start, which `init.lua` triggers when the server starts. It reads `agents.json` as the old server left it and, for each pane the server that just ended had an agent in, types one line:
   `cd FOLDER && [env CLAUDE_CONFIG_DIR=DIR] claude --resume ID`.

### Why it differs from herdr

| | herdr | sshtab |
| --- | --- | --- |
| Session id from | A hook installed in each agent's config, or the agent's own report | Claude's own `sessions/<pid>.json`; an id on the command line for the others |
| Agent config touched | Yes: hook scripts, `settings.json`, `hooks.json`, `config.toml` | No |
| Command typed | Rebuilt from a fixed table, or the agent's reported argv (checked) | Rebuilt from a fixed table only: nothing on disk names the program |
| Starts the shell | Yes, then writes the command at once | No: Rex does; it waits for the prompt |
| When | Whenever the client attaches | Only within 120 seconds of the server starting |
| Agents | 18, through integrations | Claude Code and Codex (`codex resume UUID`), OpenCode, Cursor Agent and pi when started with an id |

- **No agent config edits.** The repo's rule is to leave other tools alone. Editing Claude's `settings.json` or Codex's `config.toml` from a terminal extension would be a hidden, lasting change to another tool, and would have to be undone on removal. Claude already writes the pid-to-session file the watcher needs, so no hook is required for it.
- **Exact ids only.** Without a hook, Codex, OpenCode, Cursor Agent and pi don't tell anyone which session a running process has, except on their command line. "Continue the latest session" (`codex resume --last`, `opencode -c`) could pick another pane's session, so it is never used. A Codex started as plain `codex` isn't restored; reading the rollout file a process holds open was considered and dropped, because one process may hold several.
- **Rex starts the shell, so it waits for the prompt.** herdr can write the command before the shell starts because nobody else can type in between. In Rex the pane is already live when the watcher sees it, so it types only into a plain shell (zsh, bash, sh, dash, ksh, mksh or fish) started by this server, with its line editor reading, and the same cursor line on two looks a second apart. In zsh, bash and fish, which use emacs keys by default, it sends Ctrl-E Ctrl-U first, so leftover input is cleared rather than run.
- **A restore window.** Typing into a shell is only safe right after the server starts, when the pane is known to be the restored one. A watcher that starts later, such as one turned off and on, types nothing and forgets the old entries. herdr has no window because it restores panes it hasn't started yet.
- **At most once.** Each entry is marked as restored in the new server only after its line was written. A second watcher in the same server, or a second pane with the same session id, types nothing. A heartbeat from every sweep makes sure only sessions of the server that just ended, and seen in its last sweeps, are resumed.

### What it can't do

- It resumes after a Rex **server** restart only: closing the app, a reboot, an update, `rex server stop`. Quitting the agent yourself forgets it.
- Options the agent was started with (model, permission mode) and the prompt aren't carried over. herdr's agent-reported commands can carry them.
- A session switched inside the agent (Claude's `/clear` or `/resume`, Codex's picker) is followed only as far as the agent updates what the watcher reads: Claude's pid file, or nothing for the command-line agents.
- Gemini, Amp, Qwen, Copilot and Kimi are detected but not restored: their session id isn't visible from outside the process without a hook.
