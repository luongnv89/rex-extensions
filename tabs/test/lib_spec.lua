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
local function pair(a, b) return tostring(a) .. "|" .. tostring(b) end

-- basename
eq(lib.basename("/Users/me/src/skills"), "skills", "basename")
eq(lib.basename("/Users/me/src/skills/"), "skills", "basename with a trailing slash")
eq(lib.basename("/"), "/", "basename of the root")
eq(lib.basename("~"), "~", "basename of ~")
eq(lib.basename("/Users/me", "/Users/me"), "~", "basename of home")
eq(lib.basename("~/workspace/skills"), "skills", "basename of a ~ path")
eq(lib.basename(""), nil, "basename of nothing")

-- short_host
eq(lib.short_host("devbox.example.com"), "devbox", "short_host drops the domain")
eq(lib.short_host("10.0.0.5"), "10.0.0.5", "short_host keeps an IP")
eq(lib.short_host("localhost"), nil, "short_host ignores localhost")
eq(lib.short_host(""), nil, "short_host of nothing")

-- parse_pwd
eq(pair(lib.parse_pwd("file://Laptop/Users/me/My%20Stuff")), "Laptop|/Users/me/My Stuff", "parse_pwd decodes")
eq(pair(lib.parse_pwd("file:///tmp")), "|/tmp", "parse_pwd without a host")
eq(lib.parse_pwd("http://x/y"), nil, "parse_pwd refuses other URLs")

-- parse_ssh_title
eq(pair(lib.parse_ssh_title("you@devbox:~/workspace/skills")), "devbox|~/workspace/skills", "ssh title")
eq(pair(lib.parse_ssh_title("me@box.lan: /srv/app")), "box|/srv/app", "ssh title with a domain and a space")
eq(lib.parse_ssh_title("vim: notes.txt"), nil, "a title without user@ is not a host")
eq(lib.parse_ssh_title(nil), nil, "no title")

-- locate: a local shell
local local_shell = {
  title = "Rex app sidebar tab details",
  pwd = { pwd = "file://Laptop/Users/me/rex-extensions", owner = { pid = 2 } },
  process = { foreground = { pid = 3, name = "claude", cwd = "/Users/me/rex-extensions" }, home = "/Users/me" },
  local_host = "Laptop",
}
eq(pair(lib.locate(local_shell)), "Laptop|rex-extensions", "locate a local program")

-- locate: the foreground program's folder wins over a stale pwd
local moved = {
  pwd = { pwd = "file://Laptop/Users/me", owner = { pid = 2 } },
  process = { foreground = { pid = 3, name = "node", cwd = "/Users/me/mcc" } },
  local_host = "Laptop",
}
eq(pair(lib.locate(moved)), "Laptop|mcc", "locate uses the program's folder")

-- locate: ssh, the remote shell reports no folder, its title has it
local ssh_title = {
  title = "you@devbox:~/workspace/skills",
  pwd = { pwd = "file://Laptop/Users/me", owner = { pid = 2 } },
  process = { foreground = { pid = 9, name = "ssh", cwd = "/Users/me" } },
  local_host = "Laptop",
}
eq(pair(lib.locate(ssh_title)), "devbox|skills", "locate over ssh from the title")

-- locate: ssh, the remote shell reports its folder through ssh
local ssh_pwd = {
  title = "whatever",
  pwd = { pwd = "file://devbox.internal/home/admin/api", owner = { pid = 9 } },
  process = { foreground = { pid = 9, name = "ssh", cwd = "/Users/me" } },
  local_host = "Laptop",
}
eq(pair(lib.locate(ssh_pwd)), "devbox|api", "locate over ssh from the remote pwd")

-- locate: ssh with nothing to go on
eq(pair(lib.locate({ title = "vim", process = { foreground = { pid = 9, name = "ssh" } }, local_host = "Laptop" })), "nil|nil", "locate over ssh without clues")

-- window labels
eq(lib.is_default_window_label("Window 8bff1484"), true, "default window label")
eq(lib.is_default_window_label("Window"), false, "a tab named Window")
eq(lib.is_default_window_label("deploy"), false, "a named tab")

-- tab_label and tab_name
eq(lib.tab_label("claude", "skills"), "skills · claude", "tab_label")
eq(lib.tab_label("", "skills"), "skills", "tab_label without a name")
eq(lib.tab_label("claude", nil), "claude", "tab_label without a folder")
eq(lib.tab_label("Chiselturn", "chiselturn"), "Chiselturn", "tab_label named after its folder")
eq(#lib.tab_label(string.rep("x", 200), "skills") <= lib.MAX, true, "tab_label fits in 128")
eq(lib.tab_label(string.rep("x", 200), "skills"):sub(1, #"skills · "), "skills · ", "tab_label keeps the folder when cut")
eq(lib.tab_name("skills · claude", "skills"), "claude", "tab_name")
eq(lib.tab_name("skills · claude", "api"), nil, "tab_name with another folder")
eq(lib.tab_name("skills · ", "skills"), nil, "tab_name needs a name")

-- machine_list
eq(table.concat(lib.machine_list({ "Laptop", "devbox", "Laptop", nil }), ","), "devbox,Laptop", "machine_list")

-- session_label and session_name
eq(lib.session_label("rex-sidebar", { "Laptop" }), "Laptop:rex-sidebar", "session_label")
eq(lib.session_label("work", { "Laptop", "devbox" }), "Laptop,devbox:work", "session_label with two machines")
eq(lib.session_label("devbox", { "devbox" }), "devbox", "a session named after its machine")
eq(lib.session_label("work", {}), "work", "session_label without machines")
local known = { Laptop = true, ["devbox"] = true }
eq(lib.session_name("Laptop:rex-sidebar", known), "rex-sidebar", "session_name")
eq(lib.session_name("Laptop,devbox:work", known), "work", "session_name with two machines")
eq(lib.session_name("fix:login", known), "fix:login", "session_name keeps a colon of its own")
eq(lib.session_name("work", known), "work", "session_name without machines")

if failures > 0 then
  io.stderr:write(string.format("%d of %d checks failed\n", failures, count))
  os.exit(1)
end
print(string.format("%d checks passed", count))
