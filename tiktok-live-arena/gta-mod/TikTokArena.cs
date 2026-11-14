// TikTok Live Arena - GTA V mod (ScriptHookVDotNet v3)
// Drop this file into "<GTA V>\scripts\". SHVDN compiles it automatically.
// It polls the local Live Arena server, spawns enemies, applies effects and
// reports damage/kills back so the server can drive the on-stream health bar.
//
// Written in C# 5 on purpose, so the built-in SHVDN script compiler accepts it.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using GTA;
using GTA.Math;
using GTA.Native;

public class TikTokArena : Script
{
    private const string Version = "1.0.0";
    private const int PlayerBaseline = 2000;      // real in-game HP we keep the player at
    private const int CorpseSeconds = 10;
    private const float LeashDistance = 140f;      // enemies further than this get re-positioned

    private class Enemy
    {
        public string Id;
        public Ped Ped;
        public float DamageMult;
        public string Name;
        public string By;
        public Color TagColor;
        public int DiedAt;
        public bool CountedKill;
        public int LastTaskAt;
    }

    // ---- networking (background thread) ----
    private readonly object sync = new object();
    private readonly Queue<string> inbox = new Queue<string>();
    private string serverUrl = "http://127.0.0.1:7420";
    private int pollMs = 100;
    private volatile bool running = true;
    private volatile bool connected;
    private Thread netThread;

    // values reported to the server (guarded by sync)
    private float outDamage;
    private Dictionary<string, float> outHits = new Dictionary<string, float>(); // spawn id -> damage
    private int outKills;
    private bool outRespawn;
    private bool outDied;
    private int outAlive;
    private bool outHello = true;

    // ---- game state ----
    private readonly List<Enemy> enemies = new List<Enemy>();
    private RelationshipGroup enemyGroup;
    private bool groupReady;
    private bool hideHud = true;
    private bool nameTags = true;
    private const float TagMaxDistance = 80f;
    private float spawnMin = 14f, spawnMax = 28f;
    private bool wasDead;
    private bool expectDeath;
    private int lastPlayerHandle;
    private int slowmoUntil;
    private readonly Random rng = new Random();

    public TikTokArena()
    {
        LoadIni();
        Tick += OnTick;
        Aborted += OnAborted;
        Interval = 0;
        netThread = new Thread(NetLoop);
        netThread.IsBackground = true;
        netThread.Start();
    }

    // ===================================================================
    // Config
    // ===================================================================
    private void LoadIni()
    {
        try
        {
            string path = Path.Combine(BaseDirectory, "TikTokArena.ini");
            if (!File.Exists(path)) return;
            foreach (string raw in File.ReadAllLines(path))
            {
                string line = raw.Trim();
                if (line.Length == 0 || line.StartsWith(";") || line.StartsWith("#")) continue;
                int eq = line.IndexOf('=');
                if (eq <= 0) continue;
                string key = line.Substring(0, eq).Trim().ToLowerInvariant();
                string val = line.Substring(eq + 1).Trim();
                if (key == "serverurl") serverUrl = val.TrimEnd('/');
                else if (key == "pollms") { int v; if (int.TryParse(val, out v)) pollMs = Math.Max(30, v); }
            }
        }
        catch (Exception) { }
    }

