/**
 * Auth.gs — Guest Ops Dashboard
 *
 * Password storage and verification, moved out of Guest_Ops_System_Database
 * and off single-round SHA-256.
 *
 * Two things change:
 *   1. Credentials live in their own private spreadsheet, so they can never be
 *      caught up in a "Publish to web" on the main workbook.
 *   2. Passwords are checked with PBKDF2-HMAC-SHA256 instead of one SHA-256
 *      round, which makes offline guessing orders of magnitude slower.
 *
 * Nobody has to reset a password. On a successful sign-in, a user still
 * carrying a legacy hash is transparently re-hashed into the new sheet.
 *
 * ---------------------------------------------------------------------------
 * SETUP — see CUTOVER.md. In short:
 *   1. Paste this file into the Apps Script project as a new file "Auth".
 *   2. Fill in LEGACY_SHEET_ID below.
 *   3. Run benchmarkPbkdf2() and set PBKDF2_ITERATIONS from what it prints.
 *   4. Run selfTest(). It must print ALL PASS.
 *   5. Point your existing login handler at verifyLogin().
 * ---------------------------------------------------------------------------
 */

// ===== CONFIG ==============================================================

/** The new private auth spreadsheet. Never publish or share this file. */
var AUTH_SHEET_ID = '118gN0uOaJ0LrklrYhiBOq9nNzCb3Iwi-_628Dv4zv2w';
var AUTH_TAB = 'Sheet1';

/** The old workbook, read only during migration. Set this, then empty it
 *  again once migrationStatus() reports everyone migrated. */
var LEGACY_SHEET_ID = '1ZhIPPRnYZynXsl07PfnkjlR4lhhpx3HHuR0q6HrPlHM';
var LEGACY_TAB = '';   // <-- name of the tab holding username|name|salt|hash

/** Set by benchmarkPbkdf2(). Higher is stronger and slower. */
var PBKDF2_ITERATIONS = 20000;

/** Once detectLegacyScheme() tells you which variant your old hashes use,
 *  put its number here. 0 means "try them all" — fine, just slower. */
var LEGACY_VARIANT = 0;

// ===== PUBLIC API ==========================================================

/**
 * Verify a sign-in. Returns {ok:true, name:...} or {ok:false}.
 * Deliberately gives no detail about WHY a sign-in failed.
 */
function verifyLogin(username, password) {
  username = String(username || '').trim().toLowerCase();
  password = String(password || '');
  if (!username || !password) return { ok: false };

  var rec = authLookup_(username);
  if (!rec) {
    // Spend comparable time on an unknown user so response timing doesn't
    // reveal whether the username exists.
    pbkdf2Sha256_(password, randomSaltBytes_(), PBKDF2_ITERATIONS);
    return { ok: false };
  }

  // --- Path 1: already migrated -----------------------------------------
  if (rec.hash && rec.salt && String(rec.algo || '').indexOf('pbkdf2') === 0) {
    var iters = Number(rec.iterations) || PBKDF2_ITERATIONS;
    var computed = toHex_(pbkdf2Sha256_(password, fromHex_(rec.salt), iters));
    if (!constantTimeEquals_(computed, rec.hash)) return { ok: false };

    // Opportunistically raise the work factor if we've since increased it.
    if (iters < PBKDF2_ITERATIONS) writeNewHash_(username, password);
    return { ok: true, name: rec.name || username };
  }

  // --- Path 2: legacy, verify then upgrade in place ----------------------
  var legacy = legacyLookup_(username);
  if (!legacy) return { ok: false };
  if (!legacyMatches_(username, password, legacy)) return { ok: false };

  writeNewHash_(username, password, legacy.name);
  return { ok: true, name: legacy.name || username };
}

/**
 * Admin helper. Sets or resets one user's password from the editor.
 *   setPassword('sophie', 'the new password')
 */
