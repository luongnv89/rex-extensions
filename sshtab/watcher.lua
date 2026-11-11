-- rex-sshtab watcher: when you open a new tab from a tab that's ssh'd into a
-- machine, or split a pane that's ssh'd into one, types the same ssh command
-- into the new tab or pane. rex-sshtab.lua starts it with
--
--   rex do watcher.lua --all state=DIR
--
-- and stops it by creating DIR/off.
--
-- It acts only on a tab or pane that Rex.app itself made (the + button, New
-- Tab in the menu or the command palette, cmd+t, and the split keys, menu
-- items and buttons): a new shell block whose creator is a client of kind
-- "app", that started as a plain shell. Tabs and panes that scripts and agents
-- open (rex window new, rex run, rex split, rex do) come from other clients
-- and are left alone. It decides nothing it can't check, and logs each
-- decision to DIR/log.
--
-- It also keeps DIR/agents.json: which AI coding agent session runs in each
-- pane (Claude Code, Codex, OpenCode, Cursor Agent, pi). When the server
-- restarts, the panes come back as plain shells in their old folders, and the
-- watcher types into each one the line that resumes its session. lib.lua
-- decides what is recorded and what is typed; DIR/restore-off turns it off.

local here = debug.getinfo(1, "S").source:gsub("^@", ""):match("^(.*)/[^/]*$") or "."
local lib = dofile(here .. "/lib.lua")

local TERMINAL = "com.superlogical.terminal"
local STATE = rex.args.state or ((os.getenv("HOME") or "") .. "/.cache/rex-sshtab")
local OFF = STATE .. "/off"
local LOG = STATE .. "/log"
local AGENTS_FILE = STATE .. "/agents.json"
local RESTORE_OFF = STATE .. "/restore-off"
local HOME = os.getenv("HOME") or ""
local LOG_MAX = 256 * 1024
-- The kinds of client whose new tabs are followed. Only "app" in use; tests
-- pass trust=app,cli to drive it from the CLI.
local TRUST = {}
for kind in (rex.args.trust or "app"):gmatch("[^,]+") do TRUST[kind] = true end
-- How long to wait for the new tab's shell before giving up, in seconds.
local SHELL_WAIT = 5
-- After the shell is up, how long to wait for its prompt before typing anyway.
local PROMPT_WAIT = 2
-- How often to look, in seconds.
local POLL = 0.05

local function exists(path)
  local f = io.open(path, "r")
  if f then f:close() return true end
  return false
end

-- Start a fresh log when the old one is too big.
do
  local f = io.open(LOG, "r")
  if f then
    local size = f:seek("end")
    f:close()
    if size and size > LOG_MAX then os.remove(LOG) end
  end
end

local function log(msg)
  local f = io.open(LOG, "a")
  if not f then return end
  f:write(os.date("%Y-%m-%d %H:%M:%S "), msg, "\n")
  f:close()
end

local function call(method, args)
  local result, err = rex.call(method, args)
  if not result and err then log(method .. " failed: " .. tostring(err)) end
  return result
end

local function block_call(session_id, block_id, method, args)
  args = args or {}
  args.session_id, args.block_id = session_id, block_id
  local ok, result = pcall(rex.block.call, TERMINAL, method, args)
  if ok then return result end
  return nil
end

-- The arguments a process was started with. Linux has them exactly in
-- /proc; elsewhere ps prints them joined by spaces.
local function argv_of(pid)
  local f = io.open("/proc/" .. tostring(pid) .. "/cmdline", "rb")
  if f then
    local text = f:read("*a")
    f:close()
    local argv = lib.split_nul(text)
    if argv then return argv end
  end
  local r = rex.exec({ "ps", "-ww", "-o", "args=", "-p", tostring(pid) })
  if not (r and r.ok) then return nil end
  return lib.split_words(r.stdout)
end

