-- live_arena / client.lua
-- Runs the arena for the streamer: spawns enemies, applies effects, keeps the
-- player at a fixed real HP and reports every point of damage (the "virtual"
-- health bar on stream lives in the Node server).

local enemies = {}            -- { ped, mult, by, diedAt, counted, lastTask }
local enemyGroup = nil
local hideHud = true
local nameTags = true
local TAG_MAX_DISTANCE = 80.0
local spawnMin, spawnMax = 14.0, 28.0
local wasDead = false
local expectDeath = false
local respawning = false
local slowmoUntil = 0
local serverOnline = nil

-- reports, flushed to the server every 200 ms
local outDmg, outKills, outAlive = 0.0, 0, 0
local outHits = {}            -- [spawnId] = damage dealt by that viewer's enemy
local outDied, outRespawn = false, false

-- ===============================================================
-- Helpers
-- ===============================================================
local function loadModel(name)
    local hash = type(name) == 'number' and name or GetHashKey(name)
    if not IsModelInCdimage(hash) or not IsModelValid(hash) then return nil end
    RequestModel(hash)
    local deadline = GetGameTimer() + 4000
    while not HasModelLoaded(hash) do
        if GetGameTimer() > deadline then return nil end
        Wait(0)
    end
    return hash
end

local function postFx(name, ms)
    AnimpostfxPlay(name, ms or 1000, false)
end

local function particle(asset, fx, pos, scale)
    RequestNamedPtfxAsset(asset)
    local deadline = GetGameTimer() + 1000
    while not HasNamedPtfxAssetLoaded(asset) do
        if GetGameTimer() > deadline then return end
        Wait(0)
    end
    UseParticleFxAssetNextCall(asset)
    StartParticleFxNonLoopedAtCoord(fx, pos.x, pos.y, pos.z, 0.0, 0.0, 0.0, scale or 1.0, false, false, false)
end

local function randf(a, b) return a + math.random() * (b - a) end

-- '#a855f7' -> 168, 85, 247 (lightened a bit so names stay readable on dark scenes)
local function hexColor(hex)
    hex = tostring(hex or ''):gsub('#', '')
    if #hex == 3 then hex = hex:gsub('.', '%0%0') end
    local r, g, b = tonumber(hex:sub(1, 2), 16), tonumber(hex:sub(3, 4), 16), tonumber(hex:sub(5, 6), 16)
    if not (r and g and b) then return { 255, 255, 255 } end
    local lift = function(c) return math.floor(c + (255 - c) * 0.25) end
    return { lift(r), lift(g), lift(b) }
end

local function headingTo(from, to)
    return GetHeadingFromVector_2d(to.x - from.x, to.y - from.y)
end

local function deletePed(ped)
    if DoesEntityExist(ped) then
        SetEntityAsMissionEntity(ped, true, true)
        DeletePed(ped)
    end
end

-- ===============================================================
-- Player setup / respawn
-- ===============================================================
local function initPlayerHealth(ped)
    SetEntityMaxHealth(ped, Config.PlayerBaseline)
    SetEntityHealth(ped, Config.PlayerBaseline)
    SetPedArmour(ped, 0)
    SetPlayerHealthRechargeMultiplier(PlayerId(), 0.0)
end

local function giveLoadout(ped)
    for _, item in ipairs(Config.Loadout) do
        GiveWeaponToPed(ped, GetHashKey(item.weapon), item.ammo or 250, false, false)
    end
    if Config.Loadout[1] then SetCurrentPedWeapon(ped, GetHashKey(Config.Loadout[1].weapon), true) end
    SetPedInfiniteAmmoClip(ped, Config.InfiniteAmmo == true)
end

local function groundAt(x, y, z)
    for _, h in ipairs({ z + 50.0, z + 10.0, 1000.0 }) do
        local ok, gz = GetGroundZFor_3dCoord(x, y, h, false)
        if ok then return gz end
    end
    return z
end

