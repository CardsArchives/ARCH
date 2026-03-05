// ============================================================
//  ARCH SERVER — PostgreSQL version
//  Lance avec : node server.js
// ============================================================

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

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
      created_at    TEXT DEFAULT now()::text
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
  const endpoint = url.pathname;
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
    console.log(`[SCAN] ${user.username} → ${reward} ARCH`);
    return json(res, 200, { ok: true, reward, scan_duration: CONFIG.scanDuration, claim_window: CONFIG.claimWindow });
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
    await query('UPDATE users SET balance = balance + $1, total_earned = total_earned + $1, claims = claims + 1 WHERE username = $2', [claim.reward, user.username]);
    await addHistory(user.username, claim.reward, 'claim');
    await query('DELETE FROM pending_claims WHERE username = $1', [user.username]);
    const updated = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
    console.log(`[CLAIM] ${user.username} → +${claim.reward} ARCH`);
    return json(res, 200, { ok: true, reward: claim.reward, balance: updated.rows[0].balance });
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
    return json(res, 200, {
      username:      user.username,
      balance:       user.balance,
      total_earned:  user.total_earned,
      scans:         user.scans,
      claims:        user.claims,
      history:       hist.rows.map(h => ({ amount: h.amount, at: h.created_at, auto: h.auto, reason: h.reason })),
      next_scan_in:  Math.max(0, Math.ceil(CONFIG.scanInterval - (Date.now() - Number(user.last_scan)) / 1000)),
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

    const updated = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
    console.log(`[COINFLIP] ${user.username} → ${choice} vs ${result} — ${won ? '+' + amt.toFixed(6) : '-' + amt.toFixed(6)} ARCH`);
    return json(res, 200, { ok: true, result, won, balance: updated.rows[0].balance });
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

    const updated = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
    console.log(`[DICE] ${user.username} → ${choiceNum} vs ${rolled} — ${won ? '+' + (amt * 4).toFixed(6) : '-' + amt.toFixed(6)} ARCH`);
    return json(res, 200, { ok: true, rolled, won, balance: updated.rows[0].balance });
  }

  // GAME — SLOTS (résultat serveur)
  if (endpoint === '/api/game/slots' && req.method === 'POST') {
    const user = await getUser(tk);
    if (!user) return json(res, 401, { error: 'Non connecté.' });
    const { amount } = await body(req);
    const amt = parseFloat(parseFloat(amount).toFixed(6));
    if (isNaN(amt) || amt <= 0) return json(res, 400, { error: 'Montant invalide.' });
    if (user.balance < amt) return json(res, 400, { error: 'Solde insuffisant.' });

    // Symboles : id utilisé côté client pour le rendu SVG
    // ARCH (id:0) = symbole spécial bonus uniquement sur rouleaux 1,3,5 (index 0,2,4)
    // Autres symboles sur tous les rouleaux
    const SYMS = [
      { id: 0, name: 'ARCH',    weight: 2  }, // scatter bonus (rouleaux 1,3,5 seulement)
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

    // Vérifier bonus ARCH : ARCH sur rouleaux 1,3,5 (cols 0,2,4)
    const archOnOddReels = [0,2,4].filter(col => grid[col].some(cell => cell.id === 0));
    const bonusTriggered = archOnOddReels.length === 3 && Math.random() < 0.01; // ~1% quand 3 ARCH alignés

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

    // Bonus ARCH wheel — récompense aléatoire avec moyenne raisonnable
    let bonusReward = 0;
    if (bonusTriggered) {
      // Distribution log-normale : majorité entre 1-15 ARCH, quelques gros lots
      const r = Math.random();
      if (r < 0.60)      bonusReward = parseFloat((Math.random() * 4 + 1).toFixed(6));       // 1-5 ARCH
      else if (r < 0.85) bonusReward = parseFloat((Math.random() * 10 + 5).toFixed(6));      // 5-15 ARCH
      else if (r < 0.97) bonusReward = parseFloat((Math.random() * 85 + 15).toFixed(6));     // 15-100 ARCH
      else if (r < 0.999) bonusReward = parseFloat((Math.random() * 900 + 100).toFixed(6)); // 100-1000 ARCH
      else bonusReward = parseFloat((Math.random() * 999000 + 1000).toFixed(6));             // 1000-1000000 ARCH (0.1%)
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

    const updated = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
    console.log(`[SLOTS5x3] ${user.username} mult:${totalMult} lines:${winLines.length} bonus:${bonusReward}`);
    return json(res, 200, {
      ok: true, grid,
      winLines, totalMult, netDelta,
      bonusTriggered, bonusReward,
      balance: updated.rows[0].balance
    });
  }

  // GAME — SLOTS BONUS WHEEL (roue ARCH)
  if (endpoint === '/api/game/slots-bonus' && req.method === 'POST') {
    const user = await getUser(tk);
    if (!user) return json(res, 401, { error: 'Non connecté.' });
    // Le bonus a déjà été crédité lors du spin, on renvoie juste la récompense pour l'animation
    const { reward } = await body(req);
    return json(res, 200, { ok: true, reward: parseFloat(reward) });
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
      const updated = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
      console.log(`[MINES] ${user.username} cashout safe:${safe} mult:${mult} +${gain}`);
      return json(res, 200, { ok: true, gain, mult, balance: updated.rows[0].balance });
    }

    if (action === 'lose') {
      const amt = parseFloat(parseFloat(amount).toFixed(6));
      await addHistory(user.username, -amt, 'mines_lose');
      const updated = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
      return json(res, 200, { ok: true, balance: updated.rows[0].balance });
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

      const updated = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
      console.log(`[CRASH] ${user.username} target:${target}x crash:${crashAt}x ${won?'WIN':'LOSE'}`);
      return json(res, 200, { ok: true, crashAt, won, gain, balance: updated.rows[0].balance });
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
    const updated = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
    console.log(`[ROULETTE] ${user.username} spin:${spin} bet:${betType}/${betValue} mult:${mult}`);
    return json(res, 200, { ok: true, spin, isRed, mult, gain, balance: updated.rows[0].balance });
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
    // Simulate path
    let pos = 0;
    const path = [];
    for (let i = 0; i < r; i++) {
      const dir = Math.random() < 0.5 ? 0 : 1;
      path.push(dir);
      pos += dir;
    }
    // Multipliers for each slot (bell curve, house edge ~3%)
    const multipliers8  = [10, 3, 1.4, 0.4, 0.2, 0.4, 1.4, 3, 10];           // 9 slots
    const multipliers12 = [20, 6, 2.5, 1.1, 0.5, 0.2, 0.2, 0.2, 0.5, 1.1, 2.5, 6, 20];  // 13 slots
    const multipliers16 = [60, 18, 7, 2.5, 1.2, 0.5, 0.3, 0.2, 0.2, 0.2, 0.3, 0.5, 1.2, 2.5, 7, 18, 60]; // 17 slots
    const mults = r <= 8 ? multipliers8 : r <= 12 ? multipliers12 : multipliers16;
    const mult = mults[pos] || 0.2;
    const gain = parseFloat((amt * mult).toFixed(6));
    await query('UPDATE users SET balance = balance - $1 WHERE username = $2', [amt, user.username]);
    if (gain > 0) {
      await query('UPDATE users SET balance = balance + $1, total_earned = total_earned + $1 WHERE username = $2', [gain, user.username]);
    }
    const delta = parseFloat((gain - amt).toFixed(6));
    if (delta !== 0) await addHistory(user.username, delta, delta > 0 ? 'plinko_win' : 'plinko_lose');
    const updated = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
    console.log(`[PLINKO] ${user.username} pos:${pos}/${r} mult:${mult} delta:${delta}`);
    return json(res, 200, { ok: true, path, slot: pos, mult, gain, balance: updated.rows[0].balance });
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
    const updated = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
    console.log(`[KENO] ${user.username} picks:${n} hits:${hits} mult:${mult}`);
    return json(res, 200, { ok: true, drawn, hits, mult, gain, balance: updated.rows[0].balance });
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
      const updated = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
      console.log(`[POKER] ${user.username} ${result.name} mult:${result.mult} delta:${delta}`);
      return json(res, 200, { ok: true, hand: newHand, result, gain, balance: updated.rows[0].balance });
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
    // Generate 9-cell scratch grid, 3 hidden, needs 3-of-a-kind to win
    const syms = ['◈','◆','★','▲','●','■'];
    const weights = [2, 3, 5, 7, 10, 15]; // rarer = higher value
    const mults  = [50, 20, 10, 5, 2.5, 1.5];
    function pickSym() {
      const total = weights.reduce((a,b)=>a+b,0);
      let r = Math.random()*total;
      for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) return i; }
      return syms.length-1;
    }
    const grid = Array.from({length:9}, () => pickSym());
    // Force a win ~30% of the time for fun
    let winSym = -1, mult = 0;
    const counts = {};
    grid.forEach(s => counts[s] = (counts[s]||0)+1);
    const triple = Object.entries(counts).find(([,v]) => v >= 3);
    if (triple) { winSym = parseInt(triple[0]); mult = mults[winSym]; }
    const gain = parseFloat((amt * mult).toFixed(6));
    await query('UPDATE users SET balance = balance - $1 WHERE username = $2', [amt, user.username]);
    if (gain > 0) {
      await query('UPDATE users SET balance = balance + $1, total_earned = total_earned + $1 WHERE username = $2', [gain, user.username]);
    }
    const delta = parseFloat((gain - amt).toFixed(6));
    if (delta !== 0) await addHistory(user.username, delta, delta > 0 ? 'scratch_win' : 'scratch_lose');
    const updated = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
    console.log(`[SCRATCH] ${user.username} winSym:${winSym} mult:${mult} delta:${delta}`);
    return json(res, 200, { ok: true, grid: grid.map(i => syms[i]), gridIdx: grid, winSym, mult, gain, balance: updated.rows[0].balance });
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
      // 8 levels, each row has 3 tiles, 1 is a trap
      const traps = Array.from({length:8}, () => Math.floor(Math.random()*3));
      const updated = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
      return json(res, 200, { ok: true, traps, balance: updated.rows[0].balance });
    }

    if (action === 'step') {
      const { traps, bet } = towerState;
      const lvl = parseInt(level);
      const ch = parseInt(choice);
      const trap = traps[lvl];
      const hit = ch === trap;
      const mults = [1.4, 2, 2.8, 4, 5.5, 8, 12, 20]; // per level cleared
      if (hit) {
        const amt = parseFloat(parseFloat(bet).toFixed(6));
        await addHistory(user.username, -amt, 'tower_lose');
        const updated = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
        return json(res, 200, { ok: true, hit: true, trap, balance: updated.rows[0].balance });
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
      const updated = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
      console.log(`[TOWER] ${user.username} lvl:${lvl} mult:${mult} +${gain}`);
      return json(res, 200, { ok: true, gain, mult, balance: updated.rows[0].balance });
    }

    return json(res, 400, { error: 'Action inconnue.' });
  }

  // ADMIN
  if (endpoint === '/api/admin/users' && req.method === 'GET') {
    if (url.searchParams.get('pass') !== CONFIG.adminPass)
      return json(res, 403, { error: 'Accès refusé.' });
    const users = await query('SELECT username, balance, total_earned, scans, claims FROM users ORDER BY balance DESC');
    return json(res, 200, { users: users.rows });
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

  if (req.url.startsWith('/api/')) return api(req, res);

  let filePath = '.' + req.url;
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
initDB().then(() => {
  server.listen(CONFIG.port, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║   ARCH — PostgreSQL                          ║');
    console.log(`║   http://localhost:${CONFIG.port}                     ║`);
    console.log('╚══════════════════════════════════════════════╝');
  });
}).catch(err => {
  console.error('[FATAL] PostgreSQL connexion échouée :', err.message);
  process.exit(1);
});
