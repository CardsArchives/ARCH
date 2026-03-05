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

    const SLOT_SYMS = [
      { sym: '◈', name: 'ARCH',    mult: 50, weight: 1  },
      { sym: '💎', name: 'DIAMANT', mult: 20, weight: 2  },
      { sym: '⭐', name: 'ÉTOILE',  mult: 10, weight: 4  },
      { sym: '🔷', name: 'CRISTAL', mult: 5,  weight: 7  },
      { sym: '🟢', name: 'NOEUD',  mult: 3,  weight: 14 },
      { sym: '🔲', name: 'BLOC',   mult: 2,  weight: 22 },
    ];
    const pool = SLOT_SYMS.flatMap(s => Array(s.weight).fill(s));
    const randSym = () => pool[Math.floor(Math.random() * pool.length)];
    const reels = [randSym(), randSym(), randSym()];
    const [a, b, c] = reels;

    let mult = 0;
    let label = '';
    if (a.sym === b.sym && b.sym === c.sym) { mult = a.mult; label = '3x ' + a.name; }
    else if (a.sym === b.sym || b.sym === c.sym || a.sym === c.sym) { mult = 0.5; label = '2 identiques'; }

    let netDelta = 0;
    if (mult > 0) {
      const gain = parseFloat((amt * mult).toFixed(6));
      netDelta = parseFloat((gain - amt).toFixed(6));
      await query('UPDATE users SET balance = balance + $1, total_earned = total_earned + $2 WHERE username = $3', [netDelta, netDelta > 0 ? netDelta : 0, user.username]);
      await addHistory(user.username, netDelta, 'slots_win');
    } else {
      netDelta = -amt;
      await query('UPDATE users SET balance = balance - $1 WHERE username = $2', [amt, user.username]);
      await addHistory(user.username, -amt, 'slots_lose');
    }

    const updated = await query('SELECT balance FROM users WHERE username = $1', [user.username]);
    console.log(`[SLOTS] ${user.username} → ${reels.map(r=>r.sym).join('')} mult:${mult} netDelta:${netDelta}`);
    return json(res, 200, { ok: true, reels: reels.map(r => ({ sym: r.sym, name: r.name, mult: r.mult })), mult, label, netDelta, balance: updated.rows[0].balance });
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