local function spawnPlayer(coords, heading)
    DoScreenFadeOut(300)
    while not IsScreenFadedOut() do Wait(0) end

    local model = loadModel(Config.PlayerModel) or loadModel('player_one')
    if model and GetEntityModel(PlayerPedId()) ~= model then
        SetPlayerModel(PlayerId(), model)
        SetPedDefaultComponentVariation(PlayerPedId())
        SetModelAsNoLongerNeeded(model)
    end

    RequestCollisionAtCoord(coords.x, coords.y, coords.z)
    local ped = PlayerPedId()
    FreezeEntityPosition(ped, true)
    SetEntityCoordsNoOffset(ped, coords.x, coords.y, coords.z, false, false, false)
    local t = GetGameTimer() + 5000
    while not HasCollisionLoadedAroundEntity(ped) and GetGameTimer() < t do Wait(0) end
    local z = groundAt(coords.x, coords.y, coords.z)

    NetworkResurrectLocalPlayer(coords.x, coords.y, z, heading or 0.0, true, false)
    ped = PlayerPedId()
    ClearPedTasksImmediately(ped)
    ClearPlayerWantedLevel(PlayerId())
    FreezeEntityPosition(ped, false)
    SetEntityVisible(ped, true, false)
    SetPlayerInvincible(PlayerId(), false)
    initPlayerHealth(ped)
    giveLoadout(ped)

    AnimpostfxStopAll()
    ShutdownLoadingScreen()
    ShutdownLoadingScreenNui()
    DoScreenFadeIn(500)
end

-- ===============================================================
-- Enemies
-- ===============================================================
local function setupGroups()
    local _, hash = AddRelationshipGroup('TTARENA_ENEMIES')
    enemyGroup = hash
    local player = GetHashKey('PLAYER')
    SetRelationshipBetweenGroups(5, enemyGroup, player)
    SetRelationshipBetweenGroups(5, player, enemyGroup)
    SetRelationshipBetweenGroups(0, enemyGroup, enemyGroup)
end

local function findSpawnPoint(origin)
    for _ = 1, 6 do
        local ang = randf(0.0, math.pi * 2.0)
        local dist = randf(spawnMin, spawnMax)
        local x, y = origin.x + math.cos(ang) * dist, origin.y + math.sin(ang) * dist
        local ok, safe = GetSafeCoordForPed(x, y, origin.z + 2.0, false, 16)
        if ok and #(safe - origin) > 4.0 and #(safe - origin) < spawnMax + 25.0 then return safe end
        local gok, gz = GetGroundZFor_3dCoord(x, y, origin.z + 50.0, false)
        if gok and math.abs(gz - origin.z) < 15.0 then return vector3(x, y, gz) end
    end
    return origin + vector3(randf(-8.0, 8.0), randf(-8.0, 8.0), 0.0)
end

local function spawnEnemy(a)
    if #enemies >= Config.MaxEnemiesHard then return end
    local player = PlayerPedId()
    local origin = GetEntityCoords(player)
    local pos = findSpawnPoint(origin)

    local model = loadModel(a.model or Config.FallbackModel)
    if not model or not IsModelAPed(model) then model = loadModel(Config.FallbackModel) end
    if not model then return end

    local ped = CreatePed(4, model, pos.x, pos.y, pos.z, headingTo(pos, origin), false, true)
    SetModelAsNoLongerNeeded(model)
    if not DoesEntityExist(ped) then return end

    local hp = math.max(1, tonumber(a.hp) or 200)
    SetEntityMaxHealth(ped, hp + 100) -- peds die at 100
    SetEntityHealth(ped, hp + 100)
    SetPedArmour(ped, tonumber(a.armor) or 0)
    SetPedAccuracy(ped, math.max(0, math.min(100, tonumber(a.acc) or 30)))
    SetPedRelationshipGroupHash(ped, enemyGroup)
    SetBlockingOfNonTemporaryEvents(ped, true)
    SetPedKeepTask(ped, true)

    local weapon = a.weapon or 'WEAPON_UNARMED'
    if weapon ~= 'WEAPON_UNARMED' then
        local wh = GetHashKey(weapon)
        GiveWeaponToPed(ped, wh, 9999, false, true)
        SetCurrentPedWeapon(ped, wh, true)
    end

    SetPedCombatAbility(ped, 2)
    SetPedCombatMovement(ped, 2)
    SetPedCombatRange(ped, 1)
    SetPedCombatAttributes(ped, 46, true) -- always fight
    SetPedCombatAttributes(ped, 5, true)  -- fight armed peds when unarmed
    SetPedCombatAttributes(ped, 0, true)  -- use cover
    SetPedFleeAttributes(ped, 0, false)
    SetPedSuffersCriticalHits(ped, false)
    SetPedDropsWeaponsWhenDead(ped, false)
    TaskCombatPed(ped, player, 0, 16)

    CreateThread(function() particle('scr_rcbarry2', 'scr_clown_appears', pos, 1.2) end)

    enemies[#enemies + 1] = {
        id = tostring(a.id or ''),
        ped = ped,
        mult = math.max(0.0, tonumber(a.dmg) or 1.0),
        by = (a.by or ''):sub(1, 24),
        color = hexColor(a.color),
        diedAt = 0,
        counted = false,
        lastTask = GetGameTimer(),
    }
