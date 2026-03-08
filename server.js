// ============================================================
//  ARCH SERVER — PostgreSQL version
//  Lance avec : node server.js
// ============================================================

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { WebSocketServer } = require('ws');

// ============================================================
//  CONFIG
// ============================================================
const CONFIG = {
  port:         process.env.PORT || 3000,
  currency:     'ARCH',
  scanInterval: 30,
  scanDuration: 25,
  claimWindow:  5,
  adminPass:    process.env.ADMIN_PASS || 'CHANGE_MOI',
  discordClientId:     process.env.DISCORD_CLIENT_ID     || '1480061734847779060',
  discordClientSecret: process.env.DISCORD_CLIENT_SECRET || 'REMPLACE_PAR_TON_NOUVEAU_SECRET',
};

// ============================================================
//  POSTGRESQL
// ============================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function query(sql, params = []) {
  const client = await pool.connect();
  try { return await client.query(sql, params); }
  finally { client.release(); }
}

// ============================================================
//  XP & LEVELS
// ============================================================
function xpForLevel(lvl) { return Math.floor(100 * Math.pow(lvl, 1.6)); }
function levelFromXp(totalXp) {
  let lvl = 1, acc = 0;
  while (lvl < 100) {
    const need = xpForLevel(lvl);
    if (acc + need > totalXp) break;
    acc += need; lvl++;
  }
  const need = xpForLevel(lvl);
  return { level: lvl, xpInLevel: totalXp - acc, xpForNext: need };
}
const XP_TABLE = {
  scan:5, claim:12, expire_auto:3,
  coinflip_win:6, coinflip_lose:3,
  dice_win:6, dice_lose:3,
  slots_win:8, slots_lose:4, slots_bonus:15,
  bj_win:10, bj_lose:5, bj_bust:4,
  mines_cashout:10, mines_lose:4,
  crash_win:8, crash_lose:4,
  plinko_win:7, plinko_lose:3,
  roulette_win:8, roulette_lose:4,
  keno_win:8, keno_lose:4,
  poker_win:10, poker_lose:5,
  scratch_win:6, scratch_lose:3,
  tower_cashout:10, tower_lose:4,
};
async function addXp(username, action) {
  const base = XP_TABLE[action] || 3;
  const perkRow = await query("SELECT level FROM player_perks WHERE username=$1 AND perk_id='xp_boost'", [username]).catch(()=>({rows:[]}));
  const mult = perkRow.rows.length ? 1 + perkRow.rows[0].level * 0.5 : 1;
  const xp = Math.round(base * mult);
  await query('UPDATE users SET xp = xp + $1 WHERE username = $2', [xp, username]);
  return xp;
}

// ============================================================
//  PERKS CATALOG
// ============================================================
const PERKS = {
  scan_speed:   { id:'scan_speed',   name:'SCAN TURBO',    cat:'mining',   maxLvl:5, desc:'Cooldown scan -4s/lvl',            baseCost:0.5,  mult:2.2 },
  mining_boost: { id:'mining_boost', name:'MINING BOOST',  cat:'mining',   maxLvl:5, desc:'Reward scan +15%/lvl',             baseCost:1.0,  mult:2.5 },
  double_claim: { id:'double_claim', name:'DOUBLE CLAIM',  cat:'mining',   maxLvl:3, desc:'10% chance doubler claim/lvl',     baseCost:2.0,  mult:3.0 },
  xp_boost:     { id:'xp_boost',     name:'XP BOOST',      cat:'games',    maxLvl:3, desc:'+50% XP par partie/lvl',           baseCost:0.8,  mult:2.0 },
  cashback:     { id:'cashback',      name:'CASHBACK',      cat:'games',    maxLvl:4, desc:'2% remboursé sur les pertes/lvl',  baseCost:1.5,  mult:2.8 },
  lucky_spin:   { id:'lucky_spin',   name:'LUCKY SPIN',    cat:'games',    maxLvl:3, desc:'+5% sur tous les multiplicateurs', baseCost:3.0,  mult:3.5 },
  plinko_edge:  { id:'plinko_edge',  name:'PLINKO EDGE',   cat:'games',    maxLvl:3, desc:'House edge Plinko -1%/lvl',        baseCost:2.0,  mult:3.0 },
  tower_shield: { id:'tower_shield', name:'TOWER SHIELD',  cat:'games',    maxLvl:2, desc:'1 vie bonus en Tower/lvl',         baseCost:4.0,  mult:4.0 },
  title_hunter: { id:'title_hunter', name:'[HUNTER]',      cat:'cosmetic', maxLvl:1, desc:'Badge exclusif sur ton profil',    baseCost:0.3,  mult:1   },
  title_whale:  { id:'title_whale',  name:'[WHALE]',       cat:'cosmetic', maxLvl:1, desc:'Badge pour les grosses mises',     baseCost:5.0,  mult:1   },
  title_ghost:  { id:'title_ghost',  name:'[GHOST]',       cat:'cosmetic', maxLvl:1, desc:'Badge mystère',                    baseCost:2.0,  mult:1   },
};
function perkCost(id, curLvl) {
  const p = PERKS[id]; if (!p) return null;
  return parseFloat((p.baseCost * Math.pow(p.mult, curLvl)).toFixed(6));
}
async function getUserPerks(username) {
  const r = await query('SELECT perk_id, level FROM player_perks WHERE username=$1', [username]).catch(()=>({rows:[]}));
  const map = {}; r.rows.forEach(row => { map[row.perk_id] = row.level; }); return map;
}

// Apply cashback perk on a loss, returns extra ARCH credited
async function applyCashback(username, lostAmt, perks) {
  if (!perks['cashback'] || lostAmt <= 0) return 0;
  const cb = parseFloat((lostAmt * perks['cashback'] * 0.02).toFixed(6));
  if (cb > 0) {
    await query('UPDATE users SET balance = balance + $1 WHERE username = $2', [cb, username]);
    await addHistory(username, cb, 'cashback');
  }
  return cb;
}

// Apply lucky_spin mult boost (returns multiplied value)
function applyLuckyMult(mult, perks) {
  if (!perks['lucky_spin'] || mult <= 0) return mult;
  return parseFloat((mult * (1 + perks['lucky_spin'] * 0.05)).toFixed(4));
}

// ============================================================
//  DISCORD ACTIVITY
// ============================================================
async function discordTokenExchange(code) {
  const params = new URLSearchParams({ client_id: CONFIG.discordClientId, client_secret: CONFIG.discordClientSecret, grant_type: "authorization_code", code });
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: "discord.com", path: "/api/oauth2/token", method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" } }, res => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } }); });
    req.on("error", reject); req.write(params.toString()); req.end();
  });
}
async function getOrCreateDiscordUser(discordId, discordName, discordAvatar) {
  const archUsername = "discord_" + discordId;
  const archPassword = crypto.createHash("sha256").update(discordId + "arch_discord_s4lt").digest("hex");
  const hashed = crypto.createHash("sha256").update(archPassword + "arch_s4lt").digest("hex");
  await query("INSERT INTO users (username, password) VALUES ($1, $2) ON CONFLICT (username) DO NOTHING", [archUsername, hashed]);
  await query("INSERT INTO discord_users (discord_id, arch_user, display_name, avatar) VALUES ($1, $2, $3, $4) ON CONFLICT (discord_id) DO UPDATE SET display_name=$3, avatar=$4", [discordId, archUsername, discordName, discordAvatar]).catch(()=>{});
  const token = mktoken();
  await query("INSERT INTO sessions (token, username) VALUES ($1, $2)", [token, archUsername]);
  const u = await query("SELECT balance, xp FROM users WHERE username=$1", [archUsername]);
  const lvl = levelFromXp(u.rows[0]?.xp || 0);
  return { token, balance: u.rows[0]?.balance || 0, level: lvl.level, username: archUsername };
}
const wsClients = new Map();
function wsBroadcastPlayerList() {
  const players = {};
  wsClients.forEach((c) => { if (c.discordId) players[c.discordId] = { displayName: c.displayName, avatar: c.avatar, balance: c.balance||0, status: c.status||"idle", last: c.last||null }; });
  const msg = JSON.stringify({ type: "player_list", players });
  wsClients.forEach(c => { try { if (c.ws.readyState === 1) c.ws.send(msg); } catch {} });
}
function wsBroadcastEvent(data, excludeToken) {
  const msg = JSON.stringify(data);
  wsClients.forEach((c, tok) => { if (tok !== excludeToken) try { if (c.ws.readyState === 1) c.ws.send(msg); } catch {} });
}
async function initDiscordDB() {
  await query("CREATE TABLE IF NOT EXISTS discord_users (discord_id TEXT PRIMARY KEY, arch_user TEXT NOT NULL, display_name TEXT, avatar TEXT, updated_at TEXT DEFAULT now()::text)");
}

