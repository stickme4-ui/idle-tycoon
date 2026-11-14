Config = {}

-- Live Arena Node server. Leave nil to read server_url.txt (written automatically
-- by the Node server with the real port) or the convar "live_arena_url".
Config.ServerUrl = nil
Config.PollMs = 100

-- ===== Player =====
-- Any ped model, including streamed add-on peds (e.g. a superhero you put in arena_peds).
Config.PlayerModel = 'player_one'
-- Del Perro Pier / beach (like the stream in your screenshot). x, y, z, heading
Config.Spawn = vector4(-1850.13, -1231.75, 13.02, 140.0)
Config.RespawnAt = 'death'      -- 'death' = get up where you died, 'spawn' = go back to Config.Spawn
Config.RespawnDelay = 6000      -- ms on the ground before getting up
Config.Loadout = {
    { weapon = 'WEAPON_ASSAULTRIFLE', ammo = 999 },
    { weapon = 'WEAPON_PUMPSHOTGUN',  ammo = 250 },
    { weapon = 'WEAPON_PISTOL',       ammo = 250 },
    { weapon = 'WEAPON_KNIFE',        ammo = 1 },
}
Config.InfiniteAmmo = true

-- ===== World =====
Config.DisableWanted = true     -- no police wanted level
Config.DisableDispatch = true   -- no random cops / ambulances / fire trucks
Config.PedDensity = 0.6         -- 0.0 - 1.0 random pedestrians
Config.VehicleDensity = 0.6     -- 0.0 - 1.0 random traffic
Config.Weather = 'EXTRASUNNY'   -- nil = don't touch
Config.ClockHour = 13           -- nil = don't freeze time

-- ===== Internals (normally no need to change) =====
Config.PlayerBaseline = 2000    -- real in-game HP the player is kept at
Config.LeashDistance = 140.0    -- enemies further than this get re-positioned
Config.CorpseSeconds = 10
Config.MaxEnemiesHard = 120     -- safety cap regardless of panel settings
Config.FallbackModel = 's_m_y_swat_01'
