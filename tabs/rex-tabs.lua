-- rex-tabs: the machine in each session's name and the folder in each tab's
-- name, so the sidebar reads
--
--   aws-dev:deploy
--     skills · claude
--     api · adminuser@aws-dev:~/workspace/api
--
-- Load it from init.lua, then bind a key to its action:
--
--   dofile("/path/to/rex-extensions/tabs/rex-tabs.lua")
--   rex.bind("cmd+shift+l", "tab_locations")
--
-- Loading the file starts watcher.lua in the background, unless it is already
-- running or was turned off. The action turns it off, which puts every label
-- back, or on again. Off is remembered across restarts in ~/.cache/rex-tabs/off.

local here = debug.getinfo(1, "S").source:gsub("^@", ""):match("^(.*)/[^/]*$") or "."
local WATCHER = here .. "/watcher.lua"
local STATE = (os.getenv("HOME") or "") .. "/.cache/rex-tabs"
local PIDFILE = STATE .. "/watcher.pid"
local OFF = STATE .. "/off"

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

local function start(mode)
  local argv = { rex_bin(), "do", WATCHER, "--all", "state=" .. STATE }
  if mode then argv[#argv + 1] = "mode=" .. mode end
  local h, err = rex.exec.start(argv, { detach = true, cwd = here, stdout = false, stderr = false })
  if not h then return nil, err end
  if not mode then write(PIDFILE, tostring(h.pid)) end
  return h
end

local function toggle()
  if running() then
    write(OFF, "")
    return { on = false }
  end
  if read(OFF) then
    os.remove(OFF)
    local _, err = start()
    if err then error("rex-tabs: can't start the watcher: " .. tostring(err)) end
    return { on = true }
  end
  -- Neither running nor turned off: the watcher died. Start it.
  local _, err = start()
  if err then error("rex-tabs: can't start the watcher: " .. tostring(err)) end
  return { on = true }
end

rex.action({
  name = "tab_locations",
  title = "Tab Locations",
  description = "Show or hide the machine in session names and the folder in tab names.",
  category = "Tabs",
  keywords = "tab session sidebar machine host folder directory cwd name label",
  run = toggle,
})

-- At load, start the watcher unless it runs already or was turned off. A
-- script (install.js reads this file with rex do) has rex.args and skips it.
if rex.args == nil and not read(OFF) and not running() then
  local _, err = start()
  if err then rex.log("warn", "rex-tabs: can't start the watcher: " .. tostring(err)) end
end
