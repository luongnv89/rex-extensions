-- rex-tabs watcher: keeps every session's label as "<machines>:<name>" and
-- every tab's label as "<folder> · <name>". rex-tabs.lua starts it with
--
--   rex do watcher.lua --all state=DIR
--
-- and stops it by creating DIR/off: the watcher then puts the labels back as
-- they were and exits. `mode=restore` only puts the labels back.

local here = debug.getinfo(1, "S").source:gsub("^@", ""):match("^(.*)/[^/]*$") or "."
local lib = dofile(here .. "/lib.lua")

local TERMINAL = "com.superlogical.terminal"
local STATE = rex.args.state or ((os.getenv("HOME") or "") .. "/.cache/rex-tabs")
local OFF = STATE .. "/off"
local DEBOUNCE = 0.3

local function exists(path)
  local f = io.open(path, "r")
  if f then f:close() return true end
  return false
end

local LOCAL_HOST = (function()
  local r = rex.exec({ "hostname", "-s" })
  local name = r and r.ok and r.stdout:gsub("%s+$", "") or ""
  return name ~= "" and name or nil
end)()

-- What the watcher set and what people named things themselves, by ID.
local tabs = {}      -- window_id -> { set = label, name = manual name or nil }
local sessions = {}  -- session_id -> { set = label, name = name }

local function call(method, args)
  local result, err = rex.call(method, args)
  if not result and err then rex.log("debug", "rex-tabs: " .. method .. ": " .. tostring(err)) end
  return result
end

local function block_call(session_id, block_id, method)
  local ok, result = pcall(rex.block.call, TERMINAL, method, { session_id = session_id, block_id = block_id })
  if ok then return result end
  return nil
end

-- The block a tab shows: the one it last focused, else its first terminal.
local function focused_terminal(window)
  local first
  for _, layer in ipairs(window.layers or {}) do
    for _, block in ipairs(layer.blocks or {}) do
      if block.creator_name == TERMINAL then
        if block.block_id == window.focused_block_id then return block end
        first = first or block
      end
    end
  end
  return first
end

-- Title, machine and folder of a tab's terminal.
local function inspect(session_id, window)
  local block = focused_terminal(window)
  if not block then return nil end
  local title = block_call(session_id, block.block_id, "title") or {}
  local info = {
    title = title.title,
    pwd = block_call(session_id, block.block_id, "pwd"),
    process = block_call(session_id, block.block_id, "process"),
    local_host = LOCAL_HOST,
  }
  local machine, folder = lib.locate(info)
  local fg = info.process and info.process.foreground
  return { title = title.title, program = fg and fg.name, machine = machine, folder = folder }
end

local function known_machines(list)
  local known = {}
  for _, m in ipairs(list) do known[m] = true end
  if LOCAL_HOST then known[LOCAL_HOST] = true end
  return known
end

local function set_window_label(session_id, window_id, label)
  local tab = tabs[window_id] or {}
  tabs[window_id] = tab
  tab.set = label
  call("session.set_window_label", { session_id = session_id, window_id = window_id, label = label })
end

local function update_tab(session_id, window, where)
  local tab = tabs[window.window_id]
  if not tab then
    tab = {}
    tabs[window.window_id] = tab
    -- Seen for the first time: a label that isn't Rex's default and isn't one
    -- this watcher made (before a restart) is a name someone gave the tab.
    local label = window.label
    if not lib.is_default_window_label(label) and not (where and lib.tab_name(label, where.folder)) then
      tab.name = label
    end
  end
  if not where then return end
  local name = tab.name or where.title
  if not name or name == "" then name = where.program or "" end
  local label = lib.tab_label(name, where.folder)
  if label ~= "" and label ~= window.label then set_window_label(session_id, window.window_id, label) end
end

