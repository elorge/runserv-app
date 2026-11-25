#!/usr/bin/env node
/* Compares every locale in src/i18n/locales to en.json.
 * Reports missing keys and (non-English) values identical to English.
 * Exit 1 on any gap.  Usage: node mobile/scripts/i18n-parity.js [--json] */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'src', 'i18n', 'locales');
const IGNORE_KEYS = new Set(['_comment']);
// Strings that are legitimately identical across languages.
const UNIVERSAL = new Set(['ok', 'sms', 'email', 'gps', 'id', 'pin', 'wi-fi', 'wifi', 'qr', 'vip', 'n/a', 'ussd', 'nin', 'bvn']);

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

function exempt(key, value) {
  if (IGNORE_KEYS.has(key)) return true;
  if (typeof value !== 'string') return true;
  const stripped = value.replace(/\{\{[^}]*\}\}/g, '').replace(/\{[^}]*\}/g, '');
  const letters = stripped.replace(/[^\p{L}]/gu, '');
  if (letters.length === 0) return true;                 // numbers / placeholders / symbols only
  if (UNIVERSAL.has(value.trim().toLowerCase())) return true;
  if (letters.length <= 3) return true;                  // very short universal strings
  if (/^[A-Z0-9][A-Za-z0-9]*(\s[A-Z0-9][A-Za-z0-9]*)?$/.test(value.trim()) && /(Runserv|WhatsApp|Paystack|Flutterwave|Google|Apple|Facebook|Uber|Bolt|Stripe|M-?Pesa|Visa|Mastercard|PayPal|Telegram|Instagram|Twitter|TikTok|Opay|Palmpay|Moniepoint)/i.test(value)) return true; // brand names
  if (/^(https?:\/\/|mailto:|tel:|\+?[\d\s()-]+$)/.test(value.trim())) return true;
  return false;
}

function run() {
  const load = f => flatten(JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
  const en = load('en.json');
  const report = {};
  let gaps = 0;
  for (const f of fs.readdirSync(DIR).filter(f => f.endsWith('.json') && f !== 'en.json').sort()) {
    const loc = load(f);
    const missing = Object.keys(en).filter(k => !IGNORE_KEYS.has(k) && !(k in loc));
    const untranslated = Object.keys(en).filter(k => k in loc && !exempt(k, en[k]) && loc[k] === en[k]);
    const extra = Object.keys(loc).filter(k => !IGNORE_KEYS.has(k) && !(k in en));
    report[f.replace('.json', '')] = { missing, untranslated, extra };
    gaps += missing.length + untranslated.length;
  }
  if (process.argv.includes('--json')) { console.log(JSON.stringify(report, null, 2)); }
  else {
    for (const [l, r] of Object.entries(report)) {
      console.log(`${l}: missing=${r.missing.length} untranslated=${r.untranslated.length} extra=${r.extra.length}`);
      if (process.argv.includes('--verbose')) { r.missing.forEach(k => console.log(`  MISSING ${k}`)); r.untranslated.forEach(k => console.log(`  SAME    ${k}`)); }
    }
  }
  if (gaps) { console.error(`\ni18n parity: ${gaps} gap(s). Run with --verbose for keys.`); process.exit(1); }
  console.log('i18n parity OK');
}
module.exports = { flatten, exempt };
if (require.main === module) run();