end

local function clearEnemies()
    for _, e in ipairs(enemies) do deletePed(e.ped) end
    enemies = {}
end

local function explodeEnemies(limit, explosionType, shake)
    local playerPos = GetEntityCoords(PlayerPedId())
    local done = 0
    for _, e in ipairs(enemies) do
        if done >= limit then break end
        local ped = e.ped
        if DoesEntityExist(ped) and not IsEntityDead(ped) then
            local pos = GetEntityCoords(ped)
            if #(pos - playerPos) > 9.0 then
                AddExplosion(pos.x, pos.y, pos.z, explosionType, 1.0, true, false, shake)
            else
                CreateThread(function() particle('scr_rcbarry2', 'scr_clown_death', pos, 1.5) end)
            end
            SetEntityHealth(ped, 0)
            done = done + 1
        end
    end
end

-- ===============================================================
-- Commands from the Node server (via server.lua)
-- ===============================================================
local handlers = {}

handlers.config = function(a)
    hideHud = a.hidehud ~= '0'
    nameTags = a.nametags == '1'
    spawnMin = tonumber(a.dmin) or 14.0
    spawnMax = math.max(spawnMin, tonumber(a.dmax) or 28.0)
end

handlers.spawn = function(a) spawnEnemy(a) end

handlers.die = function()
    local ped = PlayerPedId()
    if not IsEntityDead(ped) then
        expectDeath = true
        SetTimeScale(1.0)
        SetEntityHealth(ped, 0)
    end
end

handlers.clear = function() clearEnemies() end

handlers.killall = function()
    explodeEnemies(9999, 7, 0.4)
    ShakeGameplayCam('LARGE_EXPLOSION_SHAKE', 1.0)
    postFx('ExplosionJosh3', 1500)
end

handlers.airstrike = function(a)
    explodeEnemies(tonumber(a.n) or 5, 4, 0.6)
    postFx('ExplosionJosh3', 800)
end

handlers.slowmo = function(a)
    SetTimeScale(0.35)
    slowmoUntil = GetGameTimer() + math.floor((tonumber(a.s) or 5) * 1000)
    postFx('SuccessNeutral', 1200)
end

handlers.weapon = function(a)
    local ped = PlayerPedId()
    local wh = GetHashKey(a.w or 'WEAPON_RPG')
    GiveWeaponToPed(ped, wh, 500, false, true)
    SetCurrentPedWeapon(ped, wh, true)
    postFx('SuccessFranklin', 1000)
end

handlers.launch = function(a)
    local ped = PlayerPedId()
    if IsPedInAnyVehicle(ped, false) then return end
    SetPedToRagdoll(ped, 3000, 3000, 0, false, false, false)
    SetEntityVelocity(ped, randf(-6.0, 6.0), randf(-6.0, 6.0), tonumber(a.f) or 25.0)
end

handlers.healfx = function()
    postFx('SuccessMichael', 900)
    local pos = GetEntityCoords(PlayerPedId())
    CreateThread(function() particle('scr_rcbarry1', 'scr_alien_teleport', pos, 1.0) end)
end

