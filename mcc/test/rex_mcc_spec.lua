-- Tests for rex-mcc.lua's toggle(), run by rex_mcc.test.js with a plain Lua 5.1.
--
--   lua rex_mcc_spec.lua MODULE
--     runs the checks against MODULE, loaded as if it sat at made-up paths.
--   lua rex_mcc_spec.lua MODULE dump AS HOME
--     loads MODULE as if it sat at AS, runs toggle() with $HOME = HOME and prints
--     the new pane's command, one "command\t<arg>" line each, then "cwd\t<cwd>".
local MODULE = arg[1]
local load_string = loadstring or load
local failures, count = 0, 0

local function show(v) return type(v) == "string" and string.format("%q", v) or tostring(v) end
local function eq(got, want, what)
  count = count + 1
  if got ~= want then
    failures = failures + 1
    io.stderr:write(string.format("FAIL %s: got %s, want %s\n", what, show(got), show(want)))
  end
end
local function list(t)
  local out = {}
  for i, v in ipairs(t or {}) do out[i] = show(v) end
  return "{ " .. table.concat(out, ", ") .. " }"
end

-- $HOME as the module reads it: os.getenv("HOME") is stubbed, the rest is real.
local HOME
local getenv = os.getenv
os.getenv = function(name)
  if name == "HOME" then return HOME end
  return getenv(name)
end

-- A stub of Rex: one tab holding the focused block "blk-1".
local run, split
rex = {
  bind = function() end,
  action = function(spec) run = spec.run end,
  call = function(method, params)
    if method == "session.view" then
      return { windows = { { layers = { {
        kind = "tiled",
        layout = { block_id = "blk-1", rect = { 0, 0, 1, 1 } },
        blocks = { { block_id = "blk-1", label = "" } },
      } } } } }
    elseif method == "session.new_split" then
      split = params
      return { block_ids = { "blk-2" } }
    end
    error("unexpected rex.call " .. method)
  end,
}

local handle = assert(io.open(MODULE))
local SOURCE = handle:read("*a")
handle:close()

-- Loads the module as if it sat at `as`: its panel.js is then next to `as`.
local function load_as(as)
  assert(load_string(SOURCE, "@" .. as))()
end

-- The new pane's command and cwd when $HOME is `home`.
local function open(home)
  HOME, split = home, nil
  run({ session_id = "s-1", block_id = "blk-1" })
  local options = split.layout.block.options
  return options.command, options.cwd
end

if arg[2] == "dump" then
  load_as(arg[3])
  local command, cwd = open(arg[4])
  for _, v in ipairs(command) do print("command\t" .. v) end
  print("cwd\t" .. tostring(cwd))
  os.exit(0)
end

local SCRIPT = 'p=$1; shift; exec node "$HOME$p" "$@"'
-- The command for a panel.js at `rel` under $HOME: sh resolves it on the pane's machine.
local function under_home(rel)
  return list({ "sh", "-c", SCRIPT, "rex-mcc", rel })
end

-- Under $HOME: panel.js is found under the $HOME of the pane's machine (#12).
load_as("/home/me/.config/rex/rex-extensions/mcc/rex-mcc.lua")
local command, cwd = open("/home/me")
eq(list(command), under_home("/.config/rex/rex-extensions/mcc/panel.js"), "command under $HOME")
eq(cwd, "", "the pane starts in its machine's default folder")
eq(command[3]:find("/home/me", 1, true), nil, "the script holds no path of this machine")

-- $HOME is read when the action runs, not when the module loads.
command = open("/home")
eq(list(command), under_home("/me/.config/rex/rex-extensions/mcc/panel.js"), "$HOME read at run time")

-- A trailing slash on $HOME changes nothing.
command = open("/home/me/")
eq(list(command), under_home("/.config/rex/rex-extensions/mcc/panel.js"), "$HOME with a trailing slash")

-- Not under $HOME, or no $HOME: the absolute path, as before.
local ABSOLUTE = "/home/me/.config/rex/rex-extensions/mcc/panel.js"
command, cwd = open("/home/you")
eq(list(command), list({ "node", ABSOLUTE }), "not under $HOME")
eq(cwd, "", "the pane starts in its machine's default folder when not under $HOME")
command = open("/home/m")
eq(list(command), list({ "node", ABSOLUTE }), "a $HOME that is only a prefix of a folder name")
command = open(nil)
eq(list(command), list({ "node", ABSOLUTE }), "no $HOME")
command = open("")
eq(list(command), list({ "node", ABSOLUTE }), "an empty $HOME")
command = open("/")
eq(list(command), list({ "node", ABSOLUTE }), "$HOME is /")

-- A $HOME with Lua pattern characters is compared as plain text.
load_as("/tmp/jean-luc.x/ext/mcc/rex-mcc.lua")
command = open("/tmp/jean-luc.x")
eq(list(command), under_home("/ext/mcc/panel.js"), "a $HOME with - and .")
load_as("/tmp/aXb/ext/mcc/rex-mcc.lua")
command = open("/tmp/a.b")
eq(command[1], "node", "a . in $HOME matches only a .")

-- Quotes, $ and spaces in the path stay out of the script.
load_as('/home/me/my "ext" $HOME `x` dir/mcc/rex-mcc.lua')
command = open("/home/me")
eq(list(command), under_home('/my "ext" $HOME `x` dir/mcc/panel.js'), "a path with quotes, $ and spaces")
eq(command[3], SCRIPT, "the script is the same for every path")

-- The real module, loaded from where it is.
dofile(MODULE)
local folder = MODULE:match("^(.*)/[^/]*$")
local parent, name = folder:match("^(.*)(/[^/]*)$")
command = open(parent)
eq(list(command), under_home(name .. "/panel.js"), "the real module")

if failures > 0 then
  io.stderr:write(string.format("%d of %d checks failed\n", failures, count))
  os.exit(1)
end
print(string.format("%d checks passed", count))
