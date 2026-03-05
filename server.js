// ============================================================
//  ARCH SERVER — Art Rarity Collection Hub
//  Lance avec : node server.js
// ============================================================

const http = require('http');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============================================================
//  CONFIG
// ============================================================
const CONFIG = {
  port:         process.env.PORT || 3000,
  currency:     'ARCH',
  scanInterval: 60,      // secondes totales par cycle
  scanDuration: 50,      // secondes d'animation de scan
  claimWindow:  10,      // secondes pour claim après scan
  dbFile:       './arch.db',
  adminPass:    'CHANGE_MOI',  // ← change avant de deploy !
};

// ============================================================
//  GÉNÉRATEUR DE RÉCOMPENSE
//  Format : 0.000000 → 9.999999
//  La quasi-totalité des résultats sera < 0.01
//  Avoir >= 1.0 est rarissime
// ============================================================
function generateReward() {
  const r = Math.random();

  // Répartition des probabilités
  if (r < 0.60) {
    // 60% → micro reward : 0.000001 – 0.000999
    return parseFloat((Math.random() * 0.000999 + 0.000001).toFixed(6));
  } else if (r < 0.85) {
    // 25% → petit reward : 0.001000 – 0.009999
    return parseFloat((Math.random() * 0.008999 + 0.001).toFixed(6));
  } else if (r < 0.96) {
    // 11% → reward moyen : 0.010000 – 0.099999
    return parseFloat((Math.random() * 0.089999 + 0.01).toFixed(6));
  } else if (r < 0.995) {
    // 3.5% → bon reward : 0.100000 – 0.999999
    return parseFloat((Math.random() * 0.899999 + 0.1).toFixed(6));
  } else if (r < 0.9995) {
    // 0.45% → gros reward : 1.000000 – 4.999999
    return parseFloat((Math.random() * 3.999999 + 1.0).toFixed(6));
  } else {
    // 0.05% → jackpot : 5.000000 – 9.999999
    return parseFloat((Math.random() * 4.999999 + 5.0).toFixed(6));
  }
}

// ============================================================
//  BASE DE DONNÉES JSON
// ============================================================
let db = { users: {}, sessions: {}, pending_claims: {} };

function loadDB() {
  if (fs.existsSync(CONFIG.dbFile)) {
    try { db = JSON.parse(fs.readFileSync(CONFIG.dbFile, 'utf8')); }
    catch(e) { console.log('[DB] Corrompue, reset.'); }
  }
  db.users         = db.users         || {};
  db.sessions      = db.sessions      || {};
  db.pending_claims = db.pending_claims || {};
}

function saveDB() {
  fs.writeFileSync(CONFIG.dbFile, JSON.stringify(db, null, 2));
}

loadDB();
setInterval(saveDB, 20000);

// ============================================================
//  UTILS
// ============================================================
function hash(pass)  { return crypto.createHash('sha256').update(pass + 'arch_s4lt').digest('hex'); }
function token()     { return crypto.randomBytes(32).toString('hex'); }
function getUser(tk) { const u = db.sessions[tk]; return u ? db.users[u] : null; }

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type':  'application/json',
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
    req.on('end',  () => { try { resolve(JSON.parse(s)); } catch { resolve({}); } });
  });
}

// ============================================================
//  NETTOYAGE CLAIMS EXPIRÉS
// ============================================================
setInterval(() => {
  const now = Date.now();
  for (const [u, claim] of Object.entries(db.pending_claims)) {
    if (now > claim.expires_at) {
      // Donne 50% de la reward automatiquement
      if (db.users[u]) {
        const half = parseFloat((claim.reward / 2).toFixed(6));
        db.users[u].balance      += half;
        db.users[u].total_earned += half;
        db.users[u].history.unshift({ amount: half, at: new Date().toISOString(), auto: true });
        if (db.users[u].history.length > 100) db.users[u].history.pop();
        console.log(`[EXPIRE] ${u} → 50% auto : +${half} ARCH`);
      }
      delete db.pending_claims[u];
    }
  }
}, 3000);

