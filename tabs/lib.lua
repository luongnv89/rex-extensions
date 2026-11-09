-- rex-tabs: the pure part. Works out where a terminal is (machine and folder)
-- and builds the session and tab labels from it. No rex calls here, so the
-- tests run it with a plain Lua 5.1.

local M = {}

-- Separates a tab's folder from its name: "skills · claude".
M.TAB_SEP = " · "
-- Separates a session's machines from its name: "devbox:skills-work".
M.SESSION_SEP = ":"
-- Rex refuses labels longer than this.
M.MAX = 128

-- Programs whose terminal is on another machine.
local REMOTE = { ssh = true, mosh = true, ["mosh-client"] = true, et = true, autossh = true }

local function trim(s) return (s or ""):gsub("^%s+", ""):gsub("%s+$", "") end

local function utf8_cut(s, n)
  if #s <= n then return s end
  s = s:sub(1, n)
  -- Drop a trailing partial UTF-8 sequence.
  return (s:gsub("[\192-\255][\128-\191]*$", ""))
end

-- The last folder of a path: "~" for the home folder, "/" for the root.
function M.basename(path, home)
  path = trim(path)
  if path == "" then return nil end
  if path ~= "/" then path = path:gsub("/+$", "") end
  if path == "/" then return "/" end
  if path == "~" or (home and home ~= "" and path == home:gsub("/+$", "")) then return "~" end
  return path:match("([^/]+)$")
end

-- The short form of a host name: "devbox" for "devbox.example.com", and an
-- IP address as it is.
function M.short_host(host)
  host = trim(host)
  if host == "" or host == "localhost" then return nil end
  if host:match("^[%d%.]+$") or host:find(":", 1, true) then return host end
  return host:match("^[^.]+")
end

-- A file:// URL as reported by OSC 7: host and decoded path.
function M.parse_pwd(url)
  if type(url) ~= "string" then return nil end
  local host, path = url:match("^file://([^/]*)(/.*)$")
  if not path then return nil end
  path = path:gsub("%%(%x%x)", function(h) return string.char(tonumber(h, 16)) end)
  return host, path
end

-- The machine and folder in a title like "user@devbox:~/workspace/skills",
-- which most shells set by default. Needs the "user@" so a title such as
-- "vim: notes.txt" doesn't pass for a host.
function M.parse_ssh_title(title)
  if type(title) ~= "string" then return nil end
  local host, path = title:match("^%s*[^@%s]+@([%w%.%-_]+)%s*:%s*(.-)%s*$")
  if not host then return nil end
  return M.short_host(host), path ~= "" and path or nil
end

-- Where a terminal is, from its title, pwd and process replies:
--   info = { title = "...", pwd = { pwd = url, owner = { pid } },
--            process = { foreground = {...}, ancestors = {...}, home = "..." },
--            local_host = "Laptop" }
-- Returns machine, folder; either may be nil.
function M.locate(info)
  local proc = info.process or {}
  local fg = proc.foreground
  local home = proc.home
  local pwd = info.pwd or {}
  local pwd_host, pwd_path = M.parse_pwd(pwd.pwd)
  local pwd_owner = pwd.owner and pwd.owner.pid

  if fg and REMOTE[fg.name] then
    -- A remote shell that reports its folder writes it through ssh.
    if pwd_path and fg.pid and pwd_owner == fg.pid then
      return M.short_host(pwd_host), M.basename(pwd_path)
    end
    local host, path = M.parse_ssh_title(info.title)
    if host then return host, path and M.basename(path) end
    return nil, nil
  end

  local machine = M.short_host(pwd_host) or M.short_host(info.local_host)
  local cwd = (fg and fg.cwd) or (proc.ancestors and proc.ancestors[1] and proc.ancestors[1].cwd) or pwd_path
  return machine, M.basename(cwd, home)
end

-- "Window 89abcdef": the label Rex gives a tab nobody has named.
function M.is_default_window_label(label)
  return label == nil or label == "" or label:match("^Window %x+$") ~= nil
end

-- A tab's label: its folder, then its name.
function M.tab_label(name, folder)
  name = trim(name)
  if not folder or folder == "" then return utf8_cut(name, M.MAX) end
  if name == "" then return utf8_cut(folder, M.MAX) end
  -- A tab already named after its folder ("chiselturn") stays as it is.
  if name:lower() == folder:lower() then return utf8_cut(name, M.MAX) end
  local prefix = folder .. M.TAB_SEP
  return utf8_cut(prefix .. name, M.MAX)
end

-- The name part of a label tab_label built with `folder`, or nil when the
-- label doesn't start with that folder.
function M.tab_name(label, folder)
  if not label or not folder then return nil end
  local prefix = folder .. M.TAB_SEP
  if #label > #prefix and label:sub(1, #prefix) == prefix then return label:sub(#prefix + 1) end
  return nil
end

-- The machines in a list, each once, in alphabetical order.
function M.machine_list(machines)
  local seen, list = {}, {}
  for _, m in ipairs(machines) do
    if m and m ~= "" and not seen[m] then seen[m] = true; list[#list + 1] = m end
  end
  table.sort(list, function(a, b) return a:lower() < b:lower() end)
  return list
end

-- A session's label: its machines, then its name. A session named after its
-- only machine keeps its name.
function M.session_label(name, machines)
  name = trim(name)
  if #machines == 0 then return name end
  if #machines == 1 and machines[1] == name then return name end
  local prefix = table.concat(machines, ",") .. M.SESSION_SEP
  return prefix .. utf8_cut(name, M.MAX - #prefix)
end

-- A session's name without the machines session_label put before it. `known`
-- is a set of machine names; the prefix comes off only when it is all known
-- machines, so a name such as "fix:login" stays whole.
function M.session_name(label, known)
  label = label or ""
  local prefix, rest = label:match("^([^:]+):(.+)$")
  if not prefix then return label end
  for m in prefix:gmatch("[^,]+") do
    if not known[m] then return label end
  end
  return rest
end

return M