async function initDB() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      username      TEXT PRIMARY KEY,
      password      TEXT NOT NULL,
      balance       DOUBLE PRECISION DEFAULT 0,
      total_earned  DOUBLE PRECISION DEFAULT 0,
      scans         INTEGER DEFAULT 0,
      claims        INTEGER DEFAULT 0,
      last_scan     BIGINT DEFAULT 0,
      xp            INTEGER DEFAULT 0,
      created_at    TEXT DEFAULT now()::text
    )
  `);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS xp INTEGER DEFAULT 0`).catch(()=>{});
  await query(`
    CREATE TABLE IF NOT EXISTS player_perks (
      username  TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      perk_id   TEXT NOT NULL,
      level     INTEGER DEFAULT 1,
      bought_at TEXT DEFAULT now()::text,
      PRIMARY KEY (username, perk_id)
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      username   TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      created_at BIGINT DEFAULT extract(epoch from now())::bigint
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS pending_claims (
      username   TEXT PRIMARY KEY REFERENCES users(username) ON DELETE CASCADE,
      reward     DOUBLE PRECISION NOT NULL,
      expires_at BIGINT NOT NULL
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS history (
      id         SERIAL PRIMARY KEY,
      username   TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      amount     DOUBLE PRECISION NOT NULL,
      reason     TEXT DEFAULT '',
      auto       BOOLEAN DEFAULT false,
      created_at TEXT DEFAULT now()::text
    )
  `);
  console.log('[DB] Tables PostgreSQL prêtes.');
}

// ============================================================
//  GÉNÉRATEUR DE RÉCOMPENSE
// ============================================================
function generateReward() {
  const r = Math.random();
  if (r < 0.60)    return parseFloat((Math.random() * 0.000999 + 0.000001).toFixed(6));
  if (r < 0.85)    return parseFloat((Math.random() * 0.008999 + 0.001).toFixed(6));
  if (r < 0.96)    return parseFloat((Math.random() * 0.089999 + 0.01).toFixed(6));
  if (r < 0.995)   return parseFloat((Math.random() * 0.899999 + 0.1).toFixed(6));
  if (r < 0.9995)  return parseFloat((Math.random() * 3.999999 + 1.0).toFixed(6));
  return parseFloat((Math.random() * 4.999999 + 5.0).toFixed(6));
}

// ============================================================
//  UTILS
// ============================================================
function hash(pass) { return crypto.createHash('sha256').update(pass + 'arch_s4lt').digest('hex'); }
function mktoken()  { return crypto.randomBytes(32).toString('hex'); }

async function getUser(tk) {
  if (!tk) return null;
  const s = await query('SELECT username FROM sessions WHERE token = $1', [tk]);
  if (!s.rows.length) return null;
  const u = await query('SELECT * FROM users WHERE username = $1', [s.rows[0].username]);
  return u.rows[0] || null;
}

async function addHistory(username, amount, reason = '', auto = false) {
  await query(
    'INSERT INTO history (username, amount, reason, auto) VALUES ($1, $2, $3, $4)',
    [username, amount, reason, auto]
  );
  await query(`
    DELETE FROM history WHERE id IN (
      SELECT id FROM history WHERE username = $1 ORDER BY id DESC OFFSET 100
    )
  `, [username]);
}

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type':                 'application/json',
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(JSON.stringify(data));
}

function body(req) {
  return new Promise(resolve => {
    let s = '';
    req.on('data', c => s += c);
    req.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve({}); } });
  });
}

// ============================================================
//  NETTOYAGE CLAIMS EXPIRÉS
// ============================================================
setInterval(async () => {
  try {
    const expired = await query('SELECT * FROM pending_claims WHERE expires_at < $1', [Date.now()]);
    for (const claim of expired.rows) {
      const half = parseFloat((claim.reward / 2).toFixed(6));
      await query('UPDATE users SET balance = balance + $1, total_earned = total_earned + $1 WHERE username = $2', [half, claim.username]);
      await addHistory(claim.username, half, 'auto_expire', true);
      await query('DELETE FROM pending_claims WHERE username = $1', [claim.username]);
      console.log(`[EXPIRE] ${claim.username} → +${half} ARCH`);
    }
  } catch(e) { console.error('[EXPIRE ERR]', e.message); }
}, 3000);

