-- Tests for lib.lua, run by lib.test.js with a plain Lua 5.1: lua lib_spec.lua LIB
local lib = dofile(arg[1])
local failures, count = 0, 0

local function show(v) return type(v) == "string" and string.format("%q", v) or tostring(v) end
local function eq(got, want, what)
  count = count + 1
  if got ~= want then
    failures = failures + 1
    io.stderr:write(string.format("FAIL %s: got %s, want %s\n", what, show(got), show(want)))
  end
end
local function join(t) return t and table.concat(t, " ") or nil end
local function words(s) return lib.split_words(s) end
local function cmd(s) return join((lib.ssh_command(words(s)))) end

-- split_nul / split_words
eq(join(lib.split_nul("ssh\0-o\0ProxyCommand nc %h 22\0box\0")), "ssh -o ProxyCommand nc %h 22 box", "split_nul keeps spaces")
eq(#lib.split_nul("ssh\0-o\0ProxyCommand nc %h 22\0box\0"), 4, "split_nul word count")
eq(#lib.split_nul("ssh\0\0box\0"), 3, "split_nul keeps an empty argument")
eq(lib.split_nul(""), nil, "split_nul of nothing")
eq(join(lib.split_words("  ssh  -p 2222 box\n")), "ssh -p 2222 box", "split_words")
eq(lib.split_words("   "), nil, "split_words of blanks")

-- program
eq(lib.program("/usr/bin/ssh"), "ssh", "program of a path")
eq(lib.program("ssh"), "ssh", "program of a name")

-- ssh_command
eq(cmd("ssh box"), "ssh box", "plain")
eq(cmd("ssh user@box.example.com"), "ssh user@box.example.com", "user@host")
eq(cmd("ssh -p 2222 -i ~/.ssh/id box"), "ssh -p 2222 -i ~/.ssh/id box", "options with arguments")
eq(cmd("ssh -p2222 box"), "ssh -p 2222 box", "attached argument")
eq(cmd("ssh -At box"), "ssh -A -t box", "combined flags")
eq(cmd("ssh -Ap2222 box"), "ssh -A -p 2222 box", "flags then an attached argument")
eq(cmd("ssh box htop"), "ssh box", "drops the remote command")
eq(cmd("ssh -t box tmux attach -d"), "ssh -t box", "drops a command with options")
eq(cmd("ssh box -p 2222 ls -la"), "ssh -p 2222 box", "options after the destination, then a command")
eq(cmd("ssh -L 8080:localhost:80 -R9000:localhost:9000 -D 1080 box"), "ssh box", "drops forwards")
eq(cmd("ssh -fN -L 8080:x:80 box"), "ssh box", "drops -f and -N")
eq(cmd("ssh -tNv box"), "ssh -t -v box", "drops -N from a group")
eq(cmd("ssh -T box"), "ssh box", "drops -T")
eq(cmd("ssh -n box ls"), "ssh box", "drops -n")
eq(cmd("ssh -o StrictHostKeyChecking=no -J jump box"), "ssh -o StrictHostKeyChecking=no -J jump box", "keeps -o and -J")
eq(cmd("ssh -l admin box"), "ssh -l admin box", "keeps -l")
eq(cmd("ssh -- box uptime"), "ssh box", "destination after --")
eq(cmd("ssh ssh://admin@box:2222"), "ssh ssh://admin@box:2222", "ssh:// destination")
eq(cmd("/usr/bin/ssh box"), "/usr/bin/ssh box", "keeps the program path")
eq(cmd("ssh -v"), nil, "no destination")
eq(cmd("ssh -p"), nil, "missing argument")
eq(lib.ssh_command(nil), nil, "nil argv")
local _, dest = lib.ssh_command(words("ssh -p 2222 admin@box uptime"))
eq(dest, "admin@box", "returns the destination")

-- is_shell
eq(lib.is_shell("zsh"), true, "is_shell zsh")
eq(lib.is_shell("-zsh"), true, "is_shell a login zsh")
eq(lib.is_shell("/opt/homebrew/bin/fish"), true, "is_shell a path")
eq(lib.is_shell("ssh"), false, "is_shell ssh")
eq(lib.is_shell("login"), false, "is_shell login")
eq(lib.is_shell(nil), false, "is_shell nil")

-- quote / command_line
eq(lib.quote("box"), "box", "quote a plain word")
eq(lib.quote("admin@box.example.com:2222"), "admin@box.example.com:2222", "quote keeps @ . : as they are")
eq(lib.quote("ProxyCommand nc %h %p"), "'ProxyCommand nc %h %p'", "quote a word with spaces")
eq(lib.quote("it's"), [['it'\''s']], "quote a single quote")
eq(lib.quote("~/.ssh/id"), "'~/.ssh/id'", "quote a leading ~ so the remote path isn't expanded twice")
eq(lib.quote(""), "''", "quote nothing")
eq(lib.quote("$HOME;rm"), "'$HOME;rm'", "quote shell syntax")
eq(lib.command_line({ "ssh", "-p", "2222", "-o", "ProxyCommand nc %h %p", "box" }), "ssh -p 2222 -o 'ProxyCommand nc %h %p' box", "command_line")

-- split_source
local function leaf(id) return { block_id = id } end
local function split(a, b) return { split = { direction = "horizontal", before = a, after = b } } end
local win = { layers = { { kind = "tiled", layout = split(split(leaf("b0"), leaf("b2")), leaf("b1")) } } }
eq(lib.split_source(win, "b2"), "b0", "split_source: new pane after its source")
eq(lib.split_source(win, "b0"), "b2", "split_source: new pane before its source")
eq(lib.split_source(win, "b1"), nil, "split_source: sibling is more than one pane")
eq(lib.split_source(win, "bx"), nil, "split_source: pane not in the window")
eq(lib.split_source({ layers = { { kind = "tiled", layout = leaf("b0") } } }, "b0"), nil, "split_source: the only pane")
eq(lib.split_source({ layers = { { kind = "floating", layout = split(leaf("f0"), leaf("f1")) } } }, "f1"), nil, "split_source: floating layers don't count")
eq(lib.split_source(nil, "b0"), nil, "split_source: no window")

-- plain_shell
eq(lib.plain_shell({ child = { name = "login" }, foreground = { name = "zsh" } }), true, "plain_shell: macOS login shell")
eq(lib.plain_shell({ child = { name = "bash" }, foreground = { name = "bash" } }), true, "plain_shell: a shell")
eq(lib.plain_shell({ child = { name = "login" }, foreground = { name = "ssh" } }), false, "plain_shell: running ssh")
eq(lib.plain_shell({ child = { name = "node" }, foreground = { name = "node" } }), false, "plain_shell: a command")
eq(lib.plain_shell({ child = { name = "ssh" }, foreground = { name = "ssh" } }), false, "plain_shell: a command tab")
eq(lib.plain_shell({ foreground = { name = "zsh" } }), false, "plain_shell: no child")
eq(lib.plain_shell(nil), false, "plain_shell: nil")

-- from_process
local argvs = { [42] = words("ssh -t admin@box htop") }
local function argv_of(pid) return argvs[pid] end
local c, d, cwd = lib.from_process({ foreground = { pid = 42, name = "ssh", cwd = "/Users/me" } }, argv_of)
eq(join(c), "ssh -t admin@box", "from_process command")
eq(d, "admin@box", "from_process destination")
eq(cwd, "/Users/me", "from_process cwd")
eq(join((lib.from_process({ foreground = { pid = 42, name = "x", path = "/usr/bin/ssh" } }, argv_of))), "ssh -t admin@box", "from_process by path")
eq(lib.from_process({ foreground = { pid = 42, name = "zsh" } }, argv_of), nil, "from_process ignores other programs")
eq(lib.from_process({ foreground = { pid = 7, name = "ssh" } }, argv_of), nil, "from_process without argv")
eq(lib.from_process({}, argv_of), nil, "from_process without a foreground")
eq(lib.from_process(nil, argv_of), nil, "from_process of nil")

-- Agent sessions after a restart -------------------------------------------

local A, B = "aaaaaaaa-0000-4000-8000-000000000001", "bbbbbbbb-0000-4000-8000-000000000002"
local function args(s) return lib.split_words(s) or {} end

-- identify_agent
eq(lib.identify_agent({ name = "2.1.322", path = "/u/.local/share/claude/versions/2.1.322", invoked_path = "/u/.local/bin/claude", argv0 = "claude" }), "claude", "identify_agent: Claude by the path it was invoked through")
eq(lib.identify_agent({ name = "node", script = "/x/bin/codex.js" }), "codex", "identify_agent: a node script")
eq(lib.identify_agent({ name = "node", argv0 = "/u/.local/bin/cursor-agent", script = "/u/cursor-agent/index.js" }), "cursor-agent", "identify_agent: Cursor Agent by argv0")
eq(lib.identify_agent({ name = "node", script = "/x/github/panel.js" }), nil, "identify_agent: a panel isn't an agent")
eq(lib.identify_agent({ name = "zsh", argv0 = "-zsh" }), nil, "identify_agent: a shell")
eq(lib.identify_agent({ name = "gemini" }), "gemini", "identify_agent: detected, not restored")
eq(lib.AGENTS.gemini, nil, "gemini isn't restored")

-- agent_args
eq(join(lib.agent_args(args("node /x/bin/codex.js resume " .. A), "codex")), "resume " .. A, "agent_args after a node script")
eq(join(lib.agent_args(args("/u/bin/cursor-agent --use-system-ca /u/v/index.js --resume abc"), "cursor-agent")), "--resume abc", "agent_args skips Cursor Agent's launcher")
eq(lib.agent_args(args("node other.js"), "codex"), nil, "agent_args: no program word")

-- T12: codex is recorded only as `codex [global options] resume UUID`
local function codex(s) return lib.argv_session("codex", lib.agent_args(args(s), "codex")) end
eq(codex("codex resume " .. A), A, "T12 codex resume UUID")
eq(codex("codex -m o3 --search -c model=x resume " .. A), A, "T12 codex global options then resume UUID")
eq(codex("codex --model=o3 resume " .. A), A, "T12 codex --opt=value then resume")
eq(codex("codex"), nil, "T12 plain codex")
eq(codex("codex fix the bug"), nil, "T12 codex with a prompt")
eq(codex("codex e fix " .. A), nil, "T8/T12 codex e")
eq(codex("codex exec " .. A), nil, "T8/T12 codex exec")
eq(codex("codex review"), nil, "T8/T12 codex review")
eq(codex("codex app-server"), nil, "T8/T12 codex app-server")
eq(codex("codex resume --last"), nil, "T12 codex resume --last")
eq(codex("codex resume"), nil, "T12 codex resume without an id")
eq(codex("codex resume my-session-name"), nil, "T12 codex resume by name, not UUID")
eq(codex("codex resume " .. A .. " continue please"), nil, "T12 codex resume with a prompt after the id")
eq(codex("codex --unknown resume " .. A), nil, "T12 codex with an unknown option")
eq(codex("codex fork " .. A), nil, "T12 codex fork")

-- T8: other non-interactive or id-less invocations aren't recorded
local function argv_id(agent, s) return lib.argv_session(agent, lib.agent_args(args(s), agent)) end
eq(argv_id("opencode", "opencode -s ses_abc123"), "ses_abc123", "opencode -s ID")
eq(argv_id("opencode", "opencode --session=ses_abc123 --auto"), "ses_abc123", "opencode --session=ID")
eq(argv_id("opencode", "opencode run -s ses_abc123 hi"), nil, "T8 opencode run")
eq(argv_id("opencode", "opencode -c"), nil, "T8 opencode --continue isn't an exact id")
eq(argv_id("opencode", "opencode"), nil, "opencode without an id")
eq(argv_id("opencode", "opencode -s"), nil, "opencode -s without a value")
eq(argv_id("cursor-agent", "cursor-agent --resume chat-1"), "chat-1", "cursor-agent --resume ID")
eq(argv_id("cursor-agent", "cursor-agent -p --resume chat-1"), nil, "T8 cursor-agent -p")
eq(argv_id("cursor-agent", "cursor-agent --print --resume chat-1"), nil, "T8 cursor-agent --print")
eq(argv_id("cursor-agent", "cursor-agent --resume"), nil, "cursor-agent --resume without an id opens a picker")
eq(argv_id("cursor-agent", "cursor-agent --resume --force"), nil, "cursor-agent --resume followed by an option")
eq(argv_id("pi", "pi --session 019a-x"), "019a-x", "pi --session ID")
eq(argv_id("pi", "pi -p --session 019a-x"), nil, "T8 pi -p")
eq(argv_id("pi", "pi --session /tmp/s.jsonl"), nil, "pi --session with a path")
eq(lib.argv_session("claude", args("--resume x")), nil, "claude isn't read from argv")

-- T8: Claude counts only an interactive record of the same pid
eq(lib.claude_session({ pid = 42, sessionId = A, cwd = "/w", kind = "interactive" }, 42), A, "claude_session")
eq(select(2, lib.claude_session({ pid = 42, sessionId = A, cwd = "/w", kind = "interactive" }, 42)), "/w", "claude_session folder")
eq(lib.claude_session({ pid = 42, sessionId = A, kind = "print" }, 42), nil, "T8 claude not interactive")
eq(lib.claude_session({ pid = 42, sessionId = A }, 42), nil, "T8 claude without a kind")
eq(lib.claude_session({ pid = 41, sessionId = A, kind = "interactive" }, 42), nil, "claude record of another pid")
eq(lib.claude_session({ pid = 42, sessionId = "x; rm -rf ~", kind = "interactive" }, 42), nil, "T3 claude id with metacharacters")
eq(lib.claude_session(nil, 42), nil, "no claude record")

-- T3: ids with metacharacters are rejected
eq(lib.valid_session_id(A), true, "valid id: uuid")
eq(lib.valid_session_id("ses_01J:a.b-c"), true, "valid id: . _ : -")
for _, bad in ipairs({ "", "-rf", "a b", "a;b", "a$(b)", "a`b`", "a'b", "a\nb", "a|b", "a&b", "a/b", "../x", string.rep("a", 129) }) do
  eq(lib.valid_session_id(bad), false, "T3 invalid id " .. show(bad))
end
eq(lib.valid_uuid(A), true, "valid uuid")
eq(lib.valid_uuid("aaaaaaaa-0000-4000-8000-00000000000"), false, "short uuid")

-- T4: only CLAUDE_CONFIG_DIR / CODEX_HOME are read from the environment
local allow = { CLAUDE_CONFIG_DIR = true, CODEX_HOME = true }
local env = lib.env_from_ps("claude --resume x\n", "claude --resume x CLAUDE_CONFIG_DIR=/u/.claude-work HOME=/u SECRET=1\n", allow)
eq(env.CLAUDE_CONFIG_DIR, "/u/.claude-work", "T4 env_from_ps reads an allowed variable")
eq(env.SECRET, nil, "T4 env_from_ps leaves the rest")
eq(env.HOME, nil, "T4 env_from_ps leaves HOME")
local forged = lib.env_from_ps("claude CLAUDE_CONFIG_DIR=/evil", "claude CLAUDE_CONFIG_DIR=/evil PATH=/bin", allow)
eq(forged.CLAUDE_CONFIG_DIR, nil, "T4 a CLAUDE_CONFIG_DIR= inside an argument isn't the environment")
eq(next(lib.env_from_ps("claude a", "other b CLAUDE_CONFIG_DIR=/x", allow)), nil, "T4 env_from_ps: arguments don't match")
eq(lib.env_from_environ("A=1\0CODEX_HOME=/c\0CLAUDE_CONFIG_DIR=/d\0", allow).CODEX_HOME, "/c", "T4 env_from_environ")
eq(lib.env_from_environ("A=1\0", allow).A, nil, "T4 env_from_environ leaves the rest")

-- T5: restore shells
for _, sh in ipairs({ "zsh", "-zsh", "bash", "sh", "dash", "ksh", "mksh", "fish", "/bin/zsh" }) do eq(lib.restore_shell(sh), true, "T5 restore shell " .. sh) end
for _, sh in ipairs({ "csh", "tcsh", "nu", "xonsh", "elvish", "node", "" }) do eq(lib.restore_shell(sh), false, "T5 not a restore shell " .. sh) end
eq(lib.restore_shell(nil), false, "T5 restore_shell nil")

-- keymap
eq(lib.keymap("zsh", {}), "emacs", "keymap zsh")
eq(lib.keymap("-zsh", { EDITOR = "nvim" }), "vi", "keymap zsh with EDITOR=nvim")
eq(lib.keymap("zsh", { VISUAL = "code -w" }), "emacs", "keymap zsh with another VISUAL")
eq(lib.keymap("bash", { EDITOR = "vim" }), "emacs", "keymap bash")
eq(lib.keymap("fish"), "emacs", "keymap fish")
eq(lib.keymap("ksh"), "unknown", "keymap ksh")

-- T3: resume_line quotes every value and takes the program from AGENTS
local function entry(t)
  local e = { agent = "claude", session_id = A, cwd = "/w/p", instance_id = "i-1", last_seen_at = 1000, missing_sweeps = 0 }
  for k, v in pairs(t or {}) do e[k] = v end
  return e
end
eq(lib.resume_line(entry()), "cd /w/p && claude --resume " .. A, "resume_line claude")
eq(lib.resume_line(entry({ cwd = "/w/my project's" })), [[cd '/w/my project'\''s' && claude --resume ]] .. A, "T3 resume_line quotes the folder")
eq(lib.resume_line(entry({ env = { CLAUDE_CONFIG_DIR = "/u/.claude work" } })), "cd /w/p && env CLAUDE_CONFIG_DIR='/u/.claude work' claude --resume " .. A, "T3 resume_line quotes the env value")
eq(lib.resume_line(entry({ agent = "codex", env = { CODEX_HOME = "/u/.codex2" } })), "cd /w/p && env CODEX_HOME=/u/.codex2 codex resume " .. A, "resume_line codex")
eq(lib.resume_line(entry({ agent = "opencode", session_id = "ses_1" })), "cd /w/p && opencode --session ses_1", "resume_line opencode")
eq(lib.resume_line(entry({ agent = "cursor-agent", session_id = "c1" })), "cd /w/p && cursor-agent --resume c1", "resume_line cursor-agent")
eq(lib.resume_line(entry({ agent = "codex", session_id = "not-a-uuid" })), nil, "T3 resume_line codex needs a uuid")
eq(lib.resume_line(entry({ session_id = "x;reboot" })), nil, "T3 resume_line rejects metacharacters")
eq(lib.resume_line(entry({ agent = "/bin/rm" })), nil, "T3 resume_line: the program comes from AGENTS only")
eq(lib.resume_line(entry({ agent = "gemini", session_id = "g1" })), nil, "resume_line: gemini isn't restored")
eq(lib.resume_line(entry({ program = "rm", argv = { "rm", "-rf" } })), "cd /w/p && claude --resume " .. A, "T3 resume_line ignores a stored program or argv")
eq(lib.resume_line(entry({ cwd = "relative" })), nil, "resume_line needs an absolute folder")
eq(lib.resume_line(entry({ cwd = "/w\n/p" })), nil, "resume_line: a folder with a newline")
eq(lib.resume_line(entry({ env = { PATH = "/evil" } })), nil, "T4 resume_line: another variable")
eq(lib.resume_line(entry({ env = { CLAUDE_CONFIG_DIR = "/c", LD_PRELOAD = "/x.so" } })), nil, "T4 resume_line: an extra variable")
eq(lib.resume_line(entry({ env = { CODEX_HOME = "/c" } })), nil, "T4 resume_line: codex's variable on claude")
eq(lib.resume_line(entry({ env = { CLAUDE_CONFIG_DIR = "rel" } })), nil, "T4 resume_line: a relative config dir")

-- times
eq(lib.iso_to_epoch("1970-01-01T00:00:00Z"), 0, "iso_to_epoch epoch")
eq(lib.iso_to_epoch("2026-11-11T22:13:40.260121Z"), 1794435220, "iso_to_epoch with fractions, in UTC")
eq(lib.iso_to_epoch("2024-02-29T12:00:00Z"), 1709208000, "iso_to_epoch leap day")
eq(lib.iso_to_epoch("2026-11-11T23:13:40+01:00"), 1794435220, "iso_to_epoch with an offset")
eq(lib.iso_to_epoch("yesterday"), nil, "iso_to_epoch of nonsense")
eq(lib.parse_etime("00:05"), 5, "parse_etime mm:ss")
eq(lib.parse_etime("  01:02:03\n"), 3723, "parse_etime hh:mm:ss")
eq(lib.parse_etime("2-01:02:03"), 176523, "parse_etime dd-hh:mm:ss")
eq(lib.parse_etime("2-02:03"), nil, "parse_etime days need hours")
eq(lib.parse_etime("x"), nil, "parse_etime of nonsense")
eq(lib.cursor_line("Last login\n\nM1 /p \n❯ "), "❯ ", "cursor_line")
eq(lib.cursor_line("a\nb\n\n"), "b", "cursor_line skips trailing newlines")

-- clean_state: what is read back from disk
local raw = {
  version = 1,
  heartbeat = { instance_id = "i-1", last_sweep_at = 1000 },
  blocks = {
    ["block:ok"] = entry(),
    ["block:bad-id"] = entry({ session_id = "$(reboot)" }),
    ["block:bad-agent"] = entry({ agent = "sh" }),
    ["block:bad-env"] = entry({ env = { CLAUDE_CONFIG_DIR = "/c", PATH = "/x" } }),
    ["not a block"] = entry(),
  },
}
local clean = lib.clean_state(raw)
local n = 0
for _ in pairs(clean.blocks) do n = n + 1 end
eq(n, 1, "clean_state keeps only valid entries")
eq(clean.blocks["block:ok"] ~= nil, true, "clean_state keeps a valid entry")
eq(clean.heartbeat.instance_id, "i-1", "clean_state keeps the heartbeat")
eq(next(lib.clean_state({ version = 2, blocks = raw.blocks }).blocks), nil, "clean_state: another version")
eq(next(lib.clean_state("junk").blocks), nil, "clean_state of junk")

-- observe: T4 only the allowlisted variable is kept
local st = lib.new_state()
eq(lib.observe(st, "block:1", { agent = "claude", session_id = A, cwd = "/w" }, "i-1", 100), true, "observe")
eq(st.blocks["block:1"].instance_id, "i-1", "observe sets the instance")
eq(lib.observe(st, "block:2", { agent = "claude", session_id = "a b", cwd = "/w" }, "i-1", 100), false, "T3 observe refuses a bad id")
eq(lib.observe(st, "block:3", { agent = "claude", session_id = A, cwd = "/w", env = { HOME = "/h" } }, "i-1", 100), false, "T4 observe refuses another variable")
eq(st.blocks["block:3"], nil, "T4 nothing kept for it")

-- T10: prune only after two timed sweeps, or when the block is gone
local e = entry({ instance_id = "i-1" })
eq(lib.prune_step(e, "absent", "i-1", false), e, "T10 an untimed sweep never prunes")
eq(e.missing_sweeps, 0, "T10 an untimed sweep doesn't count")
eq(lib.prune_step(e, "absent", "i-1", true), e, "T10 absent one timed sweep: kept")
eq(e.missing_sweeps, 1, "T10 counted once")
eq(lib.prune_step(e, "absent", "i-1", true), nil, "T10 absent two timed sweeps: pruned")
eq(lib.prune_step(entry({ instance_id = "i-1" }), "gone", "i-1", false) ~= nil, true, "T10 a closed block isn't pruned by an event")
eq(lib.prune_step(entry({ instance_id = "i-1" }), "gone", "i-1", true), nil, "T10 block gone on a timed sweep: pruned")
local older = entry({ instance_id = "i-0" })
eq(lib.prune_step(older, "gone", "i-1", true), older, "T10 another instance's entry isn't pruned by a sweep")
eq(lib.prune_step(older, "absent", "i-1", true), older, "T10 another instance's entry isn't counted")
eq(older.missing_sweeps, 0, "T10 another instance's entry: count unchanged")
local seen_again = entry({ instance_id = "i-1", missing_sweeps = 1 })
local st2 = lib.new_state()
st2.blocks["block:1"] = seen_again
lib.observe(st2, "block:1", { agent = "claude", session_id = A, cwd = "/w" }, "i-1", 200)
eq(st2.blocks["block:1"].missing_sweeps, 0, "T10 seen again: the count starts over")

-- plan_restore
local OLD, CUR, START = "i-old", "i-new", 10000
local function state_of(blocks, hb)
  return { version = 1, heartbeat = hb or { instance_id = OLD, last_sweep_at = START - 30 }, blocks = blocks }
end
local function restored(plan)
  local ids = {}
  for _, r in ipairs(plan.restore) do ids[#ids + 1] = r.block_id end
  return table.concat(ids, ",")
end
local function dropped(plan)
  local ids = {}
  for _, d in ipairs(plan.drop) do ids[#ids + 1] = d.block_id end
  return table.concat(ids, ",")
end
local on_time = { instance_id = CUR, started_at = START, now = START + 5 }
local recent = START - 30

eq(restored(lib.plan_restore(state_of({ ["block:1"] = entry({ instance_id = OLD, last_seen_at = recent }) }), on_time)), "block:1", "plan_restore: the session of the server that just ended")

-- T1: same instance -> nothing typed
local same = lib.plan_restore(state_of({ ["block:1"] = entry({ instance_id = CUR, last_seen_at = recent }) }, { instance_id = CUR, last_sweep_at = recent }), on_time)
eq(restored(same), "", "T1 same instance: nothing typed")
eq(dropped(same), "", "T1 same instance: this instance's entries are kept")
eq(restored(lib.plan_restore(state_of({ ["block:1"] = entry({ instance_id = OLD, last_seen_at = recent }) }, { instance_id = CUR, last_sweep_at = recent }), on_time)), "", "T1 a watcher restarted in the same server types nothing")

-- T2: at most once per instance; mark only after the write
local st3 = state_of({ ["block:1"] = entry({ instance_id = OLD, last_seen_at = recent }) })
eq(lib.mark_restored(st3, "block:1", CUR, false), false, "T2 a failed write doesn't mark")
eq(st3.blocks["block:1"].restored_in, nil, "T2 a failed write leaves it unmarked")
eq(restored(lib.plan_restore(st3, on_time)), "block:1", "T2 after a failed write it's still eligible")
eq(lib.mark_restored(st3, "block:1", CUR, true), true, "T2 a write marks it")
eq(restored(lib.plan_restore(st3, on_time)), "", "T2 restored once: not again in this instance")
eq(lib.mark_restored(st3, "block:missing", CUR, true), false, "T2 mark_restored of an unknown block")

-- T6: late start -> nothing typed, entries dropped
local late = lib.plan_restore(state_of({ ["block:1"] = entry({ instance_id = OLD, last_seen_at = recent }) }), { instance_id = CUR, started_at = START, now = START + lib.RESTORE_WINDOW + 1 })
eq(restored(late), "", "T6 late start: nothing typed")
eq(dropped(late), "block:1", "T6 late start: dropped")
eq(restored(lib.plan_restore(state_of({ ["block:1"] = entry({ instance_id = OLD, last_seen_at = recent }) }), { instance_id = CUR, started_at = START, now = START + lib.RESTORE_WINDOW })), "block:1", "T6 at the window's end: still typed")

-- T7: one restore per session
local dup = lib.plan_restore(state_of({
  ["block:1"] = entry({ instance_id = OLD, last_seen_at = recent }),
  ["block:2"] = entry({ instance_id = OLD, last_seen_at = recent }),
  ["block:3"] = entry({ instance_id = OLD, last_seen_at = recent, session_id = B }),
}), on_time)
eq(restored(dup), "block:1,block:3", "T7 duplicate session id: restored once")
eq(dropped(dup), "block:2", "T7 the duplicate is dropped")
eq(restored(lib.plan_restore(state_of({
  ["block:1"] = entry({ instance_id = OLD, last_seen_at = recent, agent = "opencode", session_id = "s1" }),
  ["block:2"] = entry({ instance_id = OLD, last_seen_at = recent, agent = "pi", session_id = "s1" }),
}), on_time)), "block:1,block:2", "T7 the same id in two agents is two sessions")

-- T9: entries of an older instance than the one that just ended
local t9 = lib.plan_restore(state_of({
  ["block:1"] = entry({ instance_id = "i-older", last_seen_at = recent }),
  ["block:2"] = entry({ instance_id = OLD, last_seen_at = recent, session_id = B }),
}), on_time)
eq(restored(t9), "block:2", "T9 only the instance that just ended")
eq(dropped(t9), "block:1", "T9 older instance dropped")

-- T13: heartbeat mismatch, stale last_seen_at, an agent-less instance between
eq(restored(lib.plan_restore(state_of({ ["block:1"] = entry({ instance_id = OLD, last_seen_at = recent }) }, { instance_id = "i-between", last_sweep_at = recent }), on_time)), "", "T13 heartbeat of another instance: nothing typed")
eq(restored(lib.plan_restore(state_of({ ["block:1"] = entry({ instance_id = OLD, last_seen_at = recent - 2 * lib.SWEEP - 1 }) }), on_time)), "", "T13 stale last_seen_at: nothing typed")
eq(restored(lib.plan_restore(state_of({ ["block:1"] = entry({ instance_id = OLD, last_seen_at = recent - 2 * lib.SWEEP }) }), on_time)), "block:1", "T13 seen within two sweeps of the last: typed")
local between = lib.plan_restore(state_of({ ["block:1"] = entry({ instance_id = OLD, last_seen_at = recent }) }, nil), on_time)
eq(restored(lib.plan_restore({ version = 1, blocks = { ["block:1"] = entry({ instance_id = OLD, last_seen_at = recent }) } }, on_time)), "", "T13 no heartbeat: nothing typed")
eq(restored(between), "block:1", "T13 control: the same entry with its own heartbeat is typed")

if failures > 0 then
  io.stderr:write(string.format("%d of %d checks failed\n", failures, count))
  os.exit(1)
end
print(string.format("%d checks passed", count))
