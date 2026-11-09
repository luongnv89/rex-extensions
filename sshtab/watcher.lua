-- rex-sshtab watcher: when you open a new tab from a tab that's ssh'd into a
-- machine, types the same ssh command into the new tab. rex-sshtab.lua starts
-- it with
--
--   rex do watcher.lua --all state=DIR
--
-- and stops it by creating DIR/off.
--
-- It acts only on a tab that Rex.app itself made (the + button, New Tab in
-- the menu or the command palette, cmd+t): a new window holding one new shell
-- block whose creator is a client of kind "app". Tabs that scripts and agents
-- open (rex window new, rex run, rex do) come from other clients and are left
-- alone. It decides nothing it can't check, and logs each decision to DIR/log.

local here = debug.getinfo(1, "S").source:gsub("^@", ""):match("^(.*)/[^/]*$") or "."
local lib = dofile(here .. "/lib.lua")

local TERMINAL = "com.superlogical.terminal"
local STATE = rex.args.state or ((os.getenv("HOME") or "") .. "/.cache/rex-sshtab")
local OFF = STATE .. "/off"
local LOG = STATE .. "/log"
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

-- Type `line` into the new tab once its shell waits at its prompt. A shell's
-- line editor (zsh's, bash's readline, fish's) takes the terminal out of
-- canonical mode while it reads, so that's the sign. A shell without one
-- stays canonical: after PROMPT_WAIT with the shell running, type anyway.
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
    if not process then return log("skip " .. block_id .. ": the new tab is gone") end
    local fg = process.foreground
    if fg and lib.is_shell(fg.name) then
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

rex.on("block_owner_changed", function(_, ev)
  if ev.reason ~= "create" or not ev.block_id or not ev.owner then return end
  -- Look the creator up now: a CLI client disconnects right after.
  created[ev.block_id] = client_kind(ev.owner) or "unknown"
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
end)