    // ===================================================================
    // Network thread: GET /game/poll with our reports, receive commands
    // ===================================================================
    private void NetLoop()
    {
        while (running)
        {
            string query;
            float dmg; int kills; bool respawn, died, hello; int alive;
            Dictionary<string, float> hits;
            lock (sync)
            {
                dmg = outDamage; kills = outKills; respawn = outRespawn; died = outDied; hello = outHello; alive = outAlive;
                hits = outHits;
                outDamage = 0; outKills = 0; outRespawn = false; outDied = false; outHello = false;
                outHits = new Dictionary<string, float>();
            }
            StringBuilder hitStr = new StringBuilder();
            foreach (KeyValuePair<string, float> kv in hits)
            {
                if (hitStr.Length > 0) hitStr.Append(',');
                hitStr.Append(kv.Key).Append(':').Append(kv.Value.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture));
            }
            query = "?v=" + Version + "&alive=" + alive + "&dmg=" + dmg.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture)
                + "&kills=" + kills + (hitStr.Length > 0 ? "&hits=" + hitStr.ToString() : "") + (respawn ? "&respawn=1" : "") + (died ? "&died=1" : "") + (hello || !connected ? "&hello=1" : "");
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(serverUrl + "/game/poll" + query);
                req.Proxy = null;
                req.Timeout = 2500;
                req.ReadWriteTimeout = 2500;
                req.KeepAlive = true;
                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                using (StreamReader sr = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                {
                    string body = sr.ReadToEnd();
                    connected = true;
                    if (body.Length > 0)
                    {
                        string[] lines = body.Split('\n');
                        lock (sync) { foreach (string l in lines) if (l.Trim().Length > 0) inbox.Enqueue(l.TrimEnd('\r')); }
                    }
                }
                Thread.Sleep(pollMs);
            }
            catch (Exception)
            {
                // Server not running yet - put the reports back so nothing is lost.
                connected = false;
                lock (sync)
                {
                    outDamage += dmg; outKills += kills; outRespawn |= respawn; outDied |= died; outHello = true;
                    foreach (KeyValuePair<string, float> kv in hits) { float v; outHits.TryGetValue(kv.Key, out v); outHits[kv.Key] = v + kv.Value; }
                }
                Thread.Sleep(1500);
            }
        }
    }

    private void OnAborted(object sender, EventArgs e)
    {
        running = false;
        Game.TimeScale = 1f;
        foreach (Enemy en in enemies) if (en.Ped != null && en.Ped.Exists()) en.Ped.Delete();
        enemies.Clear();
    }

    // ===================================================================
    // Main tick
    // ===================================================================
    private void OnTick(object sender, EventArgs e)
    {
        Ped player = Game.Player.Character;
        if (player == null || !player.Exists()) return;

        TrackPlayerHealth(player);
        if (!groupReady) SetupGroups(player);

        if (hideHud)
        {
            Function.Call(Hash.HIDE_HUD_AND_RADAR_THIS_FRAME);
        }
        Game.Player.WantedLevel = 0;

        int processed = 0;
        while (processed < 8)
        {
            string line = null;
            lock (sync) { if (inbox.Count > 0) line = inbox.Dequeue(); }
            if (line == null) break;
            try { Execute(line, player); } catch (Exception) { }
            processed++;
        }

        UpdateEnemies(player);

        if (slowmoUntil != 0 && Game.GameTime > slowmoUntil)
        {
            slowmoUntil = 0;
            Game.TimeScale = 1f;
        }
    }

    private void SetupGroups(Ped player)
    {
        enemyGroup = World.AddRelationshipGroup("TTARENA_ENEMIES");
        enemyGroup.SetRelationshipBetweenGroups(player.RelationshipGroup, Relationship.Hate, true);
        enemyGroup.SetRelationshipBetweenGroups(enemyGroup, Relationship.Companion, true);
        Function.Call(Hash.SET_MAX_WANTED_LEVEL, 0);
        groupReady = true;
    }

    // The player is kept at a fixed in-game HP. Every point lost is reported
    // to the server (the "virtual" health shown on stream) and refilled.
    private void TrackPlayerHealth(Ped player)
    {
        if (player.Handle != lastPlayerHandle)
        {
            lastPlayerHandle = player.Handle;
            groupReady = false; // new character model -> new relationship group
            InitPlayerHealth(player);
            return;
        }

        if (player.IsDead)
        {
            if (!wasDead)
            {
                wasDead = true;
                if (!expectDeath) lock (sync) { outDied = true; }
                expectDeath = false;
                Game.TimeScale = 1f;
                slowmoUntil = 0;
            }
            return;
        }

        if (wasDead)
        {
            wasDead = false;
            InitPlayerHealth(player);
            lock (sync) { outRespawn = true; }
            return;
        }

        int hp = player.Health;
        if (hp < PlayerBaseline)
        {
            float lost = PlayerBaseline - hp;
            Enemy attacker = FindAttacker(player);
            float amount = lost * (attacker != null && attacker.DamageMult > 0f ? attacker.DamageMult : 1f);
            lock (sync)
            {
                outDamage += amount;
                if (attacker != null && attacker.Id.Length > 0)
                {
                    float v; outHits.TryGetValue(attacker.Id, out v); outHits[attacker.Id] = v + amount;
                }
            }
            player.Health = PlayerBaseline;
        }
        if (player.Armor > 0) player.Armor = 0;
    }

    private void InitPlayerHealth(Ped player)
    {
        player.MaxHealth = PlayerBaseline;
        player.Health = PlayerBaseline;
        player.Armor = 0;
    }

    // Which viewer's enemy hit us? (strongest attacker gets the credit -> kill feed & leaderboards)
    private Enemy FindAttacker(Ped player)
    {
        Enemy best = null;
        foreach (Enemy en in enemies)
        {
            if (en.Ped == null || !en.Ped.Exists()) continue;
            if (Function.Call<bool>(Hash.HAS_ENTITY_BEEN_DAMAGED_BY_ENTITY, player, en.Ped, true))
            {
                if (best == null || en.DamageMult > best.DamageMult) best = en;
            }
        }
        Function.Call(Hash.CLEAR_ENTITY_LAST_DAMAGE_ENTITY, player);
        return best;
    }

    // ===================================================================
    // Commands: "name\tkey=value\tkey=value" (values are URL-encoded)
    // ===================================================================
    private void Execute(string line, Ped player)
    {
        string[] parts = line.Split('\t');
        string cmd = parts[0].Trim();
        Dictionary<string, string> a = new Dictionary<string, string>();
        for (int i = 1; i < parts.Length; i++)
        {
            int eq = parts[i].IndexOf('=');
            if (eq > 0) a[parts[i].Substring(0, eq)] = Uri.UnescapeDataString(parts[i].Substring(eq + 1));
        }

        switch (cmd)
        {
            case "config":
                hideHud = Get(a, "hidehud", "1") == "1";
                nameTags = Get(a, "nametags", "0") == "1";
                spawnMin = GetFloat(a, "dmin", 14f);
                spawnMax = Math.Max(spawnMin, GetFloat(a, "dmax", 28f));
                break;
            case "spawn":
                SpawnEnemy(player, a);
                break;
            case "die":
                if (!player.IsDead)
                {
                    expectDeath = true;
                    Game.TimeScale = 1f;
                    player.Kill();
                }
                break;
            case "clear":
                foreach (Enemy en in enemies) if (en.Ped != null && en.Ped.Exists()) en.Ped.Delete();
                enemies.Clear();
                break;
            case "killall":
                Nuke(player);
                break;
            case "airstrike":
                Airstrike(player, GetInt(a, "n", 5));
                break;
            case "slowmo":
                Game.TimeScale = 0.35f;
                slowmoUntil = Game.GameTime + (int)(GetFloat(a, "s", 5f) * 1000f);
                PostFx("SuccessNeutral", 1200);
                break;
            case "weapon":
                {
                    uint hash = (uint)Game.GenerateHash(Get(a, "w", "WEAPON_RPG"));
                    Function.Call(Hash.GIVE_WEAPON_TO_PED, player, hash, 500, false, true);
                    PostFx("SuccessFranklin", 1000);
                    break;
                }
            case "launch":
                if (!player.IsInVehicle())
                {
                    Function.Call(Hash.SET_PED_TO_RAGDOLL, player, 3000, 3000, 0, false, false, false);
                    player.Velocity = new Vector3(RandF(-6f, 6f), RandF(-6f, 6f), GetFloat(a, "f", 25f));
                }
                break;
            case "healfx":
                PostFx("SuccessMichael", 900);
                Particle("scr_rcbarry1", "scr_alien_teleport", player.Position, 1.0f);
                break;
        }
    }

    // ===================================================================
    // Enemies
    // ===================================================================
    private void SpawnEnemy(Ped player, Dictionary<string, string> a)
    {
        Vector3 pos = FindSpawnPoint(player);
        Model model = LoadModel(Get(a, "model", "s_m_y_swat_01"));
        if (model == null) return;

        Ped ped = World.CreatePed(model, pos, HeadingTo(pos, player.Position));
        model.MarkAsNoLongerNeeded();
        if (ped == null || !ped.Exists()) return;

        int hp = Math.Max(1, GetInt(a, "hp", 200));
        ped.MaxHealth = hp + 100; // peds die at 100
        ped.Health = hp + 100;
        ped.Armor = GetInt(a, "armor", 0);
        ped.Accuracy = Math.Max(0, Math.Min(100, GetInt(a, "acc", 30)));
        ped.RelationshipGroup = enemyGroup;
        ped.BlockPermanentEvents = true;
        ped.AlwaysKeepTask = true;

        string weapon = Get(a, "weapon", "WEAPON_UNARMED");
        if (weapon != "WEAPON_UNARMED")
        {
            uint hash = (uint)Game.GenerateHash(weapon);
            Function.Call(Hash.GIVE_WEAPON_TO_PED, ped, hash, 9999, false, true);
            Function.Call(Hash.SET_CURRENT_PED_WEAPON, ped, hash, true);
        }

        Function.Call(Hash.SET_PED_COMBAT_ABILITY, ped, 2);
        Function.Call(Hash.SET_PED_COMBAT_MOVEMENT, ped, 2);
        Function.Call(Hash.SET_PED_COMBAT_RANGE, ped, 1);
        Function.Call(Hash.SET_PED_COMBAT_ATTRIBUTES, ped, 46, true); // always fight
        Function.Call(Hash.SET_PED_COMBAT_ATTRIBUTES, ped, 5, true);  // fight armed peds when unarmed
        Function.Call(Hash.SET_PED_COMBAT_ATTRIBUTES, ped, 0, true);  // can use cover
        Function.Call(Hash.SET_PED_FLEE_ATTRIBUTES, ped, 0, false);
        Function.Call(Hash.SET_PED_SUFFERS_CRITICAL_HITS, ped, false);
        Function.Call(Hash.SET_PED_DROPS_WEAPONS_WHEN_DEAD, ped, false);
        ped.Task.FightAgainst(player);

        Particle("scr_rcbarry2", "scr_clown_appears", pos, 1.2f);

        Enemy en = new Enemy();
        en.Id = Get(a, "id", "");
        en.Ped = ped;
        en.DamageMult = Math.Max(0f, GetFloat(a, "dmg", 1f));
        en.Name = Get(a, "name", "Enemy");
        en.By = Get(a, "by", "");
        if (en.By.Length > 24) en.By = en.By.Substring(0, 24);
        en.TagColor = ParseColor(Get(a, "color", "#ffffff"));
        en.LastTaskAt = Game.GameTime;
        enemies.Add(en);
    }

    private Model LoadModel(string name)
    {
        Model m = new Model(name);
        if (!m.IsInCdImage || !m.IsValid || !m.IsPed)
        {
            m = new Model("s_m_y_swat_01"); // fallback so the stream never stalls
        }
        if (!m.Request(2000)) return null;
        return m;
    }

    private Vector3 FindSpawnPoint(Ped player)
    {
        Vector3 origin = player.Position;
        for (int attempt = 0; attempt < 6; attempt++)
        {
            float ang = RandF(0f, (float)(Math.PI * 2.0));
            float dist = RandF(spawnMin, spawnMax);
            Vector3 p = origin + new Vector3((float)Math.Cos(ang) * dist, (float)Math.Sin(ang) * dist, 0f);

            OutputArgument safe = new OutputArgument();
            if (Function.Call<bool>(Hash.GET_SAFE_COORD_FOR_PED, p.X, p.Y, p.Z + 2f, false, safe, 16))
            {
                Vector3 s = safe.GetResult<Vector3>();
                if (s.DistanceTo(origin) > 4f && s.DistanceTo(origin) < spawnMax + 25f) return s;
            }

            OutputArgument ground = new OutputArgument();
            if (Function.Call<bool>(Hash.GET_GROUND_Z_FOR_3D_COORD, p.X, p.Y, p.Z + 50f, ground, false, false))
            {
                float z = ground.GetResult<float>();
                if (Math.Abs(z - origin.Z) < 15f) return new Vector3(p.X, p.Y, z);
            }
        }
        return origin + new Vector3(RandF(-8f, 8f), RandF(-8f, 8f), 0f);
    }

    private void UpdateEnemies(Ped player)
    {
        int now = Game.GameTime;
        int alive = 0;
        for (int i = enemies.Count - 1; i >= 0; i--)
        {
            Enemy en = enemies[i];
            Ped p = en.Ped;
            if (p == null || !p.Exists())
            {
                enemies.RemoveAt(i);
                continue;
            }
            if (p.IsDead)
            {
                if (!en.CountedKill)
                {
                    en.CountedKill = true;
                    en.DiedAt = now;
                    lock (sync) { outKills++; }
                }
                else if (now - en.DiedAt > CorpseSeconds * 1000)
                {
                    p.Delete();
                    enemies.RemoveAt(i);
                }
                continue;
            }

            alive++;

            if (!player.IsDead)
            {
                if (p.Position.DistanceTo(player.Position) > LeashDistance)
                {
                    p.Position = FindSpawnPoint(player);
                    p.Task.FightAgainst(player);
                    en.LastTaskAt = now;
                }
                else if (now - en.LastTaskAt > 4000)
                {
                    en.LastTaskAt = now;
                    if (!p.IsInCombatAgainst(player)) p.Task.FightAgainst(player);
                }
            }

            if (nameTags && en.By.Length > 0) DrawTag(p, en);
        }
        lock (sync) { outAlive = alive; }
    }

    private void DrawTag(Ped p, Enemy en)
    {
        // Head bone so the name sits right above tall models (Hulk, Bigfoot...) too.
        Vector3 head = p.Bones[Bone.SkelHead].Position;
        float dist = head.DistanceTo(GameplayCamera.Position);
        if (dist > TagMaxDistance) return;
        PointF screen = GTA.UI.Screen.WorldToScreen(head + new Vector3(0f, 0f, 0.42f));
        if (screen.X <= 0f && screen.Y <= 0f) return;
        float fov = 100f / Math.Max(1f, GameplayCamera.FieldOfView);
        float scale = Math.Max(0.32f, Math.Min(0.75f, (2.2f / Math.Max(0.5f, dist)) * fov * 0.55f));
        int alpha = dist > TagMaxDistance - 20f ? (int)(255f * (TagMaxDistance - dist) / 20f) : 255;
        Color c = Color.FromArgb(Math.Max(0, Math.Min(255, alpha)), en.TagColor);
        GTA.UI.TextElement t = new GTA.UI.TextElement(en.By, screen, scale, c, GTA.UI.Font.ChaletComprimeCologne, GTA.UI.Alignment.Center, true, true);
        t.Draw();
    }

    // "#a855f7" -> color, lightened a bit so names stay readable on dark scenes.
    private static Color ParseColor(string hex)
    {
        try
        {
            hex = hex.TrimStart('#');
            if (hex.Length == 3) hex = new string(new[] { hex[0], hex[0], hex[1], hex[1], hex[2], hex[2] });
            int r = Convert.ToInt32(hex.Substring(0, 2), 16), g = Convert.ToInt32(hex.Substring(2, 2), 16), b = Convert.ToInt32(hex.Substring(4, 2), 16);
            return Color.FromArgb(r + (255 - r) / 4, g + (255 - g) / 4, b + (255 - b) / 4);
        }
        catch (Exception) { return Color.White; }
    }

    private void Airstrike(Ped player, int count)
    {
        int done = 0;
        foreach (Enemy en in enemies)
        {
            if (done >= count) break;
            Ped p = en.Ped;
            if (p == null || !p.Exists() || p.IsDead) continue;
            Vector3 pos = p.Position;
            if (pos.DistanceTo(player.Position) > 9f)
            {
                Function.Call(Hash.ADD_EXPLOSION, pos.X, pos.Y, pos.Z, 4, 1.0f, true, false, 0.6f, false);
            }
            else
            {
                Particle("scr_rcbarry2", "scr_clown_death", pos, 1.5f);
            }
            p.Kill();
            done++;
        }
        PostFx("ExplosionJosh3", 800);
    }

    private void Nuke(Ped player)
    {
        foreach (Enemy en in enemies)
        {
            Ped p = en.Ped;
            if (p == null || !p.Exists() || p.IsDead) continue;
            Vector3 pos = p.Position;
            if (pos.DistanceTo(player.Position) > 9f)
                Function.Call(Hash.ADD_EXPLOSION, pos.X, pos.Y, pos.Z, 7, 1.0f, true, false, 0.4f, false);
            else
                Particle("scr_rcbarry2", "scr_clown_death", pos, 1.5f);
            p.Kill();
        }
        Function.Call(Hash.SHAKE_GAMEPLAY_CAM, "LARGE_EXPLOSION_SHAKE", 1.0f);
        PostFx("ExplosionJosh3", 1500);
    }

    // ===================================================================
    // Helpers
    // ===================================================================
    private static void PostFx(string name, int ms)
    {
        Function.Call(Hash.ANIMPOSTFX_PLAY, name, ms, false);
    }

    private static void Particle(string asset, string fx, Vector3 pos, float scale)
    {
        Function.Call(Hash.REQUEST_NAMED_PTFX_ASSET, asset);
        if (!Function.Call<bool>(Hash.HAS_NAMED_PTFX_ASSET_LOADED, asset)) return; // ready next time
        Function.Call(Hash.USE_PARTICLE_FX_ASSET, asset);
        Function.Call(Hash.START_PARTICLE_FX_NON_LOOPED_AT_COORD, fx, pos.X, pos.Y, pos.Z, 0f, 0f, 0f, scale, false, false, false);
    }

    private static float HeadingTo(Vector3 from, Vector3 to)
    {
        float dx = to.X - from.X, dy = to.Y - from.Y;
        float h = (float)(Math.Atan2(dy, dx) * 180.0 / Math.PI) - 90f;
        return h < 0 ? h + 360f : h;
    }

    private float RandF(float min, float max) { return min + (float)rng.NextDouble() * (max - min); }

    private static string Get(Dictionary<string, string> a, string k, string d) { string v; return a.TryGetValue(k, out v) ? v : d; }

    private static int GetInt(Dictionary<string, string> a, string k, int d)
    {
        int v; return int.TryParse(Get(a, k, ""), System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out v) ? v : d;
    }

    private static float GetFloat(Dictionary<string, string> a, string k, float d)
    {
        float v; return float.TryParse(Get(a, k, ""), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out v) ? v : d;
    }
}
