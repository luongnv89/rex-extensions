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
local function join(t) return t and table.concat(t, " ") or nil end
local function words(s) return lib.split_words(s) end
local function cmd(s) return join((lib.ssh_command(words(s)))) end

-- split_nul / split_words
eq(join(lib.split_nul("ssh\0-o\0ProxyCommand nc %h 22\0box\0")), "ssh -o ProxyCommand nc %h 22 box", "split_nul keeps spaces")
eq(#lib.split_nul("ssh\0-o\0ProxyCommand nc %h 22\0box\0"), 4, "split_nul word count")
eq(#lib.split_nul("ssh\0\0box\0"), 3, "split_nul keeps an empty argument")
eq(lib.split_nul(""), nil, "split_nul of nothing")
eq(join(lib.split_words("  ssh  -p 2222 box\n")), "ssh -p 2222 box", "split_words")
eq(lib.split_words("   "), nil, "split_words of blanks")

-- program
eq(lib.program("/usr/bin/ssh"), "ssh", "program of a path")
eq(lib.program("ssh"), "ssh", "program of a name")

-- ssh_command
eq(cmd("ssh box"), "ssh box", "plain")
eq(cmd("ssh user@box.example.com"), "ssh user@box.example.com", "user@host")
eq(cmd("ssh -p 2222 -i ~/.ssh/id box"), "ssh -p 2222 -i ~/.ssh/id box", "options with arguments")
eq(cmd("ssh -p2222 box"), "ssh -p 2222 box", "attached argument")
eq(cmd("ssh -At box"), "ssh -A -t box", "combined flags")
eq(cmd("ssh -Ap2222 box"), "ssh -A -p 2222 box", "flags then an attached argument")
eq(cmd("ssh box htop"), "ssh box", "drops the remote command")
eq(cmd("ssh -t box tmux attach -d"), "ssh -t box", "drops a command with options")
eq(cmd("ssh box -p 2222 ls -la"), "ssh -p 2222 box", "options after the destination, then a command")
eq(cmd("ssh -L 8080:localhost:80 -R9000:localhost:9000 -D 1080 box"), "ssh box", "drops forwards")
eq(cmd("ssh -fN -L 8080:x:80 box"), "ssh box", "drops -f and -N")
eq(cmd("ssh -tNv box"), "ssh -t -v box", "drops -N from a group")
eq(cmd("ssh -T box"), "ssh box", "drops -T")
eq(cmd("ssh -n box ls"), "ssh box", "drops -n")
eq(cmd("ssh -o StrictHostKeyChecking=no -J jump box"), "ssh -o StrictHostKeyChecking=no -J jump box", "keeps -o and -J")
eq(cmd("ssh -l admin box"), "ssh -l admin box", "keeps -l")
eq(cmd("ssh -- box uptime"), "ssh box", "destination after --")
eq(cmd("ssh ssh://admin@box:2222"), "ssh ssh://admin@box:2222", "ssh:// destination")
eq(cmd("/usr/bin/ssh box"), "/usr/bin/ssh box", "keeps the program path")
eq(cmd("ssh -v"), nil, "no destination")
eq(cmd("ssh -p"), nil, "missing argument")
eq(lib.ssh_command(nil), nil, "nil argv")
local _, dest = lib.ssh_command(words("ssh -p 2222 admin@box uptime"))
eq(dest, "admin@box", "returns the destination")

-- is_shell
eq(lib.is_shell("zsh"), true, "is_shell zsh")
eq(lib.is_shell("-zsh"), true, "is_shell a login zsh")
eq(lib.is_shell("/opt/homebrew/bin/fish"), true, "is_shell a path")
eq(lib.is_shell("ssh"), false, "is_shell ssh")
eq(lib.is_shell("login"), false, "is_shell login")
eq(lib.is_shell(nil), false, "is_shell nil")

-- quote / command_line
eq(lib.quote("box"), "box", "quote a plain word")
eq(lib.quote("admin@box.example.com:2222"), "admin@box.example.com:2222", "quote keeps @ . : as they are")
eq(lib.quote("ProxyCommand nc %h %p"), "'ProxyCommand nc %h %p'", "quote a word with spaces")
eq(lib.quote("it's"), [['it'\''s']], "quote a single quote")
eq(lib.quote("~/.ssh/id"), "'~/.ssh/id'", "quote a leading ~ so the remote path isn't expanded twice")
eq(lib.quote(""), "''", "quote nothing")
eq(lib.quote("$HOME;rm"), "'$HOME;rm'", "quote shell syntax")
eq(lib.command_line({ "ssh", "-p", "2222", "-o", "ProxyCommand nc %h %p", "box" }), "ssh -p 2222 -o 'ProxyCommand nc %h %p' box", "command_line")

-- from_process
local argvs = { [42] = words("ssh -t admin@box htop") }
local function argv_of(pid) return argvs[pid] end
local c, d, cwd = lib.from_process({ foreground = { pid = 42, name = "ssh", cwd = "/Users/me" } }, argv_of)
eq(join(c), "ssh -t admin@box", "from_process command")
eq(d, "admin@box", "from_process destination")
eq(cwd, "/Users/me", "from_process cwd")
eq(join((lib.from_process({ foreground = { pid = 42, name = "x", path = "/usr/bin/ssh" } }, argv_of))), "ssh -t admin@box", "from_process by path")
eq(lib.from_process({ foreground = { pid = 42, name = "zsh" } }, argv_of), nil, "from_process ignores other programs")
eq(lib.from_process({ foreground = { pid = 7, name = "ssh" } }, argv_of), nil, "from_process without argv")
eq(lib.from_process({}, argv_of), nil, "from_process without a foreground")
eq(lib.from_process(nil, argv_of), nil, "from_process of nil")

if failures > 0 then
  io.stderr:write(string.format("%d of %d checks failed\n", failures, count))
  os.exit(1)
end
print(string.format("%d checks passed", count))