RegisterNetEvent('live_arena:cmds', function(list)
    if type(list) ~= 'table' then return end
    for i = 1, math.min(#list, 50) do
        local c = list[i]
        local fn = type(c) == 'table' and handlers[c.name]
        if fn then
            local ok, err = pcall(fn, c.args or {})
            if not ok then print('[live_arena] command failed: ' .. tostring(c.name) .. ' ' .. tostring(err)) end
        end
    end
end)

RegisterNetEvent('live_arena:status', function(online)
    online = online == true
    if online ~= serverOnline then
        serverOnline = online
        print(online and '[live_arena] Connected to the Live Arena server' or '[live_arena] Live Arena server offline - run START.bat')
    end
end)

-- ===============================================================
-- Threads
-- ===============================================================

-- Every frame: HUD, world rules, damage tracking, name tags.
CreateThread(function()
    while true do
        local playerId = PlayerId()
        local ped = PlayerPedId()

        if hideHud then
            HideHudAndRadarThisFrame()
            DisplayRadar(false)
        end
        SetPedDensityMultiplierThisFrame(Config.PedDensity)
        SetScenarioPedDensityMultiplierThisFrame(Config.PedDensity, Config.PedDensity)
        SetVehicleDensityMultiplierThisFrame(Config.VehicleDensity)
        SetRandomVehicleDensityMultiplierThisFrame(Config.VehicleDensity)
        SetParkedVehicleDensityMultiplierThisFrame(Config.VehicleDensity)
        if Config.DisableWanted and GetPlayerWantedLevel(playerId) > 0 then
            ClearPlayerWantedLevel(playerId)
        end

        if not respawning then
            if IsEntityDead(ped) then
                if not wasDead then
                    wasDead = true
                    if not expectDeath then outDied = true end
                    expectDeath = false
                    SetTimeScale(1.0)
                    slowmoUntil = 0
                    postFx('DeathFailOut', 0)
                    respawning = true
                    CreateThread(function()
                        Wait(Config.RespawnDelay)
                        local p = PlayerPedId()
                        local pos = GetEntityCoords(p)
                        if Config.RespawnAt == 'spawn' then
                            spawnPlayer(Config.Spawn.xyz, Config.Spawn.w)
                        else
                            spawnPlayer(pos, GetEntityHeading(p))
                        end
                        wasDead = false
                        respawning = false
                        outRespawn = true
                    end)
                end
            else
                local hp = GetEntityHealth(ped)
                if GetEntityMaxHealth(ped) ~= Config.PlayerBaseline then
                    initPlayerHealth(ped)
                elseif hp < Config.PlayerBaseline then
                    local lost = Config.PlayerBaseline - hp
                    -- Who hit us? (strongest attacker gets the credit -> kill feed & leaderboards)
                    local attacker = nil
                    for _, e in ipairs(enemies) do
                        if DoesEntityExist(e.ped) and HasEntityBeenDamagedByEntity(ped, e.ped, true) then
                            if not attacker or e.mult > attacker.mult then attacker = e end
                        end
                    end
                    ClearEntityLastDamageEntity(ped)
                    local amount = lost * (attacker and attacker.mult > 0.0 and attacker.mult or 1.0)
                    outDmg = outDmg + amount
                    if attacker and attacker.id ~= '' then
                        outHits[attacker.id] = (outHits[attacker.id] or 0.0) + amount
                    end
                    SetEntityHealth(ped, Config.PlayerBaseline)
                end
                if GetPedArmour(ped) > 0 then SetPedArmour(ped, 0) end
            end
        end

        if slowmoUntil ~= 0 and GetGameTimer() > slowmoUntil then
            slowmoUntil = 0
            SetTimeScale(1.0)
        end

        if nameTags then
            local cam = GetFinalRenderedCamCoord()
            local fov = (1.0 / GetFinalRenderedCamFov()) * 100.0
            for _, e in ipairs(enemies) do
                if e.by ~= '' and DoesEntityExist(e.ped) and not IsEntityDead(e.ped) then
                    -- Head bone (SKEL_Head) so the name sits right above tall models too.
                    local head = GetPedBoneCoords(e.ped, 31086, 0.0, 0.0, 0.0)
                    local dist = #(head - cam)
                    if dist < TAG_MAX_DISTANCE then
                        local onScreen, sx, sy = World3dToScreen2d(head.x, head.y, head.z + 0.42)
                        if onScreen then
                            local scale = math.max(0.32, math.min(0.75, (2.2 / dist) * fov * 0.55))
                            local alpha = dist > TAG_MAX_DISTANCE - 20.0 and math.floor(255 * (TAG_MAX_DISTANCE - dist) / 20.0) or 255
                            SetTextScale(0.0, scale)
                            SetTextFont(4) -- condensed GTA font, like the reference stream
                            SetTextProportional(true)
                            SetTextCentre(true)
                            SetTextColour(e.color[1], e.color[2], e.color[3], alpha)
                            SetTextOutline()
                            SetTextDropshadow(2, 0, 0, 0, alpha)
                            BeginTextCommandDisplayText('STRING')
                            AddTextComponentSubstringPlayerName(e.by)
                            EndTextCommandDisplayText(sx, sy)
                        end
                    end
                end
            end
        end

        Wait(0)
    end
end)

-- Every 250 ms: enemy bookkeeping (kills, corpses, leash, re-task).
CreateThread(function()
    while true do
        Wait(250)
        local now = GetGameTimer()
        local player = PlayerPedId()
        local playerPos = GetEntityCoords(player)
        local playerDead = IsEntityDead(player)
        local alive = 0
        for i = #enemies, 1, -1 do
            local e = enemies[i]
            if not DoesEntityExist(e.ped) then
                table.remove(enemies, i)
            elseif IsEntityDead(e.ped) then
                if not e.counted then
                    e.counted = true
                    e.diedAt = now
                    outKills = outKills + 1
                elseif now - e.diedAt > Config.CorpseSeconds * 1000 then
                    deletePed(e.ped)
                    table.remove(enemies, i)
                end
            else
                alive = alive + 1
                if not playerDead then
                    if #(GetEntityCoords(e.ped) - playerPos) > Config.LeashDistance then
                        local p = findSpawnPoint(playerPos)
                        SetEntityCoords(e.ped, p.x, p.y, p.z, false, false, false, false)
                        TaskCombatPed(e.ped, player, 0, 16)
                        e.lastTask = now
                    elseif now - e.lastTask > 4000 then
                        e.lastTask = now
                        if not IsPedInCombat(e.ped, player) then TaskCombatPed(e.ped, player, 0, 16) end
                    end
                end
            end
        end
        outAlive = alive
    end
end)

-- Every 200 ms: send reports to server.lua.
CreateThread(function()
    local lastSent = 0
    while true do
        Wait(200)
        local now = GetGameTimer()
        if outDmg > 0 or outKills > 0 or outDied or outRespawn or now - lastSent > 1000 then
            TriggerServerEvent('live_arena:report', outDmg, outKills, outAlive, outDied, outRespawn, outHits)
            outDmg, outKills, outDied, outRespawn, outHits = 0.0, 0, false, false, {}
            lastSent = now
        end
    end
end)

-- Weather / time / dispatch, every 5 s.
CreateThread(function()
    while true do
        if Config.Weather then
            SetWeatherTypeNowPersist(Config.Weather)
            SetOverrideWeather(Config.Weather)
        end
        if Config.ClockHour then NetworkOverrideClockTime(Config.ClockHour, 0, 0) end
        if Config.DisableDispatch then
            for i = 1, 15 do EnableDispatchService(i, false) end
        end
        if Config.DisableWanted then SetMaxWantedLevel(0) end
        Wait(5000)
    end
end)

-- ===============================================================
-- Startup
-- ===============================================================
CreateThread(function()
    -- If a spawnmanager is running (e.g. txAdmin default recipe), we take over spawning.
    if GetResourceState('spawnmanager') == 'started' then
        pcall(function() exports.spawnmanager:setAutoSpawn(false) end)
    end
    while not NetworkIsPlayerActive(PlayerId()) do Wait(100) end
    setupGroups()
    spawnPlayer(Config.Spawn.xyz, Config.Spawn.w)
    TriggerServerEvent('live_arena:ready')
end)

AddEventHandler('onResourceStop', function(res)
    if res ~= GetCurrentResourceName() then return end
    clearEnemies()
    SetTimeScale(1.0)
end)

-- F8 console helpers
RegisterCommand('arena_respawn', function() spawnPlayer(Config.Spawn.xyz, Config.Spawn.w) end, false)
RegisterCommand('arena_clear', function() clearEnemies() end, false)
