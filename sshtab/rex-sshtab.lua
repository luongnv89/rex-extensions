-- rex-sshtab: new tabs open on the machine the current tab is ssh'd into.
-- Open a tab from a tab running ssh, with the + button, New Tab in the menu or
-- the command palette, or cmd+t, and the new tab connects to the same machine
-- with the same ssh command. Tabs that scripts and agents open are left alone.
--
-- Load it from init.lua, then bind a key to its on/off action:
--
--   dofile("/path/to/rex-extensions/sshtab/rex-sshtab.lua")
--   rex.bind("cmd+alt+t", "same_host_tabs")
--
-- Loading the file starts watcher.lua in the background, unless it is already
-- running or was turned off. The action turns it off, or on again. Off is
-- remembered across restarts in ~/.cache/rex-sshtab/off.
--
-- The watcher also resumes the AI coding agent sessions (Claude Code, Codex
-- and others) that were running in each pane when the Rex server restarts.
-- The restore_agent_sessions action turns that alone off, or on again; off is
-- remembered in ~/.cache/rex-sshtab/restore-off. REX_SSHTAB_STATE moves the
-- folder, as it does for install.js.

local here = debug.getinfo(1, "S").source:gsub("^@", ""):match("^(.*)/[^/]*$") or "."
local WATCHER = here .. "/watcher.lua"
local STATE = os.getenv("REX_SSHTAB_STATE") or ((os.getenv("HOME") or "") .. "/.cache/rex-sshtab")
local PIDFILE = STATE .. "/watcher.pid"
local OFF = STATE .. "/off"
local RESTORE_OFF = STATE .. "/restore-off"
local AGENTS_FILE = STATE .. "/agents.json"

local function read(path)
  local f = io.open(path, "r")
  if not f then return nil end
  local text = f:read("*a")
  f:close()
  return text
end

local function write(path, text)
  rex.exec({ "mkdir", "-p", STATE })
  local f = io.open(path, "w")
  if not f then return false end
  f:write(text)
  f:close()
  return true
end

-- The `rex` on PATH, else the one inside the Rex app on macOS: the server may
-- load this file with a PATH that doesn't have it.
local APP_REX = (os.getenv("HOME") or "")
  .. "/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex"
local function rex_bin()
  local r = rex.exec({ "sh", "-c", "command -v rex" })
  local path = r and r.ok and r.stdout:gsub("%s+$", "") or ""
  if path ~= "" then return path end
  if read(APP_REX) then return APP_REX end
  return "rex"
end

-- Whether the watcher in the pid file is still running. The command line is
-- checked too, so a reused pid doesn't count.
local function running()
  local pid = tonumber(read(PIDFILE) or "")
  if not pid then return false end
  local r = rex.exec({ "ps", "-p", tostring(pid), "-o", "command=" })
  return r and r.ok and r.stdout:find(WATCHER, 1, true) ~= nil
end

local function start()
  rex.exec({ "mkdir", "-p", STATE })
  local h, err = rex.exec.start(
    { rex_bin(), "do", WATCHER, "--all", "state=" .. STATE },
    { detach = true, cwd = here, stdout = false, stderr = false }
  )
  if not h then return nil, err end
  write(PIDFILE, tostring(h.pid))
  return h
end

local function toggle()
  if running() then
    write(OFF, "")
    return { on = false }
  end
  os.remove(OFF)
  local _, err = start()
  if err then error("rex-sshtab: can't start the watcher: " .. tostring(err)) end
  return { on = true }
end

-- Restore off also forgets the sessions recorded so far.
local function toggle_restore()
  if read(RESTORE_OFF) then
    os.remove(RESTORE_OFF)
    return { on = true, watcher = running() }
  end
  write(RESTORE_OFF, "")
  os.remove(AGENTS_FILE)
  return { on = false }
end

rex.action({
  name = "same_host_tabs",
  title = "Same-Machine Tabs",
  description = "Turn on or off: a new tab opened from a tab running ssh connects to the same machine.",
  category = "Tabs",
  keywords = "new tab ssh remote host machine server same connect follow",
  run = toggle,
})

rex.action({
  name = "restore_agent_sessions",
  title = "Restore Agent Sessions",
  description = "Turn on or off: after the Rex server restarts, resume the Claude Code, Codex and other agent sessions each pane was running.",
  category = "Tabs",
  keywords = "restore resume agent session claude codex opencode cursor restart reboot",
  run = toggle_restore,
})

-- At load, start the watcher unless it runs already or was turned off. A
-- script (install.js reads this file with rex do) has rex.args and skips it.
if rex.args == nil and not read(OFF) and not running() then
  local _, err = start()
  if err then rex.log("warn", "rex-sshtab: can't start the watcher: " .. tostring(err)) end
end