function setPassword(username, password) {
  if (!username || !password) throw new Error('setPassword(username, password)');
  if (String(password).length < 12) {
    throw new Error('Use at least 12 characters.');
  }
  writeNewHash_(String(username).trim().toLowerCase(), String(password));
  return 'Set. Tell them their new password over a channel you trust.';
}

/** Adds a new person with a generated password, which it returns once. */
function addUser(username, displayName) {
  username = String(username || '').trim().toLowerCase();
  if (!username) throw new Error('addUser(username, displayName)');
  if (authLookup_(username)) throw new Error('That username already exists.');

  var sh = authSheet_();
  sh.appendRow([username, displayName || username, '', '', '', '', '']);
  var pw = generatePassword_();
  writeNewHash_(username, pw);
  return 'Password for ' + username + ': ' + pw +
         '  — copy it now, it is not stored anywhere in readable form.';
}

/** Removes a person. Run this the same day someone leaves. */
function removeUser(username) {
  username = String(username || '').trim().toLowerCase();
  var sh = authSheet_(), vals = sh.getDataRange().getValues();
  for (var i = vals.length - 1; i >= 1; i--) {
    if (String(vals[i][0]).trim().toLowerCase() === username) {
      sh.deleteRow(i + 1);
      return 'Removed ' + username + '. They also need removing from the old tab if it still exists.';
    }
  }
  return 'No such user.';
}

/** Who has migrated and who is still on a legacy hash. */
function migrationStatus() {
  var sh = authSheet_(), vals = sh.getDataRange().getValues();
  var done = [], pending = [];
  for (var i = 1; i < vals.length; i++) {
    var u = String(vals[i][0]).trim();
    if (!u) continue;
    var migrated = vals[i][3] && String(vals[i][4] || '').indexOf('pbkdf2') === 0;
    (migrated ? done : pending).push(u);
  }
  var msg = 'Migrated (' + done.length + '): ' + (done.join(', ') || '—') +
            '\nStill legacy (' + pending.length + '): ' + (pending.join(', ') || '—') +
            '\n\n' + (pending.length === 0
              ? 'Everyone is migrated. Safe to delete the old credentials tab and blank LEGACY_SHEET_ID.'
              : 'Leave the old tab in place until this list is empty.');
  Logger.log(msg);
  return msg;
}

// ===== PBKDF2 ==============================================================

/**
 * PBKDF2-HMAC-SHA256, 32-byte output (one block, so no outer loop needed).
 * Apps Script has no bcrypt/scrypt/argon2, and computeDigest is a single
 * round, so this is the strongest primitive actually available here.
 */
function pbkdf2Sha256_(password, saltBytes, iterations) {
  var pw = Utilities.newBlob(password).getBytes();
  var block = saltBytes.concat([0, 0, 0, 1]);          // INT_32_BE(1)
  var u = Utilities.computeHmacSha256Signature(block, pw);
  var t = u.slice(0);
  for (var i = 1; i < iterations; i++) {
    u = Utilities.computeHmacSha256Signature(u, pw);
    for (var j = 0; j < t.length; j++) t[j] ^= u[j];
  }
  return t;
}

/**
 * Prints how long various iteration counts take on this deployment, so you
 * can pick one. Aim for the largest count that stays under ~1 second —
 * every sign-in pays this cost, and Apps Script caps execution at 6 minutes.
 */
function benchmarkPbkdf2() {
  var out = ['PBKDF2-HMAC-SHA256 on this deployment:', ''];
  var salt = randomSaltBytes_();
  [5000, 10000, 20000, 50000, 100000].forEach(function (n) {
    var t0 = Date.now();
    pbkdf2Sha256_('benchmark-password', salt, n);
    var ms = Date.now() - t0;
    out.push('  ' + String(n).padStart(7) + ' iterations → ' + ms + ' ms' +
             (ms > 1500 ? '   (too slow for a login)' : ms < 250 ? '   (room to go higher)' : '   (good)'));
  });
  out.push('', 'Set PBKDF2_ITERATIONS to the largest count marked "good".');
  var msg = out.join('\n');
  Logger.log(msg);
  return msg;
}