local function client_kind(client_id)
  local list = call("client.list", {})
  for _, c in ipairs((list and list.clients) or {}) do
    if c.client_id == client_id then return c.info and c.info.kind end
  end
  return nil
end

local function find_window(view, window_id)
  for _, window in ipairs((view and view.windows) or {}) do
    if window.window_id == window_id then return window end
  end
  return nil
end

local function blocks_of(window)
  local list = {}
  for _, layer in ipairs(window.layers or {}) do
    for _, block in ipairs(layer.blocks or {}) do list[#list + 1] = block end
  end
  return list
end

-- The terminal a tab shows: the one it last focused, else its first terminal.
local function focused_terminal(window)
  local first
  for _, block in ipairs(blocks_of(window)) do
    if block.creator_name == TERMINAL then
      if block.block_id == window.focused_block_id then return block end
      first = first or block
    end
  end
  return first
end

local active = {}   -- session_id -> the active window, as of the last event
local created = {}  -- block_id -> kind of the client that created it ("app", "cli", ...)

local function seed(session_id)
  local view = call("session.view", { session_id = session_id })
  if view then active[session_id] = view.active_window_id end
end

-- Type `line` into the new tab or pane once its shell waits at its prompt. A
-- shell's line editor (zsh's, bash's readline, fish's) takes the terminal out
-- of canonical mode while it reads, so that's the sign. A shell without one
-- stays canonical: after PROMPT_WAIT with the shell running, type anyway.
-- A pane started with a command, such as a panel's `node panel.js`, is never
-- a plain shell, even while a login shell starts it.
local function type_when_ready(session_id, block_id, line)
  local polls, shell_polls = 0, 0
  local function send()
    local r = block_call(session_id, block_id, "write", { data = line .. "\r" })
    log((r and "typed " or "couldn't type ") .. line .. " into " .. block_id)
  end
  local function poll()
    if exists(OFF) then return end
    polls = polls + 1
    local process = block_call(session_id, block_id, "process")
    if not process then return log("skip " .. block_id .. ": it's gone") end
    local child, fg = process.child, process.foreground
    -- Rex starts every pane through itself ("rex"), then execs the program.
    local starting = not child or child.name == "rex"
    if not starting and child.name ~= "login" and not lib.is_shell(child.name) and not lib.is_shell(child.argv0) then
      return log("skip " .. block_id .. ": it runs " .. tostring(child.name) .. ", not a shell")
    end
    if lib.plain_shell(process) then
      shell_polls = shell_polls + 1
      local mode = block_call(session_id, block_id, "input_mode")
      if (mode and mode.canonical == false) or shell_polls * POLL >= PROMPT_WAIT then return send() end
    elseif polls * POLL >= SHELL_WAIT then
      return log("skip " .. block_id .. ": its shell didn't start (foreground " .. tostring(fg and fg.name) .. ")")
    end
    rex.after(POLL, poll)
  end
  poll()
end

local function on_window_created(ctx, ev)
  local session_id = ctx.session_id or ev.session_id
  local source_id = active[session_id]
  if exists(OFF) or not session_id then return end
  local view = call("session.view", { session_id = session_id })
  local window = find_window(view, ev.window_id)
  if not window then return end
  local blocks = blocks_of(window)
  -- One new terminal: not a moved pane, a layout, or a session's first tab.
  if #blocks ~= 1 or blocks[1].creator_name ~= TERMINAL then return end
  local block_id = blocks[1].block_id
  local kind = created[block_id]
  created[block_id] = nil
  if not TRUST[kind] then
    return log("skip " .. ev.window_id .. ": made by " .. tostring(kind or "an unknown client") .. ", not the app")
  end
  local source = source_id and source_id ~= ev.window_id and find_window(view, source_id)
  if not source then return log("skip " .. ev.window_id .. ": no tab it was opened from") end
  local from = focused_terminal(source)
  if not from then return log("skip " .. ev.window_id .. ": the tab it came from has no terminal") end
  local process = block_call(session_id, from.block_id, "process")
  local cmd, dest = lib.from_process(process, argv_of)
  if not cmd then return log("skip " .. ev.window_id .. ": the tab it came from isn't running ssh") end
  log("new tab " .. ev.window_id .. " from an ssh tab: connecting to " .. dest)
  type_when_ready(session_id, block_id, lib.command_line(cmd))
