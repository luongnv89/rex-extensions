-- rex-sshtab: the pure part. Reads an ssh command line and builds the one a
-- new tab runs to reach the same machine, and decides which AI agent sessions
-- to resume after the Rex server restarts. No rex calls here, so the tests run
-- it with a plain Lua 5.1.

local M = {}

-- ssh's options that take an argument (OpenSSH's getopt string).
local TAKES_ARG = {}
for c in ("BbcDEeFIiJLlmOoPpQRSWw"):gmatch(".") do TAKES_ARG[c] = true end

-- Options the new tab leaves out:
--   -f -N -s         background, no shell, subsystem: they don't give a shell
--   -T -n            no pty, stdin from /dev/null: they break an interactive shell
--   -L -R -D -W      forwards: the first ssh holds those ports already
--   -O -M            control commands and master mode
--   -G -V            print the config or the version and exit
local DROP = {}
for c in ("fNsTnLRDWOMGV"):gmatch(".") do DROP[c] = true end

-- Programs this extension follows into a new tab.
M.PROGRAMS = { ssh = true }

-- argv from /proc/PID/cmdline: NUL-separated, exact.
function M.split_nul(text)
  if type(text) ~= "string" or text == "" then return nil end
  local argv = {}
  for word in (text:gsub("%z$", "") .. "\0"):gmatch("([^%z]*)%z") do argv[#argv + 1] = word end
  return #argv > 0 and argv or nil
end

-- argv from `ps -o args=`: split on whitespace, so an argument that held a
-- space comes back as several.
function M.split_words(text)
  if type(text) ~= "string" then return nil end
  local argv = {}
  for word in text:gmatch("%S+") do argv[#argv + 1] = word end
  return #argv > 0 and argv or nil
end

-- The base name of a program path: "ssh" for "/usr/bin/ssh".
function M.program(path)
  if type(path) ~= "string" then return nil end
  return path:match("([^/]+)$")
end

-- The ssh command that opens a shell on the machine `argv` connects to:
-- the same program, options and destination, without the remote command and
-- the options in DROP. Returns the new argv and the destination, or nil when
-- argv has no destination.
--
-- Like OpenSSH, options may come before or after the destination; the first
-- word after the destination that isn't an option starts the remote command.
function M.ssh_command(argv)
  if type(argv) ~= "table" or not argv[1] then return nil end
  local out = { argv[1] }
  local dest
  local i = 2
  while i <= #argv do
    local word = argv[i]
    if word == "--" then
      -- Everything after "--" is the destination, then the command.
      if not dest then dest = argv[i + 1] end
      break
    elseif word:sub(1, 1) == "-" and #word > 1 then
      local j = 2
      while j <= #word do
        local c = word:sub(j, j)
        if TAKES_ARG[c] then
          local value = word:sub(j + 1)
          if value == "" then
            i = i + 1
            value = argv[i]
          end
          if value == nil then return nil end
          if not DROP[c] then
            out[#out + 1] = "-" .. c
            out[#out + 1] = value
          end
          break
        end
        if not DROP[c] then out[#out + 1] = "-" .. c end
        j = j + 1
      end
    elseif not dest then
      dest = word
    else
      break -- the remote command
    end
    i = i + 1
  end
  if not dest or dest == "" then return nil end
  out[#out + 1] = dest
  return out, dest
end

-- Shells a new tab starts. A tab whose foreground is one of these, and
-- nothing else, is a plain shell waiting for input.
M.SHELLS = { zsh = true, bash = true, fish = true, sh = true, dash = true, ksh = true, mksh = true, tcsh = true, csh = true, nu = true, xonsh = true, elvish = true }

-- Whether a process name is a shell: "zsh", "-zsh" (a login shell), "/bin/zsh".
function M.is_shell(name)
  if type(name) ~= "string" then return false end
  name = M.program(name:gsub("^%-", "")) or ""
  return M.SHELLS[name] == true
end

-- One argument quoted for a POSIX shell (and zsh, bash, fish): left as it is
-- when it holds only safe characters, else in single quotes.
function M.quote(word)
  word = tostring(word)
  if word ~= "" and not word:find("[^%w@%%_%-%+=:,%./~]") and word:sub(1, 1) ~= "~" then return word end
  return "'" .. word:gsub("'", [['\'']]) .. "'"
end

-- A command line to type into a shell.
function M.command_line(argv)
  local words = {}
  for i, word in ipairs(argv) do words[i] = M.quote(word) end
  return table.concat(words, " ")
end

-- The pane a new pane was split from: its sibling in the layout tree. When a
-- pane is split, the new one and the old one become the two sides of a new
-- split node, so right after the split the other side is a single pane.
-- `window` is a window from session.view. Returns nil when the pane isn't
-- in a tiled layer or its sibling is more than one pane.
function M.split_source(window, block_id)
  local function walk(node)
    if type(node) ~= "table" then return nil end
    local split = node.split
    if type(split) ~= "table" then return nil end
    local before, after = split.before or {}, split.after or {}
    if before.block_id == block_id then return after.block_id end
    if after.block_id == block_id then return before.block_id end
    return walk(before) or walk(after)
  end
  for _, layer in ipairs((type(window) == "table" and window.layers) or {}) do
    if layer.kind == nil or layer.kind == "tiled" then
      local found = walk(layer.layout)
      if found then return found end
    end
  end
  return nil
end

-- Whether a terminal's process reply is a plain shell: started as a login
-- shell or a shell (not a command such as `node panel.js` run through one),
-- with a shell in the foreground.
function M.plain_shell(process)
  if type(process) ~= "table" then return false end
  local child, fg = process.child, process.foreground
  if type(child) ~= "table" or type(fg) ~= "table" then return false end
  local started = child.name == "login" or M.is_shell(child.name) or M.is_shell(child.argv0)
  return started and M.is_shell(fg.name)
end

-- The ssh command for a terminal's process reply, given a function that
-- returns the argv of a pid. Returns argv, destination and the local folder
-- ssh runs in, or nil when the terminal isn't running ssh.
function M.from_process(process, argv_of)
  local fg = type(process) == "table" and process.foreground
  if type(fg) ~= "table" or not fg.pid then return nil end
  if not M.PROGRAMS[fg.name] and not M.PROGRAMS[M.program(fg.path)] then return nil end
  local argv = argv_of(fg.pid)
  if not argv then return nil end
  local cmd, dest = M.ssh_command(argv)
  if not cmd then return nil end
  return cmd, dest, fg.cwd
end


-- Agent sessions after a restart ------------------------------------------
--
-- The watcher records which AI coding agent runs in each pane, and the exact
-- session it runs, in agents.json. When the server comes back, every pane is
-- a plain shell again in its old folder, and the watcher types one line into
-- it that resumes that session. Everything that decides what is recorded and
-- what is typed is here, so it can be tested without a server.

-- How long after the server starts a restore may still type, in seconds.
M.RESTORE_WINDOW = 120
-- How often the watcher sweeps every pane, in seconds.
M.SWEEP = 15

-- Shells a restore types into. Their line editors take the line the same way,
-- and lib.quote quotes for all of them. csh, tcsh, nu, xonsh and elvish read
-- quotes and `&&` differently, so they are skipped.
M.RESTORE_SHELLS = { zsh = true, bash = true, sh = true, dash = true, ksh = true, mksh = true, fish = true }

-- The agents that are resumed. Each one names the program the restored line
-- runs and the words before the session id; nothing in agents.json can change
-- either. `env` is the one environment variable that is carried over, when it
-- points somewhere other than the default.
M.AGENTS = {
  claude = { program = "claude", resume = { "--resume" }, env = "CLAUDE_CONFIG_DIR" },
  codex = { program = "codex", resume = { "resume" }, env = "CODEX_HOME" },
  opencode = { program = "opencode", resume = { "--session" } },
  ["cursor-agent"] = { program = "cursor-agent", resume = { "--resume" } },
  pi = { program = "pi", resume = { "--session" } },
}

-- Agents that are recognized but not resumed, and why.
M.NOT_RESTORED = {
  gemini = "it has no resume by exact session id",
  amp = "it has no resume by exact session id that this extension has verified",
  qwen = "its session id isn't visible from outside the process",
  copilot = "its session id isn't visible from outside the process",
  kimi = "its session id isn't visible from outside the process",
}

-- A session id as an agent prints it: a letter or digit, then letters,
-- digits and . _ : -, at most 128 characters. Nothing a shell reads specially.
function M.valid_session_id(id)
  return type(id) == "string" and #id <= 128 and id:find("^[%w][%w%._:%-]*$") ~= nil
end

local UUID = "^%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$"
function M.valid_uuid(id)
  return type(id) == "string" and id:find(UUID) ~= nil
end

-- An absolute path with no control characters, such as a folder or a config dir.
function M.valid_path(path)
  return type(path) == "string" and path:sub(1, 1) == "/" and #path <= 4096 and not path:find("%c")
end

-- The agent a terminal's foreground process runs, by the name it was run by:
-- a node script's name, the path it was invoked through (Claude's executable
-- is named after its version), argv[0], or the executable. Returns the agent's
-- name, which is a key of AGENTS or NOT_RESTORED, or nil.
function M.identify_agent(fg)
  if type(fg) ~= "table" then return nil end
  for _, p in ipairs({ fg.script or false, fg.invoked_path or false, fg.argv0 or false, fg.path or false, fg.name or false }) do
    if type(p) == "string" then
      local name = (M.program(p) or ""):gsub("^%-", ""):gsub("%.[cm]?js$", "")
      if M.AGENTS[name] or M.NOT_RESTORED[name] then return name end
    end
  end
  return nil
end

-- The arguments an agent was started with: the words after its program in
-- argv, which may be a node or shell wrapper's. Cursor Agent's launcher runs
-- `node [--use-system-ca] .../index.js ARGS` under its own name.
function M.agent_args(argv, agent)
  if type(argv) ~= "table" then return nil end
  for i, word in ipairs(argv) do
    local name = (M.program(word) or ""):gsub("%.[cm]?js$", "")
    if name == agent then
      local args = {}
      for j = i + 1, #argv do args[#args + 1] = argv[j] end
      if agent == "cursor-agent" then
        if args[1] == "--use-system-ca" then table.remove(args, 1) end
        if args[1] and args[1]:find("/index%.js$") then table.remove(args, 1) end
      end
      return args
    end
  end
  return nil
end

local function set(list)
  local t = {}
  for _, k in ipairs(list) do t[k] = true end
  return t
end

-- Options each argv-read agent may be started with. A word that isn't one of
-- them, or a positional word (a prompt, a folder, a subcommand such as
-- `opencode run`), means the session isn't recorded.
local ARGV_SPECS = {
  opencode = {
    id = set({ "-s", "--session" }),
    values = set({ "--log-level", "-m", "--model", "--agent" }),
    flags = set({ "--auto", "--standalone", "--print-logs" }),
  },
  ["cursor-agent"] = {
    id = set({ "--resume" }),
    values = set({ "--model", "--sandbox", "--mode" }),
    flags = set({ "-f", "--force", "--yolo", "--trust", "--approve-mcps", "--plan", "--auto-review" }),
  },
  pi = {
    id = set({ "--session" }),
    values = set({ "--model", "--provider", "--thinking" }),
    flags = set({ "-a", "--approve", "--offline", "--verbose" }),
  },
}

-- The session id an argv-read agent was started with, or nil. The id is required.
local function flag_session(args, spec)
  local id
  local i = 1
  while i <= #args do
    local word = args[i]
    local key, value = word:match("^(%-%-[^=]+)=(.*)$")
    if key then
      if spec.id[key] then
        if id then return nil end
        id = value
      elseif not spec.values[key] then
        return nil
      end
    elseif spec.id[word] then
      if id then return nil end
      i = i + 1
      id = args[i]
      if not id or id:sub(1, 1) == "-" then return nil end
    elseif spec.values[word] then
      i = i + 1
      if not args[i] then return nil end
    elseif not spec.flags[word] then
      return nil
    end
    i = i + 1
  end
  return M.valid_session_id(id) and id or nil
end

-- codex's global options, before its subcommand.
local CODEX_VALUES = set({ "-c", "--config", "--enable", "--disable", "--remote", "--remote-auth-token-env", "-m", "--model",
  "--local-provider", "-p", "--profile", "-s", "--sandbox", "-C", "--cd", "--add-dir", "-a", "--ask-for-approval" })
local CODEX_FLAGS = set({ "--strict-config", "--oss", "--approve-for-me", "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust", "--worktree", "--search", "--no-alt-screen", "--no-daemon", "--full-auto" })

-- The session a codex was started on: only `codex [global options] resume
-- UUID`, with nothing after the UUID. `codex`, `codex "prompt"`, `codex exec`
-- (or `e`), `review`, `app-server`, `resume --last` and the rest give nil.
local function codex_session(args)
  local i = 1
  while i <= #args do
    local word = args[i]
    local key = word:match("^(%-%-[^=]+)=")
    if key and CODEX_VALUES[key] then
      i = i + 1
    elseif CODEX_VALUES[word] then
      i = i + 2
    elseif CODEX_FLAGS[word] then
      i = i + 1
    elseif word == "resume" then
      local id = args[i + 1]
      if #args == i + 1 and M.valid_uuid(id) then return id end
      return nil
    else
      return nil
    end
  end
  return nil
end

-- The exact session an agent read from its argv runs (codex, opencode,
-- cursor-agent, pi), or nil.
function M.argv_session(agent, args)
  if type(args) ~= "table" then return nil end
  if agent == "codex" then return codex_session(args) end
  local spec = ARGV_SPECS[agent]
  return spec and flag_session(args, spec) or nil
end

-- The session in Claude's own record of a process, the decoded
-- <config dir>/sessions/<pid>.json. Only an interactive session of that very
-- pid counts. Returns the session id and the folder it runs in, or nil and why.
function M.claude_session(record, pid)
  if type(record) ~= "table" then return nil, "no session record" end
  if tonumber(record.pid) ~= tonumber(pid) then return nil, "the session record is another process's" end
  if record.kind ~= "interactive" then return nil, "not an interactive session (" .. tostring(record.kind) .. ")" end
  if not M.valid_session_id(record.sessionId) then return nil, "the session id isn't one this extension types" end
  return record.sessionId, M.valid_path(record.cwd) and record.cwd or nil
end

-- The values of the `allow`ed variables in a process's environment, from
-- macOS's `ps -ww -o args=` (`args`) and `ps -wwE -o args=` (`all`), which
-- prints the environment after the arguments. Only words after the exact
-- arguments count, so `claude "CLAUDE_CONFIG_DIR=/x"` doesn't set anything.
function M.env_from_ps(args, all, allow)
  local env = {}
  if type(args) ~= "string" or type(all) ~= "string" then return env end
  args, all = args:gsub("%s+$", ""), all:gsub("%s+$", "")
  if args == "" or all:sub(1, #args) ~= args then return env end
  local rest = all:sub(#args + 1)
  if rest ~= "" and not rest:find("^%s") then return env end
  for word in rest:gmatch("%S+") do
    local key, value = word:match("^([%w_]+)=(.*)$")
    if key and allow[key] and env[key] == nil then env[key] = value end
  end
  return env
end

-- The same, from Linux's /proc/PID/environ: NUL-separated and exact.
function M.env_from_environ(text, allow)
  local env = {}
  for _, word in ipairs(M.split_nul(text) or {}) do
    local key, value = word:match("^([%w_]+)=(.*)$")
    if key and allow[key] and env[key] == nil then env[key] = value end
  end
  return env
end

-- The line editor keymap of a shell, from what it started with: zsh starts in
-- vi mode when VISUAL or EDITOR holds "vi"; zsh, bash and fish are in emacs
-- mode otherwise. Other shells, and a keymap set in an rc file, are unknown
-- here: "emacs", "vi" or "unknown".
function M.keymap(shell, env)
  shell = M.program((shell or ""):gsub("^%-", ""))
  env = env or {}
  if shell == "zsh" then
    for _, k in ipairs({ "VISUAL", "EDITOR" }) do
      if type(env[k]) == "string" and env[k]:find("vi") then return "vi" end
    end
    return "emacs"
  end
  if shell == "bash" or shell == "fish" then return "emacs" end
  return "unknown"
end

-- Whether a process name is a shell a restore types into.
function M.restore_shell(name)
  if type(name) ~= "string" then return false end
  return M.RESTORE_SHELLS[M.program(name:gsub("^%-", "")) or ""] == true
end

-- The line that resumes an entry's session in its folder, or nil when the
-- entry isn't valid. The program and the words before the id come from AGENTS;
-- the folder, the id and the one environment value are quoted.
function M.resume_line(entry)
  if type(entry) ~= "table" then return nil end
  local agent = M.AGENTS[entry.agent]
  if not agent or not M.valid_path(entry.cwd) then return nil end
  local id = entry.session_id
  if not (agent.program == "codex" and M.valid_uuid(id) or agent.program ~= "codex" and M.valid_session_id(id)) then return nil end
  local words = {}
  local env = entry.env
  if type(env) == "table" and next(env) ~= nil then
    local value = agent.env and env[agent.env]
    if not M.valid_path(value) then return nil end
    for k in pairs(env) do if k ~= agent.env then return nil end end
    words[#words + 1] = "env"
    words[#words + 1] = agent.env .. "=" .. M.quote(value)
  end
  words[#words + 1] = agent.program
  for _, w in ipairs(agent.resume) do words[#words + 1] = w end
  words[#words + 1] = M.quote(id)
  return "cd " .. M.quote(entry.cwd) .. " && " .. table.concat(words, " ")
end

-- Seconds since 1970 for a UTC time such as 2026-11-11T22:13:40.26Z, or nil.
-- Computed by hand, because os.time reads a date as local time.
function M.iso_to_epoch(text)
  if type(text) ~= "string" then return nil end
  local y, mo, d, h, mi, s = text:match("^(%d%d%d%d)%-(%d%d)%-(%d%d)T(%d%d):(%d%d):(%d%d)")
  if not y then return nil end
  y, mo, d, h, mi, s = tonumber(y), tonumber(mo), tonumber(d), tonumber(h), tonumber(mi), tonumber(s)
  local rest = text:sub(20):gsub("^%.%d+", "")
  local offset = 0
  if rest ~= "Z" then
    local sign, oh, om = rest:match("^([%+%-])(%d%d):?(%d%d)$")
    if not sign then return nil end
    offset = (tonumber(oh) * 3600 + tonumber(om) * 60) * (sign == "+" and 1 or -1)
  end
  -- Days from 1970-01-01 to y-mo-d (Howard Hinnant's days_from_civil).
  if mo <= 2 then y = y - 1 end
  local era = math.floor(y / 400)
  local yoe = y - era * 400
  local mp = (mo + 9) % 12
  local doy = math.floor((153 * mp + 2) / 5) + d - 1
  local doe = yoe * 365 + math.floor(yoe / 4) - math.floor(yoe / 100) + doy
  local days = era * 146097 + doe - 719468
  return days * 86400 + h * 3600 + mi * 60 + s - offset
end

-- Seconds from `ps -o etime=`, written [[dd-]hh:]mm:ss, or nil.
function M.parse_etime(text)
  if type(text) ~= "string" then return nil end
  text = text:gsub("^%s+", ""):gsub("%s+$", "")
  local days, clock = text:match("^(%d+)%-(.+)$")
  clock = clock or text
  local parts = {}
  for n in clock:gmatch("[^:]+") do
    if not n:find("^%d+$") then return nil end
    parts[#parts + 1] = tonumber(n)
  end
  if #parts < 2 or #parts > 3 or (days and #parts ~= 3) then return nil end
  local h, m, s = 0, parts[#parts - 1], parts[#parts]
  if #parts == 3 then h = parts[1] end
  return (tonumber(days) or 0) * 86400 + h * 3600 + m * 60 + s
end

-- The line the cursor is on in a terminal's text: its last line.
function M.cursor_line(content)
  if type(content) ~= "string" then return nil end
  content = content:gsub("[\r\n]+$", "")
  return content:match("([^\n]*)$")
end

-- agents.json ---------------------------------------------------------------
--
--   { version = 1,
--     heartbeat = { instance_id, last_sweep_at },  -- the last timed sweep
--     blocks = { [block_id] = { agent, session_id, cwd, env, instance_id,
--                               last_seen_at, missing_sweeps, restored_in } } }
--
-- No argv, prompt, flag or other environment is kept: the line a restore
-- types is rebuilt from AGENTS each time.

local function valid_instance(id)
  return type(id) == "string" and #id <= 128 and id:find("^[%w][%w%-]*$") ~= nil
end

local function valid_block(id)
  return type(id) == "string" and #id <= 128 and id:find("^block:[%w%-]+$") ~= nil
end

function M.new_state()
  return { version = 1, blocks = {} }
end

-- A state read from disk, keeping only what is valid: an entry with an unknown
-- agent, a bad id, a relative folder or an extra environment variable is dropped.
function M.clean_state(raw)
  local state = M.new_state()
  if type(raw) ~= "table" or raw.version ~= 1 then return state end
  local hb = raw.heartbeat
  if type(hb) == "table" and valid_instance(hb.instance_id) and type(hb.last_sweep_at) == "number" then
    state.heartbeat = { instance_id = hb.instance_id, last_sweep_at = hb.last_sweep_at }
  end
  for block_id, e in pairs(type(raw.blocks) == "table" and raw.blocks or {}) do
    if valid_block(block_id) and type(e) == "table" and valid_instance(e.instance_id)
      and type(e.last_seen_at) == "number" and M.resume_line(e) ~= nil
      and (e.restored_in == nil or valid_instance(e.restored_in)) then
      local env
      if type(e.env) == "table" and next(e.env) ~= nil then env = {} for k, v in pairs(e.env) do env[k] = v end end
      state.blocks[block_id] = {
        agent = e.agent, session_id = e.session_id, cwd = e.cwd, env = env,
        instance_id = e.instance_id, last_seen_at = e.last_seen_at,
        missing_sweeps = tonumber(e.missing_sweeps) or 0, restored_in = e.restored_in,
      }
    end
  end
  return state
end

-- Record what a sweep saw running in a block: `seen` = { agent, session_id,
-- cwd, env }. Returns false when it isn't something a restore could type.
function M.observe(state, block_id, seen, instance, now)
  local entry = {
    agent = seen.agent, session_id = seen.session_id, cwd = seen.cwd, env = seen.env,
    instance_id = instance, last_seen_at = now, missing_sweeps = 0,
  }
  if not valid_block(block_id) or not valid_instance(instance) or not M.resume_line(entry) then return false end
  local old = state.blocks[block_id]
  if old and old.restored_in == instance then entry.restored_in = instance end
  state.blocks[block_id] = entry
  return true
end

-- What a sweep does to a block's entry when it doesn't see its agent:
-- `what` is "absent" (the block is there, running something else) or "gone"
-- (the block isn't in any session). Only a timed sweep prunes, and only
-- entries of this server instance: a gone block at once, an absent agent once
-- it is missing from two timed sweeps in a row. Shutting the server down
-- kills the agents seconds before the server stops, and the events that
-- causes must not lose them. Returns the entry to keep, or nil to drop it.
function M.prune_step(entry, what, instance, timed)
  if entry.instance_id ~= instance or not timed then return entry end
  if what == "gone" then return nil end
  if what == "absent" then
    entry.missing_sweeps = (entry.missing_sweeps or 0) + 1
    if entry.missing_sweeps >= 2 then return nil end
  end
  return entry
end

-- The heartbeat a timed sweep leaves, with or without agents running.
function M.heartbeat(state, instance, now)
  state.heartbeat = { instance_id = instance, last_sweep_at = now }
end

-- What to do with a state saved before this server started. `server` is
-- { instance_id, started_at, now }. Returns { restore = { {block_id, entry} },
-- drop = { {block_id, reason} } }, both sorted by block id. Nothing is typed:
--   - in the instance that wrote the heartbeat (the watcher restarted, or was
--     toggled, in the same server);
--   - after RESTORE_WINDOW (a watcher started late);
--   - for an entry of another instance than the one that just ended, or one
--     its last sweeps no longer saw;
--   - twice for one session, or twice in one instance.
function M.plan_restore(state, server)
  local plan = { restore = {}, drop = {} }
  local current = server.instance_id
  local hb = state.heartbeat
  local ids = {}
  for block_id in pairs(state.blocks) do ids[#ids + 1] = block_id end
  table.sort(ids)
  local late = (server.now - server.started_at) > M.RESTORE_WINDOW
  local seen = {}
  for _, block_id in ipairs(ids) do
    local e = state.blocks[block_id]
    local why
    if e.instance_id == current then
      why = nil -- this instance's own entry: kept, not restored
    elseif late then
      why = "the watcher started more than " .. M.RESTORE_WINDOW .. " seconds after the server"
    elseif not hb or hb.instance_id == current then
      why = "no sweep of the server that just ended"
    elseif e.instance_id ~= hb.instance_id then
      why = "from an older server than the one that just ended"
    elseif e.last_seen_at < hb.last_sweep_at - 2 * M.SWEEP then
      why = "not seen in the last sweeps before the server ended"
    elseif e.restored_in == current then
      why = "already restored"
    else
      local key = e.agent .. " " .. e.session_id
      if seen[key] then
        why = "the same session is resumed in " .. seen[key]
      else
        seen[key] = block_id
        plan.restore[#plan.restore + 1] = { block_id = block_id, entry = e }
      end
    end
    if why then plan.drop[#plan.drop + 1] = { block_id = block_id, reason = why } end
  end
  return plan
end

-- Mark an entry restored in this instance, once its line was written. A
-- failed write leaves it as it was, so it can be tried again.
function M.mark_restored(state, block_id, instance, ok)
  local e = state.blocks[block_id]
  if not ok or not e then return false end
  e.restored_in = instance
  return true
end

return M