// ===== LEGACY ==============================================================

/**
 * The old scheme was one SHA-256 round over some arrangement of salt and
 * password. These are the arrangements worth trying.
 */
function legacyHashVariant_(variant, username, password, salt) {
  var s;
  switch (variant) {
    case 1: s = salt + password; break;
    case 2: s = password + salt; break;
    case 3: s = salt + ':' + password; break;
    case 4: s = password + ':' + salt; break;
    case 5: s = username + salt + password; break;
    default: return null;
  }
  return toHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8));
}

function legacyMatches_(username, password, legacy) {
  var variants = LEGACY_VARIANT ? [LEGACY_VARIANT] : [1, 2, 3, 4, 5];
  for (var i = 0; i < variants.length; i++) {
    var h = legacyHashVariant_(variants[i], username, password, legacy.salt);
    if (h && constantTimeEquals_(h, String(legacy.hash).trim().toLowerCase())) return true;
  }
  return false;
}

/**
 * Run this ONCE from the editor with your own username and current password.
 * It tells you which arrangement the old hashes use, so you can pin
 * LEGACY_VARIANT and stop trying five of them on every legacy sign-in.
 *
 * Clear the password out of the editor afterwards — Apps Script keeps
 * an edit history.
 */
function detectLegacyScheme(username, currentPassword) {
  var legacy = legacyLookup_(String(username).trim().toLowerCase());
  if (!legacy) return 'No legacy row for that username. Check LEGACY_TAB.';
  for (var v = 1; v <= 5; v++) {
    var h = legacyHashVariant_(v, username, currentPassword, legacy.salt);
    if (h === String(legacy.hash).trim().toLowerCase()) {
      var msg = 'Matched variant ' + v + '. Set LEGACY_VARIANT = ' + v + ';';
      Logger.log(msg);
      return msg;
    }
  }
  return 'No variant matched. Either the password is wrong, or the old scheme ' +
         'is something else — send me a description of the login code and I will extend this.';
}

// ===== SHEET ACCESS ========================================================

function authSheet_() {
  var ss = SpreadsheetApp.openById(AUTH_SHEET_ID);
  return (AUTH_TAB && ss.getSheetByName(AUTH_TAB)) || ss.getSheets()[0];
}

function authLookup_(username) {
  var vals = authSheet_().getDataRange().getValues();
  for (var i = 1; i < vals.length; i++) {
    if (String(vals[i][0]).trim().toLowerCase() === username) {
      return {
        row: i + 1, username: username, name: vals[i][1],
        salt: String(vals[i][2] || '').trim(),
        hash: String(vals[i][3] || '').trim().toLowerCase(),
        algo: vals[i][4], iterations: vals[i][5]
      };
    }
  }
  return null;
}

function legacyLookup_(username) {
  if (!LEGACY_SHEET_ID) return null;
  var ss = SpreadsheetApp.openById(LEGACY_SHEET_ID);
  var sh = (LEGACY_TAB && ss.getSheetByName(LEGACY_TAB));
  if (!sh) return null;
  var vals = sh.getDataRange().getValues();
  var head = vals[0].map(function (h) { return String(h).trim().toLowerCase(); });
  var cU = head.indexOf('username'), cN = head.indexOf('name'),
      cS = head.indexOf('salt'), cH = head.indexOf('hash');
  if (cU < 0 || cS < 0 || cH < 0) return null;
  for (var i = 1; i < vals.length; i++) {
    if (String(vals[i][cU]).trim().toLowerCase() === username) {
      return { name: cN >= 0 ? vals[i][cN] : '', salt: String(vals[i][cS]).trim(), hash: String(vals[i][cH]).trim() };
    }
  }
  return null;
}