// ============================================================
//  API ROUTES
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
    if (db.users[username])
      return json(res, 400, { error: 'Pseudo déjà pris.' });
    db.users[username] = {
      username, password: hash(password),
      balance: 0, total_earned: 0,
      scans: 0, claims: 0,
      last_scan: 0,
      history: [],
      created_at: new Date().toISOString(),
    };
    saveDB();
    console.log(`[REGISTER] ${username}`);
    return json(res, 200, { ok: true });
  }

  // LOGIN
  if (endpoint === '/api/login' && req.method === 'POST') {
    const { username, password } = await body(req);
    const user = db.users[username];
    if (!user || user.password !== hash(password))
      return json(res, 401, { error: 'Identifiants incorrects.' });
    const tok = token();
    db.sessions[tok] = username;
    saveDB();
    console.log(`[LOGIN] ${username}`);
    return json(res, 200, { ok: true, token: tok, username });
  }

  // SCAN — le client envoie ça au début du cycle (le serveur génère la reward à l'avance)
  if (endpoint === '/api/scan' && req.method === 'POST') {
    const user = getUser(tk);
    if (!user) return json(res, 401, { error: 'Non connecté.' });

    const now     = Date.now();
    const elapsed = (now - user.last_scan) / 1000;

    if (elapsed < CONFIG.scanInterval - 2) {
      const wait = Math.ceil(CONFIG.scanInterval - elapsed);
      return json(res, 429, { error: `Attends encore ${wait}s.`, wait });
    }

    // Générer la reward maintenant (le client l'animera)
    const reward = generateReward();
    user.last_scan = now;
    user.scans++;

    // Stocker le claim en attente (expire après scanDuration + claimWindow)
    db.pending_claims[user.username] = {
      reward,
      expires_at: now + (CONFIG.scanDuration + CONFIG.claimWindow) * 1000,
    };

    saveDB();
    console.log(`[SCAN] ${user.username} → reward générée : ${reward} ARCH`);

    return json(res, 200, {
      ok: true,
      reward,                        // le client anime ce chiffre
      scan_duration:  CONFIG.scanDuration,
      claim_window:   CONFIG.claimWindow,
    });
  }

  // CLAIM — le client appuie sur "Claim" pendant la fenêtre de 10s
  if (endpoint === '/api/claim' && req.method === 'POST') {
    const user  = getUser(tk);
    if (!user) return json(res, 401, { error: 'Non connecté.' });

    const claim = db.pending_claims[user.username];
    if (!claim)       return json(res, 400, { error: 'Rien à claim.' });
    if (Date.now() > claim.expires_at) {
      delete db.pending_claims[user.username];
      return json(res, 400, { error: 'Trop tard — reward expirée.' });
    }

    user.balance      += claim.reward;
    user.total_earned += claim.reward;
    user.claims++;
    user.history.unshift({
      amount: claim.reward,
      at:     new Date().toISOString(),
    });
    if (user.history.length > 100) user.history.pop();
    delete db.pending_claims[user.username];

    saveDB();
    console.log(`[CLAIM] ${user.username} → +${claim.reward} ARCH`);

    return json(res, 200, { ok: true, reward: claim.reward, balance: user.balance });
  }

  // EXPIRE — le client appelle ça quand le claim window expire (donne 50%)
  if (endpoint === '/api/expire' && req.method === 'POST') {
    const user  = getUser(tk);
    if (!user) return json(res, 401, { error: 'Non connecté.' });
    const claim = db.pending_claims[user.username];
    if (!claim) return json(res, 200, { ok: true, reward: 0 }); // déjà expiré côté serveur
    const half = parseFloat((claim.reward / 2).toFixed(6));
    user.balance      += half;
    user.total_earned += half;
    user.history.unshift({ amount: half, at: new Date().toISOString(), auto: true });
    if (user.history.length > 100) user.history.pop();
    delete db.pending_claims[user.username];
    saveDB();
    console.log(`[EXPIRE] ${user.username} → 50% : +${half} ARCH`);
    return json(res, 200, { ok: true, reward: half, balance: user.balance });
  }
  if (endpoint === '/api/me' && req.method === 'GET') {
    const user = getUser(tk);
    if (!user) return json(res, 401, { error: 'Non connecté.' });
    const claim = db.pending_claims[user.username];
    return json(res, 200, {
      username:      user.username,
      balance:       user.balance,
      total_earned:  user.total_earned,
      scans:         user.scans,
      claims:        user.claims,
      history:       user.history.slice(0, 20),
      next_scan_in:  Math.max(0, Math.ceil(CONFIG.scanInterval - (Date.now() - user.last_scan) / 1000)),
      pending_claim: claim ? { reward: claim.reward, expires_at: claim.expires_at } : null,
    });
  }

  // LEADERBOARD
  if (endpoint === '/api/leaderboard' && req.method === 'GET') {
    const board = Object.values(db.users)
      .map(u => ({ username: u.username, balance: u.balance, scans: u.scans, claims: u.claims }))
      .sort((a, b) => b.balance - a.balance)
      .slice(0, 10);
    return json(res, 200, { leaderboard: board });
  }

  // ADMIN
  if (endpoint === '/api/admin/users' && req.method === 'GET') {
    if (url.searchParams.get('pass') !== CONFIG.adminPass)
      return json(res, 403, { error: 'Accès refusé.' });
    const users = Object.values(db.users).map(u => ({
      username: u.username, balance: u.balance,
      total_earned: u.total_earned, scans: u.scans, claims: u.claims,
    }));
    return json(res, 200, { users });
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

server.listen(CONFIG.port, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   ARCH                                       ║');
  console.log(`║   http://localhost:${CONFIG.port}                     ║`);
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
  console.log('  Scan cycle  : ' + CONFIG.scanInterval + 's');
  console.log('  Scan anim   : ' + CONFIG.scanDuration + 's');
  console.log('  Claim window: ' + CONFIG.claimWindow + 's');
  console.log('');
});
