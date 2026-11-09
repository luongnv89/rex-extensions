-- rex-sshtab: a new tab on the same machine. In a pane running ssh, the
-- action opens a tab that runs the same ssh command (same options and
-- destination, without a remote command or port forwards). Anywhere else it
-- opens an ordinary new tab.
--
-- Load it from init.lua and bind it to the new-tab key:
--
--   dofile("/path/to/rex-extensions/sshtab/rex-sshtab.lua")
--   rex.bind("cmd+t", "same_host_tab")

local here = debug.getinfo(1, "S").source:gsub("^@", ""):match("^(.*)/[^/]*$") or "."
local lib = dofile(here .. "/lib.lua")

local TERMINAL = "com.superlogical.terminal"
local SHELL = "com.superlogical.terminal.shell"

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

-- The pane the action was run from: ctx.block_id, else the focused pane of
-- the session's active tab.
local function focused_block(session_id, block_id)
  if block_id then return block_id end
  local view = rex.session.view({ session_id = session_id })
  if not view then return nil end
  for _, window in ipairs(view.windows or {}) do
    if window.window_id == view.active_window_id then return window.focused_block_id end
  end
  return nil
end

-- The ssh command running in a pane, or nil.
local function ssh_in(session_id, block_id)
  if not block_id then return nil end
  local ok, process = pcall(rex.block.call, TERMINAL, "process", { session_id = session_id, block_id = block_id })
  if not ok or type(process) ~= "table" then return nil end
  return lib.from_process(process, argv_of)
end

local function new_tab(ctx)
  local session_id = ctx.session_id
  local cmd, dest, cwd = ssh_in(session_id, focused_block(session_id, ctx.block_id))
  if cmd then
    local result, err = rex.session.new_window({
      session_id = session_id,
      layout = { block = { flavor = SHELL, options = { command = cmd, cwd = cwd } } },
    })
    if not result then error("rex-sshtab: can't open a tab on " .. dest .. ": " .. tostring(err)) end
    return { host = dest, command = cmd, window_id = result.window_id }
  end
  -- Not in ssh: the app's own new tab, so local tabs open as they always do.
  -- Without a client to ask (rex do from a script), open a shell tab.
  if pcall(rex.client.queue, "client.tab.new") then return { host = nil } end
  local result, err = rex.session.new_window({
    session_id = session_id,
    layout = { block = { flavor = SHELL } },
  })
  if not result then error("rex-sshtab: can't open a tab: " .. tostring(err)) end
  return { host = nil, window_id = result.window_id }
end

rex.action({
  name = "same_host_tab",
  title = "New Tab on Same Machine",
  description = "Open a new tab. In a pane running ssh, the tab connects to the same machine.",
  category = "Tabs",
  keywords = "new tab ssh remote host machine server same connect duplicate",
  run = new_tab,
})