/** Hash `password` freshly and store it. Creates the row if missing. */
function writeNewHash_(username, password, displayName) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = authSheet_(), rec = authLookup_(username), row;
    if (rec) {
      row = rec.row;
    } else {
      sh.appendRow([username, displayName || username, '', '', '', '', '']);
      row = sh.getLastRow();
    }
    var salt = randomSaltBytes_();
    var hash = toHex_(pbkdf2Sha256_(password, salt, PBKDF2_ITERATIONS));
    sh.getRange(row, 3, 1, 5).setValues([[
      toHex_(salt), hash, 'pbkdf2-sha256', PBKDF2_ITERATIONS, new Date()
    ]]);
    if (displayName && !sh.getRange(row, 2).getValue()) {
      sh.getRange(row, 2).setValue(displayName);
    }
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
}

// ===== SMALL HELPERS =======================================================

function randomSaltBytes_() {
  var b = [];
  for (var i = 0; i < 16; i++) b.push(Math.floor(Math.random() * 256) - 128);
  // Fold in a UUID so we are not relying on Math.random alone.
  var extra = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Date.now(), Utilities.Charset.UTF_8);
  for (var j = 0; j < 16; j++) b[j] ^= extra[j];
  return b;
}

function toHex_(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) {
    var v = (bytes[i] + 256) % 256;
    s += (v < 16 ? '0' : '') + v.toString(16);
  }
  return s;
}

function fromHex_(hex) {
  hex = String(hex || '');
  var out = [];
  for (var i = 0; i + 1 < hex.length; i += 2) {
    var v = parseInt(hex.substr(i, 2), 16);
    out.push(v > 127 ? v - 256 : v);
  }
  return out;
}

/** Compares without leaking, through timing, how much of the value matched. */
function constantTimeEquals_(a, b) {
  a = String(a); b = String(b);
  var diff = a.length ^ b.length;
  var n = Math.max(a.length, b.length);
  for (var i = 0; i < n; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function generatePassword_() {
  var abc = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var s = '';
  for (var i = 0; i < 20; i++) s += abc.charAt(Math.floor(Math.random() * abc.length));
  return s;
}

// ===== SELF TEST ===========================================================

/** Run before cutting over. Must print ALL PASS. */
function selfTest() {
  var out = [], pass = true;
  function check(label, ok) { out.push((ok ? '  PASS  ' : '  FAIL  ') + label); if (!ok) pass = false; }

  // Known PBKDF2-HMAC-SHA256 vector (RFC 7914 §11 / common test set):
  // P="password", S="salt", c=1, dkLen=32
  var v1 = toHex_(pbkdf2Sha256_('password', Utilities.newBlob('salt').getBytes(), 1));
  check('PBKDF2 vector c=1', v1 === '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b');

  // c=2
  var v2 = toHex_(pbkdf2Sha256_('password', Utilities.newBlob('salt').getBytes(), 2));
  check('PBKDF2 vector c=2', v2 === 'ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43');

  // hex round trip
  var salt = randomSaltBytes_();
  check('hex round trip', toHex_(fromHex_(toHex_(salt))) === toHex_(salt));

  // constant-time compare still compares correctly
  check('compare equal', constantTimeEquals_('abc123', 'abc123'));
  check('compare differing', !constantTimeEquals_('abc123', 'abc124'));
  check('compare length', !constantTimeEquals_('abc', 'abcd'));

  // salts differ between calls
  check('salts unique', toHex_(randomSaltBytes_()) !== toHex_(randomSaltBytes_()));

  // sheet reachable
  var reachable = true;
  try { authSheet_().getDataRange().getValues(); } catch (e) { reachable = false; }
  check('auth sheet reachable', reachable);

  var msg = out.join('\n') + '\n\n' + (pass ? 'ALL PASS' : 'SOMETHING FAILED — do not cut over');
  Logger.log(msg);
  return msg;
}