// ============================================================
//  API
// ============================================================
async function api(req, res) {
  const url      = new URL(req.url, 'http://localhost');
  // Discord proxy strip le préfixe /api — on normalise
  const rawPath  = url.pathname;
  const endpoint = rawPath.startsWith('/api') ? rawPath : '/api' + rawPath;
  const tk       = (req.headers['authorization'] || '').replace('Bearer ', '');

  // REGISTER
  if (endpoint === '/api/register' && req.method === 'POST') {
    const { username, password } = await body(req);
    if (!username || !password || username.length < 3 || password.length < 4)
      return json(res, 400, { error: 'Pseudo (3+ chars) et mot de passe (4+ chars) requis.' });
    const exists = await query('SELECT 1 FROM users WHERE username = $1', [username]);
    if (exists.rows.length) return json(res, 400, { error: 'Pseudo déjà pris.' });
    await query('INSERT INTO users (username, password) VALUES ($1, $2)', [username, hash(password)]);
    console.log(`[REGISTER] ${username}`);
    return json(res, 200, { ok: true });
  }

  // LOGIN
  if (endpoint === '/api/login' && req.method === 'POST') {
    const { username, password } = await body(req);
    const u = await query('SELECT * FROM users WHERE username = $1', [username]);
    if (!u.rows.length || u.rows[0].password !== hash(password))
      return json(res, 401, { error: 'Identifiants incorrects.' });
    const tok = mktoken();
    await query('INSERT INTO sessions (token, username) VALUES ($1, $2)', [tok, username]);
    console.log(`[LOGIN] ${username}`);
    return json(res, 200, { ok: true, token: tok, username });
  }

  // SCAN
  if (endpoint === '/api/scan' && req.method === 'POST') {
    const user = await getUser(tk);
    if (!user) return json(res, 401, { error: 'Non connecté.' });
    const now     = Date.now();
    const elapsed = (now - Number(user.last_scan)) / 1000;
    if (elapsed < CONFIG.scanInterval - 2) {
      return json(res, 429, { error: `Attends encore ${Math.ceil(CONFIG.scanInterval - elapsed)}s.`, wait: Math.ceil(CONFIG.scanInterval - elapsed) });
    }
    const reward = generateReward();
    await query('UPDATE users SET last_scan = $1, scans = scans + 1 WHERE username = $2', [now, user.username]);
    const expiresAt = now + (CONFIG.scanDuration + CONFIG.claimWindow) * 1000;
    await query(
      'INSERT INTO pending_claims (username, reward, expires_at) VALUES ($1, $2, $3) ON CONFLICT (username) DO UPDATE SET reward = $2, expires_at = $3',
      [user.username, reward, expiresAt]
    );
    const xpGained = await addXp(user.username, 'scan');
    console.log(`[SCAN] ${user.username} → ${reward} ARCH +${xpGained}xp`);
    return json(res, 200, { ok: true, reward, scan_duration: CONFIG.scanDuration, claim_window: CONFIG.claimWindow, xp_gained: xpGained });
  }

  // CLAIM
  if (endpoint === '/api/claim' && req.method === 'POST') {
    const user = await getUser(tk);
    if (!user) return json(res, 401, { error: 'Non connecté.' });
    const c = await query('SELECT * FROM pending_claims WHERE username = $1', [user.username]);
    if (!c.rows.length) return json(res, 400, { error: 'Rien à claim.' });
    const claim = c.rows[0];
    if (Date.now() > Number(claim.expires_at)) {
      await query('DELETE FROM pending_claims WHERE username = $1', [user.username]);
      return json(res, 400, { error: 'Trop tard — reward expirée.' });
    }
    const perks = await getUserPerks(user.username);
    let finalReward = claim.reward;
    // mining_boost perk
    if (perks['mining_boost']) finalReward = parseFloat((finalReward * (1 + perks['mining_boost'] * 0.15)).toFixed(6));
    // double_claim perk
    if (perks['double_claim'] && Math.random() < perks['double_claim'] * 0.10) finalReward = parseFloat((finalReward * 2).toFixed(6));
    await query('UPDATE users SET balance = balance + $1, total_earned = total_earned + $1, claims = claims + 1 WHERE username = $2', [finalReward, user.username]);
    await addHistory(user.username, finalReward, 'claim');
    await query('DELETE FROM pending_claims WHERE username = $1', [user.username]);
    const xpGained = await addXp(user.username, 'claim');
    const updated = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
    console.log(`[CLAIM] ${user.username} → +${finalReward} ARCH +${xpGained}xp`);
    return json(res, 200, { ok: true, reward: finalReward, balance: updated.rows[0].balance, xp_gained: xpGained });
  }

  // EXPIRE
  if (endpoint === '/api/expire' && req.method === 'POST') {
    const user = await getUser(tk);
    if (!user) return json(res, 401, { error: 'Non connecté.' });
    const c = await query('SELECT * FROM pending_claims WHERE username = $1', [user.username]);
    if (!c.rows.length) return json(res, 200, { ok: true, reward: 0 });
    const half = parseFloat((c.rows[0].reward / 2).toFixed(6));
    await query('UPDATE users SET balance = balance + $1, total_earned = total_earned + $1 WHERE username = $2', [half, user.username]);
    await addHistory(user.username, half, 'expire_auto', true);
    await query('DELETE FROM pending_claims WHERE username = $1', [user.username]);
    const updated = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
    console.log(`[EXPIRE] ${user.username} → +${half} ARCH`);
    return json(res, 200, { ok: true, reward: half, balance: updated.rows[0].balance });
  }

  // ME
  if (endpoint === '/api/me' && req.method === 'GET') {
    const user = await getUser(tk);
    if (!user) return json(res, 401, { error: 'Non connecté.' });
    const claim = await query('SELECT * FROM pending_claims WHERE username = $1', [user.username]);
    const hist  = await query('SELECT amount, reason, auto, created_at FROM history WHERE username = $1 ORDER BY id DESC LIMIT 20', [user.username]);
    const perks = await getUserPerks(user.username);
    const lvlData = levelFromXp(user.xp || 0);
    // Compute effective scan interval with scan_speed perk
    const scanReduction = perks['scan_speed'] ? perks['scan_speed'] * 4 : 0;
    const effectiveScanInterval = Math.max(8, CONFIG.scanInterval - scanReduction);
    return json(res, 200, {
      username:      user.username,
      balance:       user.balance,
      total_earned:  user.total_earned,
      scans:         user.scans,
      claims:        user.claims,
      xp:            user.xp || 0,
      level:         lvlData.level,
      xp_in_level:   lvlData.xpInLevel,
      xp_for_next:   lvlData.xpForNext,
      perks,
      history:       hist.rows.map(h => ({ amount: h.amount, at: h.created_at, auto: h.auto, reason: h.reason })),
      next_scan_in:  Math.max(0, Math.ceil(effectiveScanInterval - (Date.now() - Number(user.last_scan)) / 1000)),
      pending_claim: claim.rows.length ? { reward: claim.rows[0].reward, expires_at: Number(claim.rows[0].expires_at) } : null,
    });
  }

  // LEADERBOARD
  if (endpoint === '/api/leaderboard' && req.method === 'GET') {
    const board = await query('SELECT username, balance, scans, claims FROM users ORDER BY balance DESC LIMIT 10');
    return json(res, 200, { leaderboard: board.rows });
  }

  // TRANSFER (hub de jeux)
  if (endpoint === '/api/transfer' && req.method === 'POST') {
    const user = await getUser(tk);
    if (!user) return json(res, 401, { error: 'Non connecté.' });
    const { to, from, amount, reason } = await body(req);
    const amt = parseFloat(parseFloat(amount).toFixed(6));
    if (isNaN(amt) || amt <= 0) return json(res, 400, { error: 'Montant invalide.' });

    if (to === '__house__') {
      if (user.balance < amt) return json(res, 400, { error: 'Solde insuffisant.' });
      await query('UPDATE users SET balance = balance - $1 WHERE username = $2', [amt, user.username]);
      await addHistory(user.username, -amt, reason || 'game');
      const updated = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
      console.log(`[TRANSFER] ${user.username} → house -${amt} (${reason})`);
      return json(res, 200, { ok: true, balance: updated.rows[0].balance });
    }

    if (from === '__house__') {
      await query('UPDATE users SET balance = balance + $1, total_earned = total_earned + $1 WHERE username = $2', [amt, user.username]);
      await addHistory(user.username, amt, reason || 'game_win');
      const updated = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
      console.log(`[TRANSFER] house → ${user.username} +${amt} (${reason})`);
      return json(res, 200, { ok: true, balance: updated.rows[0].balance });
    }

    return json(res, 400, { error: 'Transfert non autorisé.' });
  }


  // GAME — COINFLIP (résultat serveur)
  if (endpoint === '/api/game/coinflip' && req.method === 'POST') {
    const user = await getUser(tk);
    if (!user) return json(res, 401, { error: 'Non connecté.' });
    const { choice, amount } = await body(req);
    const amt = parseFloat(parseFloat(amount).toFixed(6));
    if (!['PILE','FACE'].includes(choice)) return json(res, 400, { error: 'Choix invalide.' });
    if (isNaN(amt) || amt <= 0) return json(res, 400, { error: 'Montant invalide.' });
    if (user.balance < amt) return json(res, 400, { error: 'Solde insuffisant.' });

    const result = Math.random() < 0.5 ? 'PILE' : 'FACE';
    const won    = result === choice;

    if (won) {
      const gain = parseFloat((amt * 2).toFixed(6));
      await query('UPDATE users SET balance = balance + $1, total_earned = total_earned + $1 WHERE username = $2', [gain - amt, user.username]);
      await addHistory(user.username, gain - amt, 'coinflip_win');
    } else {
      await query('UPDATE users SET balance = balance - $1 WHERE username = $2', [amt, user.username]);
      await addHistory(user.username, -amt, 'coinflip_lose');
    }

    const perksC = await getUserPerks(user.username);
    let cbC = 0; if (!won) cbC = await applyCashback(user.username, amt, perksC);
    const xpC = await addXp(user.username, won ? 'coinflip_win' : 'coinflip_lose');
    const updatedC = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
    console.log(`[COINFLIP] ${user.username} → ${choice} vs ${result} — ${won ? '+' + amt.toFixed(6) : '-' + amt.toFixed(6)} ARCH +${xpC}xp`);
    return json(res, 200, { ok: true, result, won, balance: updatedC.rows[0].balance, xp_gained: xpC, cashback: cbC });
  }

  // GAME — DICE (résultat serveur)
  if (endpoint === '/api/game/dice' && req.method === 'POST') {
    const user = await getUser(tk);
    if (!user) return json(res, 401, { error: 'Non connecté.' });
    const { choice, amount } = await body(req);
    const choiceNum = parseInt(choice);
    const amt = parseFloat(parseFloat(amount).toFixed(6));
    if (isNaN(choiceNum) || choiceNum < 1 || choiceNum > 6) return json(res, 400, { error: 'Choix invalide.' });
    if (isNaN(amt) || amt <= 0) return json(res, 400, { error: 'Montant invalide.' });
    if (user.balance < amt) return json(res, 400, { error: 'Solde insuffisant.' });

    const rolled = Math.floor(Math.random() * 6) + 1;
    const won    = rolled === choiceNum;

    if (won) {
      const gain = parseFloat((amt * 5).toFixed(6));
      await query('UPDATE users SET balance = balance + $1, total_earned = total_earned + $1 WHERE username = $2', [gain - amt, user.username]);
      await addHistory(user.username, gain - amt, 'dice_win');
    } else {
      await query('UPDATE users SET balance = balance - $1 WHERE username = $2', [amt, user.username]);
      await addHistory(user.username, -amt, 'dice_lose');
    }

    const perksD = await getUserPerks(user.username);
    let cbD = 0; if (!won) cbD = await applyCashback(user.username, amt, perksD);
    const xpD = await addXp(user.username, won ? 'dice_win' : 'dice_lose');
    const updatedD = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
    console.log(`[DICE] ${user.username} → ${choiceNum} vs ${rolled} +${xpD}xp`);
    return json(res, 200, { ok: true, rolled, won, balance: updatedD.rows[0].balance, xp_gained: xpD, cashback: cbD });
  }

  // GAME — SLOTS (résultat serveur)
  if (endpoint === '/api/game/slots' && req.method === 'POST') {
    const user = await getUser(tk);
    if (!user) return json(res, 401, { error: 'Non connecté.' });
    const { amount } = await body(req);
    const amt = parseFloat(parseFloat(amount).toFixed(6));
    if (isNaN(amt) || amt <= 0) return json(res, 400, { error: 'Montant invalide.' });
    if (user.balance < amt) return json(res, 400, { error: 'Solde insuffisant.' });

    // ARCH scatter — uniquement rouleaux 0,2,4, weight 10 → ~3% de bonus par spin
    const SYMS = [
      { id: 0, name: 'ARCH',    weight: 10 },
      { id: 1, name: 'NODE',    weight: 12, payouts: [0,0,2,5,10]  },
      { id: 2, name: 'BLOCK',   weight: 18, payouts: [0,0,1.5,3,6] },
      { id: 3, name: 'CRYSTAL', weight: 14, payouts: [0,0,3,8,15]  },
      { id: 4, name: 'STAR',    weight: 10, payouts: [0,0,5,12,25] },
      { id: 5, name: 'DIAMOND', weight: 6,  payouts: [0,0,10,20,40]},
      { id: 6, name: 'VOID',    weight: 8,  payouts: [0,0,0.5,1,2] },
    ];

    // Pool par rouleau : ARCH uniquement sur 0,2,4
    function makePool(reelIdx) {
      return SYMS.flatMap(s => {
        if (s.id === 0 && ![0,2,4].includes(reelIdx)) return [];
        return Array(s.weight).fill(s);
      });
    }
    function spin(reelIdx) {
      const pool = makePool(reelIdx);
      // Génère 3 rangées visibles pour ce rouleau
      return Array.from({length:3}, () => {
        const s = pool[Math.floor(Math.random() * pool.length)];
        return { id: s.id, name: s.name };
      });
    }

    // grid[col][row] — 5 colonnes, 3 rangées
    const grid = [0,1,2,3,4].map(i => spin(i));

    // Bonus Hold & Spin : 3 ARCH sur rouleaux 0,2,4
    const archOnOddReels = [0,2,4].filter(col => grid[col].some(cell => cell.id === 0));
    const bonusTriggered = archOnOddReels.length === 3;
    const bonusReward = 0; // géré par hold-spin-end

    // Lignes de paiement : 5 lignes horizontales (rangées 0,1,2) + 2 diagonales
    const PAYLINES = [
      [0,1,2,3,4].map(c => ({c, r:0})), // ligne haut
      [0,1,2,3,4].map(c => ({c, r:1})), // ligne milieu
      [0,1,2,3,4].map(c => ({c, r:2})), // ligne bas
      [{c:0,r:0},{c:1,r:1},{c:2,r:2},{c:3,r:1},{c:4,r:0}], // V
      [{c:0,r:2},{c:1,r:1},{c:2,r:0},{c:3,r:1},{c:4,r:2}], // ^
    ];

    let totalMult = 0;
    const winLines = [];

    for (const line of PAYLINES) {
      // Compte le nombre de symboles identiques depuis la gauche
      const firstId = grid[line[0].c][line[0].r].id;
      if (firstId === 0) continue; // ARCH ne compte pas dans les lignes normales
      let count = 1;
      for (let i = 1; i < line.length; i++) {
        if (grid[line[i].c][line[i].r].id === firstId) count++;
        else break;
      }
      if (count >= 3) {
        const sym = SYMS.find(s => s.id === firstId);
        const payout = sym.payouts[count - 1] || 0;
        if (payout > 0) {
          totalMult += payout;
          winLines.push({ lineIdx: PAYLINES.indexOf(line), symId: firstId, count, payout });
        }
      }
    }

    const gain = parseFloat((amt * totalMult).toFixed(6));
    const netDelta = parseFloat((gain - amt + bonusReward).toFixed(6));

    await query('UPDATE users SET balance = balance - $1 WHERE username = $2', [amt, user.username]);
    if (gain > 0) {
      await query('UPDATE users SET balance = balance + $1, total_earned = total_earned + $1 WHERE username = $2', [gain, user.username]);
    }
    if (bonusReward > 0) {
      await query('UPDATE users SET balance = balance + $1, total_earned = total_earned + $1 WHERE username = $2', [bonusReward, user.username]);
      await addHistory(user.username, bonusReward, 'slots_bonus');
    }
    if (netDelta !== 0) await addHistory(user.username, netDelta, netDelta > 0 ? 'slots_win' : 'slots_lose');

    const perksS = await getUserPerks(user.username);
    let cbS = 0; if (netDelta < 0) cbS = await applyCashback(user.username, Math.abs(netDelta), perksS);
    const xpS = await addXp(user.username, bonusTriggered ? 'slots_bonus' : netDelta > 0 ? 'slots_win' : 'slots_lose');
    const updated = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
    console.log(`[SLOTS5x3] ${user.username} mult:${totalMult} lines:${winLines.length} bonus:${bonusReward} +${xpS}xp`);
    return json(res, 200, { ok: true, grid, winLines, totalMult, netDelta, bonusTriggered, bonusReward, balance: updated.rows[0].balance, xp_gained: xpS, cashback: cbS });
  }

  // GAME — SLOTS BONUS WHEEL (legacy)
  if (endpoint === '/api/game/slots-bonus' && req.method === 'POST') {
    const user = await getUser(tk);
    if (!user) return json(res, 401, { error: 'Non connecté.' });
    const { reward } = await body(req);
    return json(res, 200, { ok: true, reward: parseFloat(reward) });
  }

  // GAME — HOLD & SPIN : génère 0-3 nouvelles cases pour un spin bonus
  if (endpoint === '/api/game/hold-spin' && req.method === 'POST') {
    const user = await getUser(tk);
    if (!user) return json(res, 401, { error: 'Non connecté.' });
    const { stake, occupied } = await body(req);
    if (!stake || stake <= 0) return json(res, 400, { error: 'Mise invalide.' });
    const freePos = Array.from({length:15}, (_,i) => i).filter(i => !occupied.includes(i));
    const newCells = [];
    if (freePos.length > 0) {
      // Probabilité par case libre : ~20% de chance qu'un logo apparaisse sur cette case
      // En moyenne 0-3 logos par spin selon les cases restantes
      const pool = [...freePos];
      for (const pos of pool) {
        if (Math.random() < 0.20) { // 20% par case libre
          // Valeur du logo : distribution équilibrée 0.2× à 10× mise
          const r = Math.random();
          let val;
          if      (r < 0.45) val = parseFloat((stake * (0.2 + Math.random() * 0.8)).toFixed(6)); // 45% → 0.2-1×
          else if (r < 0.75) val = parseFloat((stake * (1   + Math.random() * 2  )).toFixed(6)); // 30% → 1-3×
          else if (r < 0.92) val = parseFloat((stake * (3   + Math.random() * 4  )).toFixed(6)); // 17% → 3-7×
          else if (r < 0.99) val = parseFloat((stake * (7   + Math.random() * 3  )).toFixed(6)); // 7%  → 7-10×
          else               val = parseFloat((stake * (10  + Math.random() * 40 )).toFixed(6)); // 1%  → 10-50× (jackpot)
          newCells.push({ pos, val });
          if (newCells.length >= 3) break; // max 3 par spin
        }
      }
    }
    return json(res, 200, { ok: true, newCells });
  }

  // GAME — HOLD & SPIN FIN : crédite le reward final
  if (endpoint === '/api/game/hold-spin-end' && req.method === 'POST') {
    const user = await getUser(tk);
    if (!user) return json(res, 401, { error: 'Non connecté.' });
    const { stake, cells, fullGrid } = await body(req);
    const baseReward = parseFloat(cells.reduce((s, c) => s + c.val, 0).toFixed(6));
    let finalReward = baseReward;
    let multiplier = 1;
    if (fullGrid && cells.length === 15) {
      const r = Math.random();
      if      (r < 0.35) multiplier = 2;
      else if (r < 0.60) multiplier = 5;
      else if (r < 0.78) multiplier = 10;
      else if (r < 0.90) multiplier = 25;
      else if (r < 0.97) multiplier = 50;
      else if (r < 0.995)multiplier = 100;
      else               multiplier = 1000;
      finalReward = parseFloat((baseReward * multiplier).toFixed(6));
    }
    if (finalReward > 0) {
      await query('UPDATE users SET balance = balance + $1, total_earned = total_earned + $1 WHERE username = $2', [finalReward, user.username]);
      await addHistory(user.username, finalReward, 'hold_spin_bonus');
    }
    const xpS = await addXp(user.username, 'slots_bonus');
    const updated = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
    console.log(`[HOLD&SPIN] ${user.username} cells:${cells.length} base:${baseReward} mult:${multiplier}x final:${finalReward}`);
    return json(res, 200, { ok: true, baseReward, multiplier, finalReward, balance: updated.rows[0].balance, xp_gained: xpS });
  }

  // GAME — FEATURE BUY (50× mise totale)
  if (endpoint === '/api/game/bonus-buyin' && req.method === 'POST') {
    const user = await getUser(tk);
    if (!user) return json(res, 401, { error: 'Non connecté.' });
    const { totalStake } = await body(req);
    if (!totalStake || totalStake <= 0) return json(res, 400, { error: 'Mise invalide.' });
    const BUY_IN = parseFloat((totalStake * 50).toFixed(6));
    if (user.balance < BUY_IN) return json(res, 400, { error: `Solde insuffisant. Coût : ${BUY_IN} ARCH.` });
    await query('UPDATE users SET balance = balance - $1 WHERE username = $2', [BUY_IN, user.username]);
    await addHistory(user.username, -BUY_IN, 'feature_buy');
    const updated = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
    return json(res, 200, { ok: true, balance: updated.rows[0].balance });
  }

  // GAME — BLACKJACK (résultat serveur)
  if (endpoint === '/api/game/blackjack' && req.method === 'POST') {
    const user = await getUser(tk);
    if (!user) return json(res, 401, { error: 'Non connecté.' });
    const { action, amount, gameState } = await body(req);
    const amt = parseFloat(parseFloat(amount || 0).toFixed(6));

    function deck() {
      const suits = ['♠','♥','♦','♣'], vals = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
      const d = suits.flatMap(s => vals.map(v => ({ v, s })));
      for (let i = d.length-1; i > 0; i--) { const j = Math.floor(Math.random()*(i+1)); [d[i],d[j]]=[d[j],d[i]]; }
      return d;
    }
    function cardVal(c) { return ['J','Q','K'].includes(c.v) ? 10 : c.v === 'A' ? 11 : parseInt(c.v); }
    function handScore(hand) {
      let s = hand.reduce((a,c) => a + cardVal(c), 0), aces = hand.filter(c => c.v==='A').length;
      while (s > 21 && aces-- > 0) s -= 10;
      return s;
    }

    if (action === 'deal') {
      if (isNaN(amt) || amt <= 0) return json(res, 400, { error: 'Montant invalide.' });
      if (user.balance < amt) return json(res, 400, { error: 'Solde insuffisant.' });
      await query('UPDATE users SET balance = balance - $1 WHERE username = $2', [amt, user.username]);
      const d = deck();
      const playerHand = [d.pop(), d.pop()];
      const dealerHand = [d.pop(), d.pop()];
      const ps = handScore(playerHand), ds = handScore(dealerHand);
      let status = 'playing';
      if (ps === 21) status = 'blackjack';
      const updated = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
      return json(res, 200, { ok: true, playerHand, dealerHand: [dealerHand[0], {v:'?',s:'?'}], dealerFull: dealerHand, deck: d, status, playerScore: ps, balance: updated.rows[0].balance });
    }

    if (action === 'hit' || action === 'stand' || action === 'double') {
      if (!gameState) return json(res, 400, { error: 'gameState manquant.' });
      let { playerHand, dealerFull, deck: d, bet } = gameState;
      const betAmt = parseFloat(parseFloat(bet).toFixed(6));

      if (action === 'hit') {
        playerHand.push(d.pop());
        const ps = handScore(playerHand);
        if (ps > 21) {
          await addHistory(user.username, -betAmt, 'bj_bust');
          const updated = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
          return json(res, 200, { ok: true, status: 'bust', playerHand, dealerHand: dealerFull, playerScore: ps, dealerScore: handScore(dealerFull), balance: updated.rows[0].balance });
        }
        return json(res, 200, { ok: true, status: 'playing', playerHand, dealerHand: [dealerFull[0], {v:'?',s:'?'}], dealerFull, deck: d, playerScore: ps, balance: gameState.balance });
      }

      if (action === 'double') {
        if (user.balance < betAmt) return json(res, 400, { error: 'Solde insuffisant pour doubler.' });
        await query('UPDATE users SET balance = balance - $1 WHERE username = $2', [betAmt, user.username]);
        playerHand.push(d.pop()); bet = betAmt * 2;
      }

      // Stand ou Double → dealer joue
      let dHand = dealerFull;
      while (handScore(dHand) < 17) dHand.push(d.pop());
      const ps = handScore(playerHand), ds = handScore(dHand);
      const finalBet = parseFloat(parseFloat(bet).toFixed(6));

      let result, delta;
      if (ps > 21)                        { result = 'bust';   delta = -finalBet; }
      else if (ds > 21 || ps > ds)        { result = 'win';    delta = finalBet; }
      else if (ps === ds)                 { result = 'push';   delta = 0; }
      else                               { result = 'lose';   delta = -finalBet; }

      if (result === 'win')  { await query('UPDATE users SET balance = balance + $1, total_earned = total_earned + $1 WHERE username = $2', [finalBet * 2, user.username]); }
      else if (result === 'push') { await query('UPDATE users SET balance = balance + $1 WHERE username = $2', [finalBet, user.username]); }

      if (delta !== 0) await addHistory(user.username, delta, 'bj_' + result);
      const updated = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
      return json(res, 200, { ok: true, status: result, playerHand, dealerHand: dHand, playerScore: ps, dealerScore: ds, delta, balance: updated.rows[0].balance });
    }

    return json(res, 400, { error: 'Action inconnue.' });
  }

  // GAME — MINES
  if (endpoint === '/api/game/mines' && req.method === 'POST') {
    const user = await getUser(tk);
    if (!user) return json(res, 401, { error: 'Non connecté.' });
    const { action, amount, mines: mineCount, revealed, minePositions } = await body(req);

    if (action === 'start') {
      const amt = parseFloat(parseFloat(amount).toFixed(6));
      const mc = parseInt(mineCount) || 3;
      if (isNaN(amt) || amt <= 0) return json(res, 400, { error: 'Montant invalide.' });
      if (mc < 1 || mc > 20) return json(res, 400, { error: 'Nombre de mines invalide (1-20).' });
      if (user.balance < amt) return json(res, 400, { error: 'Solde insuffisant.' });
      await query('UPDATE users SET balance = balance - $1 WHERE username = $2', [amt, user.username]);
      const positions = [];
      while (positions.length < mc) {
        const p = Math.floor(Math.random() * 25);
        if (!positions.includes(p)) positions.push(p);
      }
      const updated = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
      return json(res, 200, { ok: true, minePositions: positions, balance: updated.rows[0].balance });
    }

    if (action === 'cashout') {
      const amt = parseFloat(parseFloat(amount).toFixed(6));
      const safe = parseInt(revealed) || 0;
      const mc = parseInt(mineCount) || 3;
      if (safe <= 0) return json(res, 400, { error: 'Aucune case révélée.' });
      // Multiplicateur basé sur cases sûres révélées
      let mult = 1;
      for (let i = 0; i < safe; i++) mult *= (25 - mc - i) / (25 - i) * (1 / (1 - mc/25));
      mult = Math.max(1.05, parseFloat((mult * 0.97).toFixed(4))); // house edge 3%
      const gain = parseFloat((amt * mult).toFixed(6));
      await query('UPDATE users SET balance = balance + $1, total_earned = total_earned + $1 WHERE username = $2', [gain, user.username]);
      await addHistory(user.username, gain - amt, 'mines_cashout');
      const perksMc = await getUserPerks(user.username);
      const xpMc = await addXp(user.username, 'mines_cashout');
      const updated = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
      console.log(`[MINES] ${user.username} cashout safe:${safe} mult:${mult} +${gain} +${xpMc}xp`);
      return json(res, 200, { ok: true, gain, mult, balance: updated.rows[0].balance, xp_gained: xpMc });
    }

    if (action === 'lose') {
      const amt = parseFloat(parseFloat(amount).toFixed(6));
      await addHistory(user.username, -amt, 'mines_lose');
      const perksMl = await getUserPerks(user.username);
      const cbMl = await applyCashback(user.username, amt, perksMl);
      const xpMl = await addXp(user.username, 'mines_lose');
      const updated = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
      return json(res, 200, { ok: true, balance: updated.rows[0].balance, xp_gained: xpMl, cashback: cbMl });
    }

    return json(res, 400, { error: 'Action inconnue.' });
  }

  // GAME — CRASH
  if (endpoint === '/api/game/crash' && req.method === 'POST') {
    const user = await getUser(tk);
    if (!user) return json(res, 401, { error: 'Non connecté.' });
    const { action, amount, cashoutAt } = await body(req);
    const amt = parseFloat(parseFloat(amount).toFixed(6));

    if (action === 'play') {
      if (isNaN(amt) || amt <= 0) return json(res, 400, { error: 'Montant invalide.' });
      if (user.balance < amt) return json(res, 400, { error: 'Solde insuffisant.' });
      // Génération du crash point (house edge ~3%)
      const r = Math.random();
      let crashAt;
      if (r < 0.01) crashAt = 1.00; // 1% instant crash
      else crashAt = parseFloat((0.97 / (1 - Math.random())).toFixed(2));
      crashAt = Math.min(crashAt, 100);

      const target = parseFloat(parseFloat(cashoutAt).toFixed(2));
      const won = target <= crashAt;

      await query('UPDATE users SET balance = balance - $1 WHERE username = $2', [amt, user.username]);

      let gain = 0;
      if (won) {
        gain = parseFloat((amt * target).toFixed(6));
        await query('UPDATE users SET balance = balance + $1, total_earned = total_earned + $1 WHERE username = $2', [gain, user.username]);
        await addHistory(user.username, gain - amt, 'crash_win');
      } else {
        await addHistory(user.username, -amt, 'crash_lose');
      }

      const perksCr = await getUserPerks(user.username);
      let cbCr = 0; if (!won) cbCr = await applyCashback(user.username, amt, perksCr);
      const xpCr = await addXp(user.username, won ? 'crash_win' : 'crash_lose');
      const updated = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
      console.log(`[CRASH] ${user.username} target:${target}x crash:${crashAt}x ${won?'WIN':'LOSE'} +${xpCr}xp`);
      return json(res, 200, { ok: true, crashAt, won, gain, balance: updated.rows[0].balance, xp_gained: xpCr, cashback: cbCr });
    }

    return json(res, 400, { error: 'Action inconnue.' });
  }

  // GAME — ROULETTE
  if (endpoint === '/api/game/roulette' && req.method === 'POST') {
    const user = await getUser(tk);
    if (!user) return json(res, 401, { error: 'Non connecté.' });
    const { betType, betValue, amount } = await body(req);
    const amt = parseFloat(parseFloat(amount).toFixed(6));
    if (isNaN(amt) || amt <= 0) return json(res, 400, { error: 'Montant invalide.' });
    if (user.balance < amt) return json(res, 400, { error: 'Solde insuffisant.' });
    const spin = Math.floor(Math.random() * 37); // 0-36
    const reds = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
    const isRed = reds.includes(spin);
    const isBlack = spin > 0 && !isRed;
    let mult = 0;
    if (betType === 'number' && parseInt(betValue) === spin) mult = 36;
    else if (betType === 'red' && isRed) mult = 2;
    else if (betType === 'black' && isBlack) mult = 2;
    else if (betType === 'even' && spin > 0 && spin % 2 === 0) mult = 2;
    else if (betType === 'odd' && spin % 2 === 1) mult = 2;
    else if (betType === 'low' && spin >= 1 && spin <= 18) mult = 2;
    else if (betType === 'high' && spin >= 19 && spin <= 36) mult = 2;
    else if (betType === 'dozen1' && spin >= 1 && spin <= 12) mult = 3;
    else if (betType === 'dozen2' && spin >= 13 && spin <= 24) mult = 3;
    else if (betType === 'dozen3' && spin >= 25 && spin <= 36) mult = 3;
    await query('UPDATE users SET balance = balance - $1 WHERE username = $2', [amt, user.username]);
    let gain = 0;
    if (mult > 0) {
      gain = parseFloat((amt * mult).toFixed(6));
      await query('UPDATE users SET balance = balance + $1, total_earned = total_earned + $1 WHERE username = $2', [gain, user.username]);
      await addHistory(user.username, gain - amt, 'roulette_win');
    } else {
      await addHistory(user.username, -amt, 'roulette_lose');
    }
    const perksR = await getUserPerks(user.username);
    let cbR = 0; if (mult === 0) cbR = await applyCashback(user.username, amt, perksR);
    const xpR = await addXp(user.username, mult > 0 ? 'roulette_win' : 'roulette_lose');
    const updatedR = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
    console.log(`[ROULETTE] ${user.username} spin:${spin} bet:${betType}/${betValue} mult:${mult} +${xpR}xp`);
    return json(res, 200, { ok: true, spin, isRed, mult, gain, balance: updatedR.rows[0].balance, xp_gained: xpR, cashback: cbR });
  }

  // GAME — PLINKO
  if (endpoint === '/api/game/plinko' && req.method === 'POST') {
    const user = await getUser(tk);
    if (!user) return json(res, 401, { error: 'Non connecté.' });
    const { amount, rows } = await body(req);
    const amt = parseFloat(parseFloat(amount).toFixed(6));
    const r = Math.min(Math.max(parseInt(rows) || 8, 8), 16);
    if (isNaN(amt) || amt <= 0) return json(res, 400, { error: 'Montant invalide.' });
    if (user.balance < amt) return json(res, 400, { error: 'Solde insuffisant.' });
    let pos = 0;
    const path = [];
    for (let i = 0; i < r; i++) { const dir = Math.random() < 0.5 ? 0 : 1; path.push(dir); pos += dir; }
    const multipliers8  = [10, 3, 1.4, 0.4, 0.2, 0.4, 1.4, 3, 10];
    const multipliers12 = [20, 6, 2.5, 1.1, 0.5, 0.2, 0.2, 0.2, 0.5, 1.1, 2.5, 6, 20];
    const multipliers16 = [60, 18, 7, 2.5, 1.2, 0.5, 0.3, 0.2, 0.2, 0.2, 0.3, 0.5, 1.2, 2.5, 7, 18, 60];
    const mults = r <= 8 ? multipliers8 : r <= 12 ? multipliers12 : multipliers16;
    const mult = mults[pos] || 0.2;
    const gain = parseFloat((amt * mult).toFixed(6));
    await query('UPDATE users SET balance = balance - $1 WHERE username = $2', [amt, user.username]);
    if (gain > 0) await query('UPDATE users SET balance = balance + $1, total_earned = total_earned + $1 WHERE username = $2', [gain, user.username]);
    const delta = parseFloat((gain - amt).toFixed(6));
    if (delta !== 0) await addHistory(user.username, delta, delta > 0 ? 'plinko_win' : 'plinko_lose');
    const perksP = await getUserPerks(user.username);
    let cbP = 0; if (delta < 0) cbP = await applyCashback(user.username, Math.abs(delta), perksP);
    const xpP = await addXp(user.username, delta > 0 ? 'plinko_win' : 'plinko_lose');
    const updatedP = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
    console.log(`[PLINKO] ${user.username} pos:${pos}/${r} mult:${mult} delta:${delta} +${xpP}xp`);
    return json(res, 200, { ok: true, path, slot: pos, mult, gain, balance: updatedP.rows[0].balance, xp_gained: xpP, cashback: cbP });
  }

  // GAME — KENO
  if (endpoint === '/api/game/keno' && req.method === 'POST') {
    const user = await getUser(tk);
    if (!user) return json(res, 401, { error: 'Non connecté.' });
    const { amount, picks } = await body(req);
    const amt = parseFloat(parseFloat(amount).toFixed(6));
    if (isNaN(amt) || amt <= 0) return json(res, 400, { error: 'Montant invalide.' });
    if (!Array.isArray(picks) || picks.length < 1 || picks.length > 10) return json(res, 400, { error: 'Choisis entre 1 et 10 numéros.' });
    if (user.balance < amt) return json(res, 400, { error: 'Solde insuffisant.' });
    // Draw 20 numbers from 1-80
    const pool = Array.from({length: 80}, (_, i) => i + 1);
    const drawn = [];
    for (let i = 0; i < 20; i++) {
      const idx = Math.floor(Math.random() * pool.length);
      drawn.push(pool.splice(idx, 1)[0]);
    }
    drawn.sort((a, b) => a - b);
    const hits = picks.filter(p => drawn.includes(p)).length;
    const n = picks.length;
    // Payout table (hits needed → multiplier)
    const payouts = {
      1: [0, 3.8],
      2: [0, 1, 9],
      3: [0, 0, 3, 27],
      4: [0, 0, 1, 5, 55],
      5: [0, 0, 1, 3, 15, 120],
      6: [0, 0, 0, 2, 7, 35, 300],
      7: [0, 0, 0, 1, 4, 15, 100, 750],
      8: [0, 0, 0, 0, 2, 8, 40, 200, 2000],
      9: [0, 0, 0, 0, 1, 5, 20, 80, 500, 5000],
      10:[0, 0, 0, 0, 1, 3, 10, 40, 200, 1000, 10000],
    };
    const mult = (payouts[n] || [])[hits] || 0;
    const gain = parseFloat((amt * mult).toFixed(6));
    await query('UPDATE users SET balance = balance - $1 WHERE username = $2', [amt, user.username]);
    if (gain > 0) {
      await query('UPDATE users SET balance = balance + $1, total_earned = total_earned + $1 WHERE username = $2', [gain, user.username]);
    }
    const delta = parseFloat((gain - amt).toFixed(6));
    if (delta !== 0) await addHistory(user.username, delta, delta > 0 ? 'keno_win' : 'keno_lose');
    const perksK = await getUserPerks(user.username);
    let cbK = 0; if (delta < 0) cbK = await applyCashback(user.username, Math.abs(delta), perksK);
    const xpK = await addXp(user.username, delta > 0 ? 'keno_win' : 'keno_lose');
    const updatedK = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
    console.log(`[KENO] ${user.username} picks:${n} hits:${hits} mult:${mult} +${xpK}xp`);
    return json(res, 200, { ok: true, drawn, hits, mult, gain, balance: updatedK.rows[0].balance, xp_gained: xpK, cashback: cbK });
  }

  // GAME — POKER (video poker, 5-card draw vs house)
  if (endpoint === '/api/game/poker' && req.method === 'POST') {
    const user = await getUser(tk);
    if (!user) return json(res, 401, { error: 'Non connecté.' });
    const { action, amount, held, gameState: gs } = await body(req);

    function makeDeck() {
      const suits = ['♠','♥','♦','♣'], vals = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
      const d = suits.flatMap(s => vals.map(v => ({ v, s })));
      for (let i = d.length-1; i > 0; i--) { const j = Math.floor(Math.random()*(i+1)); [d[i],d[j]]=[d[j],d[i]]; }
      return d;
    }
    function rankHand(hand) {
      const order = '23456789TJQKA';
      const vals = hand.map(c => order.indexOf(c.v === '10' ? 'T' : c.v)).sort((a,b)=>a-b);
      const suits = hand.map(c => c.s);
      const flush = suits.every(s => s === suits[0]);
      const straight = vals[4]-vals[0]===4 && new Set(vals).size===5 || (vals.join('')==='01234' && vals[4]===12);
      const counts = {};
      vals.forEach(v => counts[v] = (counts[v]||0)+1);
      const c = Object.values(counts).sort((a,b)=>b-a);
      if (flush && straight && vals[4]===12 && vals[0]===8) return { name: 'QUINTE ROYALE',   mult: 800 };
      if (flush && straight)                                 return { name: 'QUINTE FLUSH',    mult: 50 };
      if (c[0]===4)                                          return { name: 'CARRÉ',           mult: 25 };
      if (c[0]===3 && c[1]===2)                              return { name: 'FULL HOUSE',      mult: 9 };
      if (flush)                                             return { name: 'COULEUR',         mult: 6 };
      if (straight)                                          return { name: 'QUINTE',          mult: 4 };
      if (c[0]===3)                                          return { name: 'BRELAN',          mult: 3 };
      if (c[0]===2 && c[1]===2)                             return { name: 'DEUX PAIRES',     mult: 2 };
      if (c[0]===2) {
        const pairVal = parseInt(Object.keys(counts).find(k => counts[k]===2));
        if (pairVal >= 9) return { name: 'PAIRE J-A',      mult: 1 };
      }
      return { name: 'RIEN',                                                                   mult: 0 };
    }

    if (action === 'deal') {
      const amt = parseFloat(parseFloat(amount).toFixed(6));
      if (isNaN(amt) || amt <= 0) return json(res, 400, { error: 'Montant invalide.' });
      if (user.balance < amt) return json(res, 400, { error: 'Solde insuffisant.' });
      await query('UPDATE users SET balance = balance - $1 WHERE username = $2', [amt, user.username]);
      const deck = makeDeck();
      const hand = [deck.pop(), deck.pop(), deck.pop(), deck.pop(), deck.pop()];
      const updated = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
      return json(res, 200, { ok: true, hand, deck, balance: updated.rows[0].balance });
    }

    if (action === 'draw') {
      const { hand: h, deck: d, bet } = gs;
      const amt = parseFloat(parseFloat(bet).toFixed(6));
      const heldArr = Array.isArray(held) ? held : [];
      const deck = d;
      const newHand = h.map((card, i) => heldArr.includes(i) ? card : deck.pop());
      const result = rankHand(newHand);
      const gain = parseFloat((amt * result.mult).toFixed(6));
      if (gain > 0) {
        await query('UPDATE users SET balance = balance + $1, total_earned = total_earned + $1 WHERE username = $2', [gain, user.username]);
      }
      const delta = parseFloat((gain - amt).toFixed(6));
      if (delta !== 0) await addHistory(user.username, delta, delta > 0 ? 'poker_win' : 'poker_lose');
      const perksPoker = await getUserPerks(user.username);
      let cbPoker = 0; if (delta < 0) cbPoker = await applyCashback(user.username, Math.abs(delta), perksPoker);
      const xpPoker = await addXp(user.username, delta > 0 ? 'poker_win' : 'poker_lose');
      const updated = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
      console.log(`[POKER] ${user.username} ${result.name} mult:${result.mult} delta:${delta} +${xpPoker}xp`);
      return json(res, 200, { ok: true, hand: newHand, result, gain, balance: updated.rows[0].balance, xp_gained: xpPoker, cashback: cbPoker });
    }

    return json(res, 400, { error: 'Action inconnue.' });
  }

  // GAME — MEMORY / SCRATCH CARD
  if (endpoint === '/api/game/scratch' && req.method === 'POST') {
    const user = await getUser(tk);
    if (!user) return json(res, 401, { error: 'Non connecté.' });
    const { amount } = await body(req);
    const amt = parseFloat(parseFloat(amount).toFixed(6));
    if (isNaN(amt) || amt <= 0) return json(res, 400, { error: 'Montant invalide.' });
    if (user.balance < amt) return json(res, 400, { error: 'Solde insuffisant.' });
    const syms = ['◈','◆','★','▲','●','■'];
    const weights = [2, 3, 5, 7, 10, 15];
    const mults  = [50, 20, 10, 5, 2.5, 1.5];
    function pickSym() {
      const total = weights.reduce((a,b)=>a+b,0); let r = Math.random()*total;
      for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) return i; }
      return syms.length-1;
    }
    const grid = Array.from({length:9}, () => pickSym());
    let winSym = -1, mult = 0;
    const counts = {};
    grid.forEach(s => counts[s] = (counts[s]||0)+1);
    const triple = Object.entries(counts).find(([,v]) => v >= 3);
    if (triple) { winSym = parseInt(triple[0]); mult = mults[winSym]; }
    const gain = parseFloat((amt * mult).toFixed(6));
    await query('UPDATE users SET balance = balance - $1 WHERE username = $2', [amt, user.username]);
    if (gain > 0) await query('UPDATE users SET balance = balance + $1, total_earned = total_earned + $1 WHERE username = $2', [gain, user.username]);
    const delta = parseFloat((gain - amt).toFixed(6));
    if (delta !== 0) await addHistory(user.username, delta, delta > 0 ? 'scratch_win' : 'scratch_lose');
    const perksSc = await getUserPerks(user.username);
    let cbSc = 0; if (delta < 0) cbSc = await applyCashback(user.username, Math.abs(delta), perksSc);
    const xpSc = await addXp(user.username, delta > 0 ? 'scratch_win' : 'scratch_lose');
    const updatedSc = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
    console.log(`[SCRATCH] ${user.username} winSym:${winSym} mult:${mult} delta:${delta} +${xpSc}xp`);
    return json(res, 200, { ok: true, grid: grid.map(i => syms[i]), gridIdx: grid, winSym, mult, gain, balance: updatedSc.rows[0].balance, xp_gained: xpSc, cashback: cbSc });
  }

  // GAME — TOWER
  if (endpoint === '/api/game/tower' && req.method === 'POST') {
    const user = await getUser(tk);
    if (!user) return json(res, 401, { error: 'Non connecté.' });
    const { action, amount, level, choice, towerState } = await body(req);

    if (action === 'start') {
      const amt = parseFloat(parseFloat(amount).toFixed(6));
      if (isNaN(amt) || amt <= 0) return json(res, 400, { error: 'Montant invalide.' });
      if (user.balance < amt) return json(res, 400, { error: 'Solde insuffisant.' });
      await query('UPDATE users SET balance = balance - $1 WHERE username = $2', [amt, user.username]);
      const traps = Array.from({length:8}, () => Math.floor(Math.random()*3));
      const updated = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
      return json(res, 200, { ok: true, traps, balance: updated.rows[0].balance });
    }

    if (action === 'step') {
      const { traps, bet } = towerState;
      const lvl = parseInt(level), ch = parseInt(choice);
      const trap = traps[lvl];
      const hit = ch === trap;
      const mults = [1.4, 2, 2.8, 4, 5.5, 8, 12, 20];
      if (hit) {
        const amt = parseFloat(parseFloat(bet).toFixed(6));
        await addHistory(user.username, -amt, 'tower_lose');
        const perksTl = await getUserPerks(user.username);
        const cbTl = await applyCashback(user.username, amt, perksTl);
        const xpTl = await addXp(user.username, 'tower_lose');
        const updated = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
        return json(res, 200, { ok: true, hit: true, trap, balance: updated.rows[0].balance, xp_gained: xpTl, cashback: cbTl });
      }
      const nextLevel = lvl + 1;
      const cleared = nextLevel >= 8;
      const mult = mults[lvl];
      return json(res, 200, { ok: true, hit: false, trap, mult, cleared, nextLevel });
    }

    if (action === 'cashout') {
      const { bet, level: lvl } = towerState;
      const amt = parseFloat(parseFloat(bet).toFixed(6));
      const mults = [1.4, 2, 2.8, 4, 5.5, 8, 12, 20];
      const mult = mults[Math.max(0, parseInt(lvl)-1)] || 1;
      const gain = parseFloat((amt * mult).toFixed(6));
      await query('UPDATE users SET balance = balance + $1, total_earned = total_earned + $1 WHERE username = $2', [gain, user.username]);
      await addHistory(user.username, gain - amt, 'tower_cashout');
      const xpTc = await addXp(user.username, 'tower_cashout');
      const updated = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
      console.log(`[TOWER] ${user.username} lvl:${lvl} mult:${mult} +${gain} +${xpTc}xp`);
      return json(res, 200, { ok: true, gain, mult, balance: updated.rows[0].balance, xp_gained: xpTc });
    }

    return json(res, 400, { error: 'Action inconnue.' });
  }

  // PERKS — LIST
  if (endpoint === '/api/perks' && req.method === 'GET') {
    const user = await getUser(tk);
    if (!user) return json(res, 401, { error: 'Non connecté.' });
    const owned = await getUserPerks(user.username);
    const lvlData = levelFromXp(user.xp || 0);
    const catalog = Object.values(PERKS).map(p => {
      const curLvl = owned[p.id] || 0;
      const maxed = curLvl >= p.maxLvl;
      return {
        id: p.id, name: p.name, cat: p.cat,
        desc: p.desc, maxLvl: p.maxLvl,
        currentLevel: curLvl,
        nextCost: maxed ? null : perkCost(p.id, curLvl),
        maxed,
      };
    });
    return json(res, 200, { ok: true, catalog, owned, level: lvlData.level, xp: user.xp || 0, balance: user.balance });
  }

  // PERKS — BUY / UPGRADE
  if (endpoint === '/api/perks/buy' && req.method === 'POST') {
    const user = await getUser(tk);
    if (!user) return json(res, 401, { error: 'Non connecté.' });
    const { perk_id } = await body(req);
    const perk = PERKS[perk_id];
    if (!perk) return json(res, 400, { error: 'Perk inconnu.' });
    const owned = await getUserPerks(user.username);
    const curLvl = owned[perk_id] || 0;
    if (curLvl >= perk.maxLvl) return json(res, 400, { error: 'Perk déjà au niveau maximum.' });
    const cost = perkCost(perk_id, curLvl);
    if (user.balance < cost) return json(res, 400, { error: `Solde insuffisant. Coût : ${cost} ARCH` });
    await query('UPDATE users SET balance = balance - $1 WHERE username = $2', [cost, user.username]);
    if (curLvl === 0) {
      await query('INSERT INTO player_perks (username, perk_id, level) VALUES ($1, $2, 1)', [user.username, perk_id]);
    } else {
      await query('UPDATE player_perks SET level = level + 1 WHERE username = $1 AND perk_id = $2', [user.username, perk_id]);
    }
    await addHistory(user.username, -cost, `perk_buy_${perk_id}`);
    const newLevel = curLvl + 1;
    const updated = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
    console.log(`[PERK] ${user.username} bought ${perk_id} lvl${newLevel} for ${cost} ARCH`);
    return json(res, 200, { ok: true, perk_id, newLevel, balance: updated.rows[0].balance });
  }

  // ADMIN
  if (endpoint === '/api/admin/users' && req.method === 'GET') {
    if (url.searchParams.get('pass') !== CONFIG.adminPass)
      return json(res, 403, { error: 'Accès refusé.' });
    const users = await query('SELECT username, balance, total_earned, scans, claims FROM users ORDER BY balance DESC');
    return json(res, 200, { users: users.rows });
  }

  // DISCORD — Fallback login quand authorize() échoue (utilise instance_id comme identifiant)
  if (endpoint === '/api/discord/login-fallback' && req.method === 'POST') {
    const { instance_id, guild_id, channel_id } = await body(req);
    if (!instance_id) return json(res, 400, { error: 'instance_id manquant' });
    try {
      // Crée un compte lié à l'instance (pas idéal mais fonctionnel)
      const fakeId = 'inst_' + instance_id.replace(/[^a-z0-9]/gi, '').slice(0, 32);
      const result = await getOrCreateDiscordUser(fakeId, 'Player_' + fakeId.slice(-6), null);
      return json(res, 200, { ...result, discord_name: 'Player_' + fakeId.slice(-6), discord_avatar: '' });
    } catch(e) { return json(res, 500, { error: e.message }); }
  }

  // DISCORD — Auth complète en 1 appel : code → token → profil → compte ARCH
  // Le front envoie juste le code OAuth2, le serveur fait tout côté Node
  if (endpoint === '/api/discord/login' && req.method === 'POST') {
    const { code } = await body(req);
    if (!code) return json(res, 400, { error: 'code manquant' });
    try {
      // 1. Échange le code contre un access_token
      const tokenData = await discordTokenExchange(code);
      if (!tokenData.access_token) return json(res, 400, { error: 'token invalide: ' + JSON.stringify(tokenData) });

      // 2. Récupère le profil Discord côté serveur (pas depuis le navigateur)
      const me = await new Promise((resolve, reject) => {
        const r = https.request(
          { hostname: 'discord.com', path: '/api/users/@me', method: 'GET',
            headers: { Authorization: 'Bearer ' + tokenData.access_token } },
          res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } }); }
        );
        r.on('error', reject); r.end();
      });
      if (!me.id) return json(res, 400, { error: 'profil Discord invalide: ' + JSON.stringify(me) });

      // 3. Crée / récupère le compte ARCH
      const result = await getOrCreateDiscordUser(me.id, me.global_name || me.username, me.avatar);
      return json(res, 200, {
        ...result,
        discord_name:   me.global_name || me.username,
        discord_avatar: me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png` : '',
      });
    } catch(e) { return json(res, 500, { error: e.message }); }
  }

  // DISCORD — Token exchange (legacy)
  if (endpoint === '/api/discord/token' && req.method === 'POST') {
    const { code } = await body(req);
    if (!code) return json(res, 400, { error: 'code manquant' });
    try {
      const result = await discordTokenExchange(code);
      return json(res, 200, { access_token: result.access_token });
    } catch(e) { return json(res, 500, { error: e.message }); }
  }
  // DISCORD — Auth (legacy)
  if (endpoint === '/api/discord/auth' && req.method === 'POST') {
    const { discord_id, username: dName, avatar } = await body(req);
    if (!discord_id) return json(res, 400, { error: 'discord_id manquant' });
    try {
      const result = await getOrCreateDiscordUser(discord_id, dName, avatar);
      return json(res, 200, result);
    } catch(e) { return json(res, 500, { error: e.message }); }
  }

  return json(res, 404, { error: 'Route inconnue.' });
}

// ============================================================
//  SERVEUR HTTP
// ============================================================
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    return res.end();
  }

  if (req.url.startsWith('/api/') || req.url.startsWith('/discord/') || req.url.startsWith('/game/') || req.url.startsWith('/me') || req.url.startsWith('/auth')) return api(req, res);

  // Parse le pathname proprement (ignore les query params Discord)
  const urlPath = req.url.split('?')[0].split('#')[0];

  // Discord préfixe tout avec /activity/ — on strip ce préfixe
  const cleanPath = urlPath.startsWith('/activity/') ? urlPath.slice('/activity'.length) : urlPath;

  // Activity Discord — sert activity.html avec CLIENT_ID injecté
  if (cleanPath === '/' || cleanPath === '/activity' || cleanPath === '/activity/') {
    fs.readFile('./activity.html', 'utf8', (err, data) => {
      if (err) { res.writeHead(404); return res.end('activity.html introuvable'); }
      const injected = data.replace('__DISCORD_CLIENT_ID__', CONFIG.discordClientId);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(injected);
    });
    return;
  }

  let filePath = '.' + cleanPath;
  if (filePath === './') filePath = './index.html';
  const ext  = path.extname(filePath);
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[ext] || 'text/plain';
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

// ============================================================
//  DÉMARRAGE
// ============================================================
// ============================================================
//  WEBSOCKET — Discord Activity live feed
// ============================================================
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', async (ws, req) => {
  const wsUrl  = new URL(req.url, 'http://localhost');
  const token  = wsUrl.searchParams.get('token');
  if (!token) { ws.close(); return; }

  // Resolve identity from token
  let client = { ws, discordId: null, displayName: null, avatar: null, balance: 0, status: 'idle', last: null };
  try {
    const s = await query('SELECT username FROM sessions WHERE token=$1', [token]);
    if (s.rows.length) {
      const archUser = s.rows[0].username;
      const d = await query('SELECT * FROM discord_users WHERE arch_user=$1', [archUser]).catch(()=>({rows:[]}));
      if (d.rows.length) {
        client.discordId   = d.rows[0].discord_id;
        client.displayName = d.rows[0].display_name;
        client.avatar      = d.rows[0].avatar;
      }
      const u = await query('SELECT balance FROM users WHERE username=$1', [archUser]);
      client.balance = u.rows[0]?.balance || 0;
      client.archUser = archUser;
    }
  } catch(e) { console.error('[WS] auth error:', e.message); }

  wsClients.set(token, client);
  wsBroadcastPlayerList();

  ws.on('message', async raw => {
    try {
      const msg = JSON.parse(raw.toString());
      const c   = wsClients.get(token);
      if (!c) return;

      if (msg.type === 'status') {
        c.status = msg.status;
        wsBroadcastPlayerList();
      }
      if (msg.type === 'game_result') {
        // Refresh balance from DB
        const u = await query('SELECT balance FROM users WHERE username=$1', [c.archUser]).catch(()=>({rows:[]}));
        c.balance = u.rows[0]?.balance || c.balance;
        c.last = { game: msg.game, win: msg.win, amt: msg.amount };
        wsBroadcastEvent({
          type:        'game_event',
          discord_id:  c.discordId,
          displayName: c.displayName || 'Joueur',
          game:        msg.game,
          win:         msg.win,
          amount:      msg.amount,
          big:         msg.amount > 0.05,
        }, token);
        // Push balance update to sender
        try { ws.send(JSON.stringify({ type: 'balance_sync', balance: c.balance })); } catch {}
        wsBroadcastPlayerList();
      }
    } catch(e) { console.error('[WS] msg error:', e.message); }
  });

  ws.on('close', () => {
    wsClients.delete(token);
    wsBroadcastPlayerList();
  });
});

// ============================================================
//  DÉMARRAGE
// ============================================================
initDB()
  .then(() => initDiscordDB())
  .then(() => {
    server.listen(CONFIG.port, () => {
      console.log('');
      console.log('╔══════════════════════════════════════════════╗');
      console.log('║   ARCH — PostgreSQL + Discord Activity       ║');
      console.log(`║   http://localhost:${CONFIG.port}                     ║`);
      console.log('║   Activity: /activity                        ║');
      console.log('╚══════════════════════════════════════════════╝');
    });
  }).catch(err => {
    console.error('[FATAL] PostgreSQL connexion échouée :', err.message);
    process.exit(1);
  });