local function update_session(session_id, label, machines)
  local s = sessions[session_id]
  if not s then
    s = { name = lib.session_name(label, known_machines(machines)) }
    sessions[session_id] = s
  end
  local want = lib.session_label(s.name, machines)
  if want ~= "" and want ~= label then
    s.set = want
    call("session.set_label", { session_id = session_id, label = want })
  end
end

local function refresh(session_id)
  if exists(OFF) then return end
  local view = call("session.view", { session_id = session_id })
  if not view then return end
  local found = {}
  for _, window in ipairs(view.windows or {}) do
    local where = inspect(session_id, window)
    if where and where.machine then found[#found + 1] = where.machine end
    update_tab(session_id, window, where)
  end
  update_session(session_id, view.label, lib.machine_list(found))
end

-- Put a session's labels back: tabs to what they were named (or Rex's default),
-- the session to its name.
local function restore(session_id)
  local view = call("session.view", { session_id = session_id })
  if not view then return end
  local found = {}
  for _, window in ipairs(view.windows or {}) do
    local where = inspect(session_id, window)
    if where and where.machine then found[#found + 1] = where.machine end
    local tab = tabs[window.window_id]
    local name
    if tab and tab.set == window.label then
      name = tab.name or ""
    elseif where then
      name = lib.tab_name(window.label, where.folder)
      if name and (name == where.title or name == where.program) then name = "" end
    end
    if name and name ~= window.label then
      call("session.set_window_label", { session_id = session_id, window_id = window.window_id, label = name })
    end
  end
  local s = sessions[session_id]
  local name = (s and s.set == view.label and s.name) or lib.session_name(view.label, known_machines(lib.machine_list(found)))
  if name ~= "" and name ~= view.label then call("session.set_label", { session_id = session_id, label = name }) end
end

local function each_session(fn)
  local list = call("session.list", {})
  for _, s in ipairs((list and list.sessions) or {}) do fn(s.session_id) end
end

-- With --all, other sessions can be reached only once the top level has
-- finished, so the first pass runs from a timer.
if rex.args.mode == "restore" then
  -- Without a handler, --all doesn't attach the script to the other sessions.
  rex.on("session_created", function() end)
  rex.after(0, function()
    each_session(restore)
    rex.stop(0)
  end)
  return
end

-- Changes come in bursts, so a session is refreshed once, shortly after the
-- first one; later ones ride along. (Waiting for a quiet moment instead would
-- never refresh a tab whose title keeps changing, as an agent's does.)
local pending = {}
local function soon(session_id)
  if not session_id or pending[session_id] then return end
  pending[session_id] = rex.after(DEBOUNCE, function()
    pending[session_id] = nil
    refresh(session_id)
  end)
end

local function on_change(ctx, ev) soon(ctx.session_id or ev.session_id) end
for _, event in ipairs({
  "session_view_changed",
  "session_created",
  "terminal.title_changed",
  "terminal.pwd_changed",
  "terminal.process_changed",
}) do rex.on(event, on_change) end

-- A tab or session renamed by someone else keeps that name, with the folder
-- or machines added again.
rex.on("window_label_changed", function(ctx, ev)
  local tab = tabs[ev.window_id]
  if not tab or ev.label == tab.set then return end
  tab.name = (not lib.is_default_window_label(ev.label)) and ev.label or nil
  soon(ctx.session_id)
end)

rex.on("session_label_changed", function(ctx, ev)
  local s = sessions[ctx.session_id]
  if s and ev.label == s.set then return end
  sessions[ctx.session_id] = nil
  soon(ctx.session_id)
end)

rex.on("window_closed", function(_, ev) tabs[ev.window_id] = nil end)
rex.on("session_destroyed", function(_, ev) sessions[ev.session_id] = nil end)

-- rex-tabs.lua asks the watcher to stop by creating the off file.
rex.every(1, function()
  if exists(OFF) then
    each_session(restore)
    rex.stop(0)
  end
end)

rex.after(0, function() each_session(refresh) end)
