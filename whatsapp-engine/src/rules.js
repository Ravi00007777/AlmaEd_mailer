// Pure helpers: names, phones, emails, opt-out detection, reply classification, message templates.
'use strict';

// ---------------------------------------------------------------- names
const TITLES = /^(dr|mr|mrs|ms|miss|prof|er|shri|smt|col|capt|lt|maj|gen|cdr|brig|adv|ca|md|mohd)\.?$/i;
const SHORT_NAMES = ['om', 'jo', 'ed', 'al', 'li', 'yu', 'ng', 'bo'];

function cleanName(raw) {
  return String(raw == null ? '' : raw).split(',')[0]
    .replace(/\b(dr|mr|mrs|ms|prof|er|col|capt|lt|maj|gen|brig|adv)\.(?=\S)/gi, '$1. ')
    .replace(/\(.*?\)/g, ' ').replace(/\[.*?\]/g, ' ')
    .replace(/[^A-Za-z.\s'\-]/g, ' ').replace(/\s+/g, ' ').trim();
}
const titleCase = (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
const nameParts = (raw) => cleanName(raw).split(' ').filter((p) => p && !TITLES.test(p));
function isInitials(p) {
  const letters = p.replace(/\./g, '');
  return letters.length <= 2 && !SHORT_NAMES.includes(letters.toLowerCase());
}
function fullName(raw) {
  return nameParts(raw).map((p) => (isInitials(p) ? p.replace(/\./g, '').toUpperCase() : p.split('-').map(titleCase).join('-'))).join(' ');
}
/** "Atreyi Banerjee" -> "Atreyi"; "DK Mishra" -> "DK Mishra"; "" -> "" (message then says "Hi there") */
function firstName(raw) {
  const parts = nameParts(raw);
  if (!parts.length) return '';
  if (!isInitials(parts[0])) return titleCase(parts[0].replace(/\./g, ''));
  return parts.length > 1 ? fullName(raw) : '';
}

// ---------------------------------------------------------------- phones
/** Returns a WhatsApp-ready Indian mobile like "919876543210", or "" if none found. */
function normalisePhone(value) {
  const s = String(value == null ? '' : value);
  const re = /(?:\+?91[\s\-]?|\b0)?([6-9]\d{2}[\s\-]?\d{2}[\s\-]?\d{5}|[6-9]\d{4}[\s\-]?\d{5}|[6-9]\d{9})(?!\d)/g;
  let m;
  while ((m = re.exec(s))) {
    const before = s[m.index - 1];
    if (before && /\d/.test(before)) continue;      // part of a longer number
    const digits = m[1].replace(/\D/g, '');
    if (digits.length === 10) return '91' + digits;
  }
  return '';
}

// ---------------------------------------------------------------- emails (to match the email campaign)
const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}/g;
const PERSONAL_DOMAINS = ['gmail.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.in', 'hotmail.com', 'outlook.com', 'live.com',
  'rediffmail.com', 'icloud.com', 'me.com', 'protonmail.com', 'proton.me', 'ymail.com', 'aol.com', 'msn.com'];
function pickEmail(cells) {
  const found = [];
  for (const c of cells) {
    for (const e of String(c == null ? '' : c).match(EMAIL_RE) || []) {
      const x = e.toLowerCase().replace(/^[.\-]+|[.\-]+$/g, '');
      if (!found.includes(x)) found.push(x);
    }
  }
  const rank = (e) => { const d = e.split('@')[1]; return PERSONAL_DOMAINS.includes(d) ? 0 : /iitkgp\.(ac|ernet)\.in$/.test(d) ? 2 : 1; };
  found.sort((a, b) => rank(a) - rank(b));
  return found[0] || '';
}

// ---------------------------------------------------------------- opt-outs in the calling notes
// "DNC"/"DNP" in these notes mean did-not-connect / did-not-pick, so they are NOT opt-outs.
const SKIP_RULES = [
  { re: /passed away|expired|\bdied\b|\bdeceased\b/i, why: 'passed away' },
  { re: /\bblock/i, why: 'blocked the caller' },
  { re: /not (an? )?alum/i, why: 'not an alumnus' },
  { re: /not interest|no interest|declin|denied|reject|do not want|don'?t want|not to (call|contact)|told (us )?(to )?stop|don'?t (call|contact)|do not (call|contact)|unsubscribe|remove me/i, why: 'said not interested' },
  { re: /wrong\s*(no|num|number)|invalid/i, why: 'wrong number' },
];
function skipReason(cells, fromCol) {
  for (let i = fromCol; i < cells.length; i++) {
    const t = String(cells[i] == null ? '' : cells[i]);
    if (!t || t.includes('@')) continue;
    for (const r of SKIP_RULES) if (r.re.test(t)) return r.why;
  }
  return '';
}

// ---------------------------------------------------------------- replies
const NEGATIVE = /not interested|no thanks|no thank you|\bstop\b|unsubscribe|remove me|don'?t (message|msg|text|contact)|do not (message|msg|text|contact)|wrong number|not required|no requirement|not needed|no need|not looking|no (kids|children|child)|don'?t have (any )?(kids|children|child)|do not have (any )?(kids|children|child)|kids are (grown|working|settled)|not now|\bspam\b|who gave you my number/i;
const NEGATIVE_SHORT = /^(no+|nope|nah|nahi+n?|nai|na|not really|no sir|no ma'?am|sorry,? no)[\s.!]*$/i;
const POSITIVE = /\b(yes+|yeah|yep|yup|sure|ok+a?y?|okk+|haa?n?|ha+|haan ji|interested|please share|pls share|plz share|kindly share|share (the |more )?details|send (the |more )?details|tell me more|more (details|info)|details please|go ahead|why not|definitely|of course|absolutely)\b|my (son|daughter|kid|child|nephew|niece|grand ?son|grand ?daughter)|👍/i;

/** Classifies a first reply: 'positive' (auto-send details), 'negative' (stop), or 'other' (needs you). */
function classifyReply(text) {
  const t = String(text || '').trim();
  if (!t) return 'other';
  if (NEGATIVE.test(t) || NEGATIVE_SHORT.test(t)) return 'negative';
  if (/who (is|are) (this|you|u)|\bkaun\b|how did you get my number/i.test(t)) return 'other';   // a human should answer this
  if (POSITIVE.test(t)) return 'positive';
  return 'other';
}

// ---------------------------------------------------------------- templates
/** Fills {first}/{name} and picks one option from each [[a|b|c]] so no two messages are byte-identical. */
function renderMessage(template, person, rand = Math.random) {
  const first = person.first || 'there';
  return String(template)
    .replace(/\[\[([^\]]+)\]\]/g, (_, opts) => { const o = opts.split('|'); return o[Math.floor(rand() * o.length)]; })
    .replace(/\{first\}/g, first)
    .replace(/\{name\}/g, person.name || first);
}

module.exports = { firstName, fullName, normalisePhone, pickEmail, skipReason, classifyReply, renderMessage };
