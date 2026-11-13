-- Tests for rex-github.lua's toggle(), run by rex_github.test.js with a plain Lua 5.1.
--
--   lua rex_github_spec.lua MODULE
--     runs the checks against MODULE, loaded as if it sat at made-up paths.
--   lua rex_github_spec.lua MODULE dump AS HOME CWD
--     loads MODULE as if it sat at AS, runs toggle() with $HOME = HOME and the
--     focused pane in CWD ("" for a pane whose folder can't be read), and prints
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

-- A stub of Rex: one tab holding the focused block "blk-1", in CWD when it's set.
local CWD, run, split
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
    elseif method == "block.method" and params.method == "process" then
      if not CWD then error("no process") end
      return { foreground = { cwd = CWD } }
    elseif method == "block.method" and params.method == "size" then
      return { columns = 108 }
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

-- The new pane's command and cwd when $HOME is `home` and the focused pane is in `cwd`.
local function open(home, cwd)
  HOME, CWD, split = home, cwd, nil
  run({ session_id = "s-1", block_id = "blk-1" })
  local options = split.layout.block.options
  return options.command, options.cwd
end

if arg[2] == "dump" then
  load_as(arg[3])
  local command, cwd = open(arg[4], arg[5] ~= "" and arg[5] or nil)
  for _, v in ipairs(command) do print("command\t" .. v) end
  print("cwd\t" .. tostring(cwd))
  os.exit(0)
end

local SCRIPT = 'p=$1; shift; exec node "$HOME$p" "$@"'
-- The command for a panel.js at `rel` under $HOME: sh resolves it on the pane's machine.
local function under_home(rel, ...)
  return list({ "sh", "-c", SCRIPT, "rex-github", rel, "--target", "blk-1", ... })
end

-- Under $HOME: panel.js is found under the $HOME of the pane's machine (#12).
load_as("/home/me/.config/rex/rex-extensions/github/rex-github.lua")
local command, cwd = open("/home/me", "/home/me/src/app")
eq(list(command), under_home("/.config/rex/rex-extensions/github/panel.js", "--cwd", "/home/me/src/app"), "command under $HOME")
eq(cwd, "/home/me/src/app", "the pane starts in the focused pane's folder")
eq(command[3]:find("/home/me", 1, true), nil, "the script holds no path of this machine")

-- The focused pane's folder can't be read: no --cwd, and no folder of this machine.
command, cwd = open("/home/me", nil)
eq(list(command), under_home("/.config/rex/rex-extensions/github/panel.js"), "command without a folder")
eq(cwd, "", "the pane starts in its machine's default folder")

-- $HOME is read when the action runs, not when the module loads.
command = open("/home", "/srv")
eq(list(command), under_home("/me/.config/rex/rex-extensions/github/panel.js", "--cwd", "/srv"), "$HOME read at run time")

-- A trailing slash on $HOME changes nothing.
command = open("/home/me/", "/srv")
eq(list(command), under_home("/.config/rex/rex-extensions/github/panel.js", "--cwd", "/srv"), "$HOME with a trailing slash")

-- Not under $HOME, or no $HOME: the absolute path, as before.
local ABSOLUTE = "/home/me/.config/rex/rex-extensions/github/panel.js"
command = open("/home/you", "/srv")
eq(list(command), list({ "node", ABSOLUTE, "--target", "blk-1", "--cwd", "/srv" }), "not under $HOME")
command = open("/home/m", "/srv")
eq(list(command), list({ "node", ABSOLUTE, "--target", "blk-1", "--cwd", "/srv" }), "a $HOME that is only a prefix of a folder name")
command = open(nil, "/srv")
eq(list(command), list({ "node", ABSOLUTE, "--target", "blk-1", "--cwd", "/srv" }), "no $HOME")
command = open("", "/srv")
eq(list(command), list({ "node", ABSOLUTE, "--target", "blk-1", "--cwd", "/srv" }), "an empty $HOME")
command = open("/", "/srv")
eq(list(command), list({ "node", ABSOLUTE, "--target", "blk-1", "--cwd", "/srv" }), "$HOME is /")

-- A $HOME with Lua pattern characters is compared as plain text.
load_as("/tmp/jean-luc.x/ext/github/rex-github.lua")
command = open("/tmp/jean-luc.x", "/srv")
eq(list(command), under_home("/ext/github/panel.js", "--cwd", "/srv"), "a $HOME with - and .")
load_as("/tmp/aXb/ext/github/rex-github.lua")
command = open("/tmp/a.b", "/srv")
eq(command[1], "node", "a . in $HOME matches only a .")

-- Quotes, $ and spaces in the path stay out of the script.
load_as('/home/me/my "ext" $HOME `x` dir/github/rex-github.lua')
command = open("/home/me", "/srv")
eq(list(command), under_home('/my "ext" $HOME `x` dir/github/panel.js', "--cwd", "/srv"), "a path with quotes, $ and spaces")
eq(command[3], SCRIPT, "the script is the same for every path")

-- The real module, loaded from where it is.
dofile(MODULE)
local folder = MODULE:match("^(.*)/[^/]*$")
local parent, name = folder:match("^(.*)(/[^/]*)$")
command = open(parent, "/srv")
eq(list(command), under_home(name .. "/panel.js", "--cwd", "/srv"), "the real module")

if failures > 0 then
  io.stderr:write(string.format("%d of %d checks failed\n", failures, count))
  os.exit(1)
end
print(string.format("%d checks passed", count))
