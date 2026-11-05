-- rex-mcc: the 5-hour and weekly Claude Code usage of every mcc account, in a
-- strip along the bottom of a Rex tab.
--
-- Load it from init.lua, then bind a key to its action:
--
--   dofile("/path/to/rex-extensions/mcc/rex-mcc.lua")
--   rex.bind("cmd+shift+u", "mcc_usage")
--
-- The action opens the panel across the bottom of the focused pane's tab, or
-- closes it when that tab already has one. A panel is the block labelled
-- "rex-mcc", so no state is kept anywhere to find it again. The panel fits its
-- own height to the accounts once it starts.

local LABEL = "rex-mcc"
local TERMINAL = "com.superlogical.terminal.shell"
-- The panel's share of the tab's height until it fits itself.
local HEIGHT = 0.25

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

-- The tiled layer's root: a whole-tab split puts the panel along the tab's bottom edge.
local function root_of(window)
  for _, layer in ipairs(window.layers or {}) do
    if layer.kind == "tiled" and layer.layout then
      local node = layer.layout
      return (node.split and node.split.split_id) or node.block_id
    end
  end
  return nil
end

local function toggle(ctx)
  local view = rex.call("session.view", { session_id = ctx.session_id })
  local window, blocks = find_window(view, ctx.block_id)
  if not window then error("rex-mcc: no window holds the focused block") end

  local closed = 0
  for _, block in ipairs(blocks) do
    if block.label == LABEL then
      rex.call("block.close", { session_id = ctx.session_id, block_id = block.block_id })
      closed = closed + 1
    end
  end
  if closed > 0 then return { closed = closed } end

  local opened = rex.call("session.new_split", {
    session_id = ctx.session_id,
    anchor_id = root_of(window) or ctx.block_id,
    direction = "vertical",
    side = "after",
    ratio = 1 - HEIGHT,
    focus = false,
    layout = { block = { flavor = TERMINAL, label = LABEL, options = { command = { "node", PANEL }, cwd = here } } },
  })
  return { opened = opened.block_ids and opened.block_ids[1] }
end

rex.action({
  name = "mcc_usage",
  title = "mcc Usage Panel",
  description = "Show or hide the 5-hour and weekly Claude Code usage of every mcc account.",
  category = "mcc",
  keywords = "mcc claude usage limit quota account 5h weekly",
  run = toggle,
})