end

-- A new pane in a window that has others: a split, if its sibling in the
-- layout is one pane. A new tab's pane is alone in its window and is left to
-- on_window_created, which comes next.
local function on_block_created(session_id, block_id, kind)
  if exists(OFF) or not session_id then return end
  local view = call("session.view", { session_id = session_id })
  local window
  for _, w in ipairs((view and view.windows) or {}) do
    for _, b in ipairs(blocks_of(w)) do
      if b.block_id == block_id then window = w end
    end
  end
  if not window or #blocks_of(window) < 2 then return end
  created[block_id] = nil
  local source = lib.split_source(window, block_id)
  if not source then return log("skip " .. block_id .. ": not split from a single pane") end
  if not TRUST[kind] then
    return log("skip pane " .. block_id .. ": made by " .. tostring(kind) .. ", not the app")
  end
  local process = block_call(session_id, source, "process")
  local cmd, dest = lib.from_process(process, argv_of)
  if not cmd then return log("skip pane " .. block_id .. ": the pane it was split from isn't running ssh") end
  log("new pane " .. block_id .. " split from an ssh pane: connecting to " .. dest)
  type_when_ready(session_id, block_id, lib.command_line(cmd))
end

-- Agent sessions -------------------------------------------------------------

local server       -- { instance_id, started_at } of the server this watcher talks to
local state = lib.new_state()
local reported = {} -- pid -> true once its agent was logged as not restored

local function restore_off() return exists(OFF) or exists(RESTORE_OFF) end

local function load_state()
  local f = io.open(AGENTS_FILE, "r")
  if not f then return lib.new_state() end
  local text = f:read("*a")
  f:close()
  local ok, raw = pcall(rex.json.decode, text)
  return lib.clean_state(ok and raw or nil)
end

-- Write agents.json whole: to a temporary file, then renamed over the old one.
local function save_state()
  if restore_off() then return end
  local ok, text = pcall(rex.json.encode, state)
  if not ok then return log("can't save agents.json: " .. tostring(text)) end
  local tmp = AGENTS_FILE .. ".tmp"
  local f = io.open(tmp, "w")
  if not f then return log("can't write " .. tmp) end
  f:write(text)
  f:close()
  rex.exec({ "chmod", "600", tmp })
  local renamed, err = os.rename(tmp, AGENTS_FILE)
  if not renamed then log("can't save agents.json: " .. tostring(err)) end
end

local function server_info()
  local st = call("server.status", {})
  local started = st and lib.iso_to_epoch(st.started_at)
  if not (st and type(st.instance_id) == "string" and started) then return nil end
  return { instance_id = st.instance_id, started_at = started }
end

local function read_json(path)
  local f = io.open(path, "r")
  if not f then return nil end
  local text = f:read("*a")
  f:close()
  local ok, value = pcall(rex.json.decode, text)
  return ok and value or nil
end

-- The `allow`ed variables of a process's environment: exactly from /proc on
-- Linux, else from ps. Only these are read out; nothing else is kept or logged.
local function read_env(pid, allow)
  local f = io.open("/proc/" .. tostring(pid) .. "/environ", "rb")
  if f then
    local text = f:read("*a")
    f:close()
    return lib.env_from_environ(text, allow)
  end
  local args = rex.exec({ "ps", "-ww", "-o", "args=", "-p", tostring(pid) })
  local all = rex.exec({ "ps", "-wwE", "-o", "args=", "-p", tostring(pid) })
  if not (args and args.ok and all and all.ok) then return {} end
  return lib.env_from_ps(args.stdout, all.stdout, allow)
