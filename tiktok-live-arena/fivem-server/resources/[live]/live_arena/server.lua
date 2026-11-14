-- live_arena / server.lua
-- Bridges the local Live Arena Node server <-> the streamer's FiveM client.
--   * polls  GET {url}/game/poll  with damage/kills/alive reports
--   * forwards the returned commands to the streamer client

local VERSION = 'fivem-1.0.0'

local streamer = nil          -- server id of the player the arena runs for
local ready = {}              -- players whose client finished loading
local inFlight = false
local inFlightSince = 0
local connected = false
local hello = true
local baseUrl = nil

-- reports accumulated from the streamer client
local rep = { dmg = 0.0, kills = 0, alive = 0, died = false, respawn = false, hits = {} }

-- ---------------------------------------------------------------
-- URL resolution: Config -> convar -> server_url.txt -> default
-- ---------------------------------------------------------------
local function resolveUrl()
    local url = Config.ServerUrl
    if not url or url == '' then url = GetConvar('live_arena_url', '') end
    if url == '' then
        local file = LoadResourceFile(GetCurrentResourceName(), 'server_url.txt')
        if file then url = file:match('^%s*(%S+)') or '' end
    end
    if url == '' then url = 'http://127.0.0.1:7420' end
    return (url:gsub('/+$', ''))
end

local function urlDecode(s)
    return (s:gsub('%%(%x%x)', function(h) return string.char(tonumber(h, 16)) end))
end

-- "name\tk=v\tk=v" -> { name = 'spawn', args = { k = v } }
local function parseCommands(body)
    local list = {}
    for line in body:gmatch('[^\n]+') do
        line = line:gsub('\r$', '')
        if line ~= '' then
            local cmd = { args = {} }
            local first = true
            for part in line:gmatch('[^\t]+') do
                if first then
                    cmd.name = part
                    first = false
                else
                    local k, v = part:match('^([^=]+)=(.*)$')
                    if k then cmd.args[k] = urlDecode(v) end
                end
            end
            if cmd.name then list[#list + 1] = cmd end
        end
    end
    return list
end

local function log(msg)
    print(('^5[live_arena]^7 %s'):format(msg))
end

-- ---------------------------------------------------------------
-- Streamer selection (first fully-loaded player; next one if they leave)
-- ---------------------------------------------------------------
local function pickStreamer()
    streamer = nil
    for _, id in ipairs(GetPlayers()) do
        local n = tonumber(id)
        if ready[n] then streamer = n break end
    end
    hello = true
    if streamer then log(('Arena player: %s (%d)'):format(GetPlayerName(streamer) or '?', streamer)) end
end

RegisterNetEvent('live_arena:ready', function()
    local src = source
    ready[src] = true
    if not streamer or not GetPlayerName(streamer) then
        streamer = src
        hello = true
        log(('Arena player: %s (%d)'):format(GetPlayerName(src) or '?', src))
    end
    if src == streamer then TriggerClientEvent('live_arena:status', src, connected) end
end)

AddEventHandler('playerDropped', function()
    local src = source
    ready[src] = nil
    if src == streamer then pickStreamer() end
end)

-- ---------------------------------------------------------------
-- Reports from the streamer client (validated + clamped)
-- ---------------------------------------------------------------
RegisterNetEvent('live_arena:report', function(dmg, kills, alive, died, respawn, hits)
    local src = source
    if src ~= streamer then return end
    dmg = tonumber(dmg) or 0
    kills = math.floor(tonumber(kills) or 0)
    alive = math.floor(tonumber(alive) or 0)
    if dmg > 0 and dmg < 1000000 then rep.dmg = rep.dmg + dmg end
    if kills > 0 and kills < 1000 then rep.kills = rep.kills + kills end
    if alive >= 0 and alive <= 1000 then rep.alive = alive end
    if died == true then rep.died = true end
    if respawn == true then rep.respawn = true end
    if type(hits) == 'table' then
        local n = 0
        for id, amount in pairs(hits) do
            n = n + 1
            if n > 64 then break end
            id = tostring(id)
            amount = tonumber(amount) or 0
            if id:match('^%d+$') and #id <= 10 and amount > 0 and amount < 1000000 then
                rep.hits[id] = (rep.hits[id] or 0) + amount
            end
        end
    end
end)

local function encodeHits(hits)
    local parts = {}
    for id, amount in pairs(hits) do parts[#parts + 1] = ('%s:%.2f'):format(id, amount) end
    return table.concat(parts, ',')
end

-- ---------------------------------------------------------------
-- Poll loop
-- ---------------------------------------------------------------
local function setConnected(state)
    if connected == state then return end
    connected = state
    if state then log('Connected to Live Arena server at ' .. baseUrl)
    else log('^1Live Arena server not reachable at ' .. baseUrl .. ' - is START.bat running?^7') end
    if streamer then TriggerClientEvent('live_arena:status', streamer, connected) end
end

CreateThread(function()
    baseUrl = resolveUrl()
    log('Using ' .. baseUrl)
    local failures = 0
    while true do
        local now = GetGameTimer()
        if inFlight and now - inFlightSince > 5000 then inFlight = false end -- watchdog

        if streamer and not inFlight then
            -- snapshot + reset the reports
            local r = rep
            rep = { dmg = 0.0, kills = 0, alive = r.alive, died = false, respawn = false, hits = {} }
            local hitStr = encodeHits(r.hits)
            local q = ('?v=%s&alive=%d&dmg=%.2f&kills=%d%s%s%s%s'):format(
                VERSION, r.alive, r.dmg, r.kills, hitStr ~= '' and ('&hits=' .. hitStr) or '',
                r.died and '&died=1' or '', r.respawn and '&respawn=1' or '',
                (hello or not connected) and '&hello=1' or '')

            inFlight = true
            inFlightSince = now
            PerformHttpRequest(baseUrl .. '/game/poll' .. q, function(status, body)
                inFlight = false
                if status == 200 then
                    failures = 0
                    hello = false
                    setConnected(true)
                    if body and body ~= '' and streamer then
                        local cmds = parseCommands(body)
                        if #cmds > 0 then TriggerClientEvent('live_arena:cmds', streamer, cmds) end
                    end
                else
                    -- keep the reports so nothing is lost while the Node server is down
                    rep.dmg = rep.dmg + r.dmg
                    rep.kills = rep.kills + r.kills
                    rep.died = rep.died or r.died
                    rep.respawn = rep.respawn or r.respawn
                    for id, amount in pairs(r.hits) do rep.hits[id] = (rep.hits[id] or 0) + amount end
                    failures = failures + 1
                    setConnected(false)
                    if failures % 5 == 0 then baseUrl = resolveUrl() end -- port may have changed
                end
            end, 'GET', '', { ['Connection'] = 'keep-alive' })
        end
        Wait(connected and Config.PollMs or 1500)
    end
end)

-- Handy console commands (server console / txAdmin live console)
RegisterCommand('arena_status', function(src)
    if src ~= 0 then return end
    log(('url=%s connected=%s streamer=%s'):format(baseUrl, tostring(connected), tostring(streamer)))
end, true)

RegisterCommand('arena_url', function(src, args)
    if src ~= 0 then return end
    if args[1] then baseUrl = args[1]:gsub('/+$', '') end
    log('Using ' .. baseUrl)
end, true)
