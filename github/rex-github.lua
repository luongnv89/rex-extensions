-- rex-github: the current repo's open pull requests and issues, in a side pane of Rex.
--
-- Load it from init.lua, then bind a key to its action:
--
--   dofile("/path/to/rex-extensions/github/rex-github.lua")
--   rex.bind("cmd+shift+g", "github_panel")
--
-- The action opens the panel on the right of the focused pane's tab, a third of
-- the tab wide, or closes it when that tab already has one. A panel is the block
-- labelled "rex-github", so no state is kept anywhere to find it again.

local LABEL = "rex-github"
local TERMINAL = "com.superlogical.terminal.shell"
-- The panel's share of the tab's width.
local WIDTH = 0.33

-- This file's folder: panel.js sits next to it.
local here = debug.getinfo(1, "S").source:gsub("^@", ""):match("^(.*)/[^/]*$") or "."
local PANEL = here .. "/panel.js"

-- The window holding `block_id`, in tiled and floating layers alike, and its blocks.
local function find_window(view, block_id)
  for _, window in ipairs(view.windows or {}) do
    local blocks = {}
    local mine = false
    for _, layer in ipairs(window.layers or {}) do
      for _, block in ipairs(layer.blocks or {}) do
        table.insert(blocks, block)
        if block.block_id == block_id then mine = true end
      end
    end
    if mine then return window, blocks end
  end
  return nil, {}
end

-- The tiled layer's root: a whole-tab split puts the panel at the tab's right edge.
local function root_of(window)
  for _, layer in ipairs(window.layers or {}) do
    if layer.kind == "tiled" and layer.layout then
      local node = layer.layout
      return (node.split and node.split.split_id) or node.block_id
    end
  end
  return nil
end

-- The working directory of the program in a terminal block, or nil.
local function cwd_of(session_id, block_id)
  local ok, proc = pcall(rex.call, "block.method", { session_id = session_id, block_id = block_id, method = "process", args = {} })
  if not ok or type(proc) ~= "table" then return nil end
  local fg, child = proc.foreground or {}, proc.child or {}
  return fg.cwd or child.cwd
end

local function toggle(ctx)
  local view = rex.call("session.view", { session_id = ctx.session_id })
  local window, blocks = find_window(view, ctx.block_id)
  if not window then error("rex-github: no window holds the focused block") end

  local closed = 0
  for _, block in ipairs(blocks) do
    if block.label == LABEL then
      rex.call("block.close", { session_id = ctx.session_id, block_id = block.block_id })
      closed = closed + 1
    end
  end
  if closed > 0 then return { closed = closed } end

  local command = { "node", PANEL, "--target", ctx.block_id }
  local cwd = cwd_of(ctx.session_id, ctx.block_id)
  if cwd then
    table.insert(command, "--cwd")
    table.insert(command, cwd)
  end
  local opened = rex.call("session.new_split", {
    session_id = ctx.session_id,
    anchor_id = root_of(window) or ctx.block_id,
    direction = "horizontal",
    side = "after",
    ratio = 1 - WIDTH,
    focus = true,
    layout = { block = { flavor = TERMINAL, label = LABEL, options = { command = command, cwd = here } } },
  })
  return { opened = opened.block_ids and opened.block_ids[1] }
end

rex.action({
  name = "github_panel",
  title = "PR and Issue Panel",
  description = "Show or hide the open pull requests and issues of the repo you're in.",
  category = "GitHub",
  keywords = "github gitlab pull request merge issue pr mr",
  run = toggle,
})