end

-- A process's environment doesn't change, so each one is read once.
local env_cache, env_cached = {}, 0
local function env_of(pid, allow)
  local keys = {}
  for k in pairs(allow) do keys[#keys + 1] = k end
  table.sort(keys)
  local key = tostring(pid) .. " " .. table.concat(keys, " ")
  if env_cache[key] then return env_cache[key] end
  if env_cached >= 256 then env_cache, env_cached, reported = {}, 0, {} end
  env_cache[key], env_cached = read_env(pid, allow), env_cached + 1
  return env_cache[key]
end

local function is_dir(path)
  local r = rex.exec({ "test", "-d", path })
  return r and r.ok
end

-- Log once per process why its agent isn't recorded.
local function not_recorded(pid, block_id, agent, why)
  if reported[pid] then return nil end
  reported[pid] = true
  log("agent " .. agent .. " in " .. block_id .. " isn't restored: " .. why)
  return nil
end

-- The agent session a terminal runs, from its process reply:
-- { agent, session_id, cwd, env }, or nil.
local function session_in(block_id, process)
  local fg = type(process) == "table" and process.foreground
  local agent = lib.identify_agent(fg)
  if not agent or not fg.pid then return nil end
  if lib.NOT_RESTORED[agent] then return not_recorded(fg.pid, block_id, agent, lib.NOT_RESTORED[agent]) end
  local id, cwd, env = nil, fg.cwd, nil
  if agent == "claude" then
    -- Claude writes <config dir>/sessions/<pid>.json. A CLAUDE_CONFIG_DIR from
    -- its environment counts only when that file is there for this pid.
    local default = HOME .. "/.claude"
    local dirs = {}
    local from_env = env_of(fg.pid, { CLAUDE_CONFIG_DIR = true }).CLAUDE_CONFIG_DIR
    if lib.valid_path(from_env) and from_env ~= default then dirs[1] = from_env end
    dirs[#dirs + 1] = default
    local why
    for _, dir in ipairs(dirs) do
      local found, where = lib.claude_session(read_json(dir .. "/sessions/" .. fg.pid .. ".json"), fg.pid)
      if found then
        id, cwd = found, where or cwd
        if dir ~= default then env = { CLAUDE_CONFIG_DIR = dir } end
        break
      end
      why = why or where
    end
    if not id then return not_recorded(fg.pid, block_id, agent, why or "no session record") end
  else
    id = lib.argv_session(agent, lib.agent_args(argv_of(fg.pid), agent))
    if not id then
      return not_recorded(fg.pid, block_id, agent, "it wasn't started with a session id this extension resumes")
    end
    if agent == "codex" then
      local home = env_of(fg.pid, { CODEX_HOME = true }).CODEX_HOME
      if home and home ~= HOME .. "/.codex" then
        if not (lib.valid_path(home) and is_dir(home .. "/sessions")) then
          return not_recorded(fg.pid, block_id, agent, "its CODEX_HOME has no sessions folder")
        end
        env = { CODEX_HOME = home }
      end
    end
  end
  local seen = { agent = agent, session_id = id, cwd = cwd, env = env }
  -- The reason names what is wrong, never the folder or value itself.
  local line, why = lib.resume_line(seen)
  if not line then return not_recorded(fg.pid, block_id, agent, why) end
  return seen
end

-- Every terminal block, as block_id -> session_id, or nil when a call failed.
local function terminals()
  local list = call("session.list", {})
  if not list then return nil end
  local found = {}
  for _, s in ipairs(list.sessions or {}) do
    local view = call("session.view", { session_id = s.session_id })
    if not view then return nil end
    for _, window in ipairs(view.windows or {}) do
      for _, block in ipairs(blocks_of(window)) do
        if block.creator_name == TERMINAL then found[block.block_id] = s.session_id end
      end
    end
  end
  return found
end

-- Look at every pane and record the agent sessions in them. Only a timed
-- sweep forgets one (see lib.prune_step) and leaves the heartbeat.
local function sweep(timed)
  if not server or restore_off() then return end
  local blocks = terminals()
  if not blocks then return end
  local now = os.time()
  for block_id, session_id in pairs(blocks) do
    local process = block_call(session_id, block_id, "process")
    local seen = process and session_in(block_id, process)
    local old = state.blocks[block_id]
    if seen then
      local changed = not old or old.session_id ~= seen.session_id or old.instance_id ~= server.instance_id
      if lib.observe(state, block_id, seen, server.instance_id, now) and changed then
        log("recorded " .. seen.agent .. " session " .. seen.session_id .. " in " .. block_id)
      end
    elseif process and old then
      state.blocks[block_id] = lib.prune_step(old, "absent", server.instance_id, timed)
      if not state.blocks[block_id] then log("forgot the " .. old.agent .. " session in " .. block_id .. ": it stopped") end
    end
  end
  for block_id, old in pairs(state.blocks) do
    if not blocks[block_id] then
      state.blocks[block_id] = lib.prune_step(old, "gone", server.instance_id, timed)
      if not state.blocks[block_id] then log("forgot the " .. old.agent .. " session in " .. block_id .. ": the pane is closed") end
    end
  end
  if timed then lib.heartbeat(state, server.instance_id, now) end
  save_state()
end

local function drop(block_id, why)
  local e = state.blocks[block_id]
  if e and e.instance_id ~= server.instance_id then
    state.blocks[block_id] = nil
    save_state()
  end
  log("restore: skip " .. block_id .. ": " .. why)
end

-- Type the resume line into a restored pane once it is a plain shell, started
-- by this server, waiting at its prompt with the same cursor line on two looks
-- a second apart. Gives up at the deadline and never types after it.
local function restore_one(block_id, entry, deadline)
  local line = lib.resume_line(entry)
  local instance = server.instance_id
  local last_line, unreadable
  local function poll()
    if restore_off() then return log("restore: " .. block_id .. " left alone: restore is off") end
    if not server or server.instance_id ~= instance then return end
    if os.time() > deadline then return drop(block_id, "its shell wasn't ready in time") end
    local function again() rex.after(1, poll) end
    local blocks = terminals()
    local session_id = blocks and blocks[block_id]
    if not session_id then return again() end
    local process = block_call(session_id, block_id, "process")
    local fg = type(process) == "table" and process.foreground
    if not lib.plain_shell(process) then last_line = nil return again() end
    if not lib.restore_shell(fg.name) then return drop(block_id, "its shell " .. tostring(fg.name) .. " isn't one a restore types into") end
    local r = rex.exec({ "ps", "-o", "etime=", "-p", tostring(fg.pid) })
    local age = r and r.ok and lib.parse_etime(r.stdout)
    if not age then return again() end
    if os.time() - age < server.started_at - 2 then return drop(block_id, "its shell was running before the server started") end
    local mode = block_call(session_id, block_id, "input_mode")
    if not (mode and mode.canonical == false) then last_line = nil return again() end
    local screen = block_call(session_id, block_id, "format", { trim = true })
    local cursor = screen and lib.cursor_line(screen.content)
    if not cursor then
      if not unreadable then log("restore: can't read the cursor line of " .. block_id .. "; not typing") end
      unreadable, last_line = true, nil
      return again()
    end
    if cursor ~= last_line then last_line = cursor return again() end
    -- Ctrl-E Ctrl-U clears anything left on the line in an emacs keymap.
    local keymap = lib.keymap(fg.name, env_of(fg.pid, { EDITOR = true, VISUAL = true }))
    local clear = keymap == "emacs" and "\5\21" or ""
    if clear == "" then log("restore: " .. block_id .. " has a " .. keymap .. " keymap: the line isn't cleared first") end
    local ok = block_call(session_id, block_id, "write", { data = clear .. line .. "\r" }) ~= nil
    if lib.mark_restored(state, block_id, instance, ok) then
      save_state()
      return log("restore: typed " .. line .. " into " .. block_id)
    end
    log("restore: couldn't type into " .. block_id .. "; trying again")
    again()
  end
  poll()
end

-- Plan from agents.json as the last server left it, before anything is
-- written in this one, then type each resume line.
local function start_restore()
  state = load_state()
  if restore_off() then return log("restore is off") end
  local now = os.time()
  local plan = lib.plan_restore(state, { instance_id = server.instance_id, started_at = server.started_at, now = now })
  for _, d in ipairs(plan.drop) do
    state.blocks[d.block_id] = nil
    log("restore: skip " .. d.block_id .. ": " .. d.reason)
  end
  lib.heartbeat(state, server.instance_id, now)
  save_state()
  if #plan.restore == 0 then return end
  local deadline = server.started_at + lib.RESTORE_WINDOW
  for _, item in ipairs(plan.restore) do
    log("restore: resuming " .. item.entry.agent .. " session " .. item.entry.session_id .. " in " .. item.block_id)
    restore_one(item.block_id, item.entry, deadline)
  end
  -- Whatever wasn't typed by the deadline is dropped.
  local instance = server.instance_id
  rex.after(math.max(deadline - os.time(), 0) + 1, function()
    if not server or server.instance_id ~= instance then return end
    local dropped = false
    for block_id, e in pairs(state.blocks) do
      if e.instance_id ~= instance then state.blocks[block_id] = nil dropped = true end
    end
    if dropped then save_state() end
  end)
end

-- A debounced sweep for each change of a terminal's program: it records, and
-- never forgets.
local pending_sweep
local function sweep_soon()
  if pending_sweep then return end
  pending_sweep = true
  rex.after(1, function()
    pending_sweep = nil
    sweep(false)
  end)
end

rex.on("block_owner_changed", function(ctx, ev)
  if ev.reason ~= "create" or not ev.block_id or not ev.owner then return end
  -- Look the creator up now: a CLI client disconnects right after.
  local kind = client_kind(ev.owner) or "unknown"
  created[ev.block_id] = kind
  -- The pane is already in its window's layout when this arrives.
  on_block_created(ctx.session_id or ev.session_id, ev.block_id, kind)
end)

rex.on("window_created", on_window_created)

rex.on("active_window_changed", function(ctx, ev)
  local session_id = ctx.session_id or ev.session_id
  if session_id then active[session_id] = ev.window_id end
end)

rex.on("block_closed", function(_, ev)
  if ev.block_id then created[ev.block_id] = nil end
end)
rex.on("session_created", function(_, ev)
  local s = ev.session
  if s and s.session_id then seed(s.session_id) end
end)
rex.on("session_destroyed", function(_, ev) if ev.session_id then active[ev.session_id] = nil end end)
rex.on("terminal.process_changed", function() sweep_soon() end)

-- The timed sweep. A server that changed under a running watcher is a restart.
rex.every(lib.SWEEP, function()
  if restore_off() then return end
  local info = server_info()
  if info and server and info.instance_id ~= server.instance_id then
    server = info
    log("the server restarted")
    start_restore()
  end
  sweep(true)
end)

-- rex-sshtab.lua asks the watcher to stop by creating the off file.
rex.every(1, function()
  if exists(OFF) then
    log("stopped")
    rex.stop(0)
  end
end)

-- With --all, other sessions can be reached only once the top level has
-- finished, so the first pass runs from a timer.
rex.after(0, function()
  local list = call("session.list", {})
  for _, s in ipairs((list and list.sessions) or {}) do seed(s.session_id) end
  log("started")
  server = server_info()
  if not server then return log("can't read the server's instance: agent sessions aren't kept") end
  start_restore()
  sweep(false)
end)
