-- rex-sshtab: the pure part. Reads an ssh command line and builds the one a
-- new tab runs to reach the same machine. No rex calls here, so the tests run
-- it with a plain Lua 5.1.

local M = {}

-- ssh's options that take an argument (OpenSSH's getopt string).
local TAKES_ARG = {}
for c in ("BbcDEeFIiJLlmOoPpQRSWw"):gmatch(".") do TAKES_ARG[c] = true end

-- Options the new tab leaves out:
--   -f -N -s         background, no shell, subsystem: they don't give a shell
--   -T -n            no pty, stdin from /dev/null: they break an interactive shell
--   -L -R -D -W      forwards: the first ssh holds those ports already
--   -O -M            control commands and master mode
--   -G -V            print the config or the version and exit
local DROP = {}
for c in ("fNsTnLRDWOMGV"):gmatch(".") do DROP[c] = true end

-- Programs this extension follows into a new tab.
M.PROGRAMS = { ssh = true }

-- argv from /proc/PID/cmdline: NUL-separated, exact.
function M.split_nul(text)
  if type(text) ~= "string" or text == "" then return nil end
  local argv = {}
  for word in (text:gsub("%z$", "") .. "\0"):gmatch("([^%z]*)%z") do argv[#argv + 1] = word end
  return #argv > 0 and argv or nil
end

-- argv from `ps -o args=`: split on whitespace, so an argument that held a
-- space comes back as several.
function M.split_words(text)
  if type(text) ~= "string" then return nil end
  local argv = {}
  for word in text:gmatch("%S+") do argv[#argv + 1] = word end
  return #argv > 0 and argv or nil
end

-- The base name of a program path: "ssh" for "/usr/bin/ssh".
function M.program(path)
  if type(path) ~= "string" then return nil end
  return path:match("([^/]+)$")
end

-- The ssh command that opens a shell on the machine `argv` connects to:
-- the same program, options and destination, without the remote command and
-- the options in DROP. Returns the new argv and the destination, or nil when
-- argv has no destination.
--
-- Like OpenSSH, options may come before or after the destination; the first
-- word after the destination that isn't an option starts the remote command.
function M.ssh_command(argv)
  if type(argv) ~= "table" or not argv[1] then return nil end
  local out = { argv[1] }
  local dest
  local i = 2
  while i <= #argv do
    local word = argv[i]
    if word == "--" then
      -- Everything after "--" is the destination, then the command.
      if not dest then dest = argv[i + 1] end
      break
    elseif word:sub(1, 1) == "-" and #word > 1 then
      local j = 2
      while j <= #word do
        local c = word:sub(j, j)
        if TAKES_ARG[c] then
          local value = word:sub(j + 1)
          if value == "" then
            i = i + 1
            value = argv[i]
          end
          if value == nil then return nil end
          if not DROP[c] then
            out[#out + 1] = "-" .. c
            out[#out + 1] = value
          end
          break
        end
        if not DROP[c] then out[#out + 1] = "-" .. c end
        j = j + 1
      end
    elseif not dest then
      dest = word
    else
      break -- the remote command
    end
    i = i + 1
  end
  if not dest or dest == "" then return nil end
  out[#out + 1] = dest
  return out, dest
end

-- Shells a new tab starts. A tab whose foreground is one of these, and
-- nothing else, is a plain shell waiting for input.
M.SHELLS = { zsh = true, bash = true, fish = true, sh = true, dash = true, ksh = true, mksh = true, tcsh = true, csh = true, nu = true, xonsh = true, elvish = true }

-- Whether a process name is a shell: "zsh", "-zsh" (a login shell), "/bin/zsh".
function M.is_shell(name)
  if type(name) ~= "string" then return false end
  name = M.program(name:gsub("^%-", "")) or ""
  return M.SHELLS[name] == true
end

-- One argument quoted for a POSIX shell (and zsh, bash, fish): left as it is
-- when it holds only safe characters, else in single quotes.
function M.quote(word)
  word = tostring(word)
  if word ~= "" and not word:find("[^%w@%%_%-%+=:,%./~]") and word:sub(1, 1) ~= "~" then return word end
  return "'" .. word:gsub("'", [['\'']]) .. "'"
end

-- A command line to type into a shell.
function M.command_line(argv)
  local words = {}
  for i, word in ipairs(argv) do words[i] = M.quote(word) end
  return table.concat(words, " ")
end

-- The ssh command for a terminal's process reply, given a function that
-- returns the argv of a pid. Returns argv, destination and the local folder
-- ssh runs in, or nil when the terminal isn't running ssh.
function M.from_process(process, argv_of)
  local fg = type(process) == "table" and process.foreground
  if type(fg) ~= "table" or not fg.pid then return nil end
  if not M.PROGRAMS[fg.name] and not M.PROGRAMS[M.program(fg.path)] then return nil end
  local argv = argv_of(fg.pid)
  if not argv then return nil end
  local cmd, dest = M.ssh_command(argv)
  if not cmd then return nil end
  return cmd, dest, fg.cwd
end

return M
