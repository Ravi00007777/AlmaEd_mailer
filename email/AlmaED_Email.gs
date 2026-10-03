/**
 * AlmaED alumni email sender (Google Apps Script, bound to the alumni Sheet)
 *
 * Adds an "AlmaED Email" menu to the Sheet:
 *   1. Set up / refresh email list  - builds the "Email list" tab from every region tab
 *   2. Send a test email to me      - sends one sample to the account running this script
 *   3. Send next batch now          - sends the next few emails straight away
 *   4. Start auto-send (hourly)     - sends a small batch every hour within sending hours
 *      Stop auto-send
 *      Show progress
 *
 * Only rows in "Email list" whose Status cell is EMPTY are emailed.
 * Type anything in Status (e.g. "Skip") to leave a person out.
 * Edit the subject, body and limits in the "Email template" tab - no code changes needed.
 */

// ---------------------------------------------------------------- settings
var LIST_TAB = 'Email list';
var TEMPLATE_TAB = 'Email template';
var NOT_REGION_TABS = ['Distribution', 'WhatsApp message', LIST_TAB, TEMPLATE_TAB];
var NAME_COL = 0;            // column A holds the person's name in every region tab
var TZ = 'Asia/Kolkata';
var MAX_RUN_MS = 4.5 * 60 * 1000;   // stay safely under Apps Script's 6-minute limit

var DEFAULT_SUBJECT = "A fellow KGPian's request: 1-on-1 mentoring for school students";
var DEFAULT_BODY = [
  'Hi {first},',
  '',
  "I hope you're doing well! I'm Kesav Krishna K, a fourth-year undergraduate in the Department of Physics at IIT Kharagpur, writing to you as a fellow KGPian.",
  '',
  'A few of us from IITs, NITs and AIIMS have started AlmaED, where we personally mentor school and college students 1-on-1 in Physics, Chemistry, Maths and Biology, from board exams to JEE and NEET prep. Every student gets their own mentor, classes at their own pace, assignments after each class and a weekly test.',
  '',
  'I wanted to ask: do you have a child in school or college, or know a family looking for a good mentor? If so, you can book a free 30-minute demo class here, and parents are welcome to sit in: https://calendar.app.google/SUAnzMcYiJitqbpx5',
  '',
  'Our one-minute film: https://www.youtube.com/shorts/us1mpFiuR2g',
  'AlmaED on LinkedIn: https://www.linkedin.com/company/almaed/',
  '',
  'Thank you for your time!',
  '',
  'Warm regards,',
  'Kesav Krishna K',
  'Department of Physics, IIT Kharagpur',
  'https://www.linkedin.com/in/kesav-krishna-k/',
  '',
  'P.S. If this isn\'t relevant to you, just reply "no" and I won\'t write again.'
].join('\n');

// ---------------------------------------------------------------- core helpers
var EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}/g;
var PERSONAL_DOMAINS = ['gmail.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.in', 'hotmail.com', 'outlook.com', 'live.com',
  'rediffmail.com', 'icloud.com', 'me.com', 'protonmail.com', 'proton.me', 'ymail.com', 'aol.com', 'msn.com'];
// Notes in the calling sheet that mean we should NOT email this person.
// ("DNC"/"DNP" in these notes mean did-not-connect / did-not-pick, so they are NOT treated as opt-outs.)
var SKIP_RULES = [
  {re: /passed away|expired|\bdied\b|\bdeceased\b/i, why: 'passed away'},
  {re: /\bblock/i, why: 'blocked the caller'},
  {re: /not (an? )?alum/i, why: 'not an alumnus'},
  {re: /not interest|no interest|declin|denied|reject|do not want|don'?t want|not to (call|contact)|told (us )?(to )?stop|don'?t (call|contact)|do not (call|contact)|unsubscribe|remove me/i, why: 'said not interested'}
];
var TITLES = /^(dr|mr|mrs|ms|miss|prof|er|shri|smt|col|capt|lt|maj|gen|cdr|brig|adv|ca|md|mohd)\.?$/i;
var SHORT_NAMES = ['om', 'jo', 'ed', 'al', 'li', 'yu', 'ng', 'bo'];   // real 2-letter first names (not initials)

function pickEmail(cells) {
  var found = [];
  for (var i = 0; i < cells.length; i++) {
    var m = String(cells[i] == null ? '' : cells[i]).match(EMAIL_RE);
    if (m) for (var j = 0; j < m.length; j++) {
      var e = m[j].toLowerCase().replace(/^[.\-]+|[.\-]+$/g, '');
      if (found.indexOf(e) < 0) found.push(e);
    }
  }
  if (!found.length) return '';
  function rank(e) {
    var d = e.split('@')[1];
    if (PERSONAL_DOMAINS.indexOf(d) >= 0) return 0;        // personal inbox first
    if (/iitkgp\.(ac|ernet)\.in$/.test(d)) return 2;       // old institute address last
    return 1;                                              // work address
  }
  found.sort(function (a, b) { return rank(a) - rank(b); });
  return found[0];
}

function cleanName(raw) {
  return String(raw == null ? '' : raw).split(',')[0]
    .replace(/\b(dr|mr|mrs|ms|prof|er|col|capt|lt|maj|gen|brig|adv)\.(?=\S)/gi, '$1. ')
    .replace(/\(.*?\)/g, ' ').replace(/\[.*?\]/g, ' ')
    .replace(/[^A-Za-z.\s'\-]/g, ' ').replace(/\s+/g, ' ').trim();
}
function titleCase(w) { return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); }
function nameParts(raw) { return cleanName(raw).split(' ').filter(function (p) { return p && !TITLES.test(p); }); }
function isInitials_(p) {
  var letters = p.replace(/\./g, '');
  return letters.length <= 2 && SHORT_NAMES.indexOf(letters.toLowerCase()) < 0;
}
function fullName(raw) {
  return nameParts(raw).map(function (p) {
    return isInitials_(p) ? p.replace(/\./g, '').toUpperCase() : p.split('-').map(titleCase).join('-');
  }).join(' ');
}
/** "Atreyi Banerjee" -> "Atreyi";  "DK Mishra" -> "DK Mishra" (initials keep the surname);  "" -> "" (email says "Hi there") */
function firstName(raw) {
  var parts = nameParts(raw);
  if (!parts.length) return '';
  if (!isInitials_(parts[0])) return titleCase(parts[0].replace(/\./g, ''));
  return parts.length > 1 ? fullName(raw) : '';
}

function skipReason(cells, fromCol) {
  for (var i = fromCol; i < cells.length; i++) {
    var t = String(cells[i] == null ? '' : cells[i]);
    if (!t || t.indexOf('@') >= 0) continue;
    for (var k = 0; k < SKIP_RULES.length; k++) if (SKIP_RULES[k].re.test(t)) return SKIP_RULES[k].why;
  }
  return '';
}

function fillTemplate(tpl, person) {
  var first = person.first || 'there';
  return String(tpl).replace(/\{first\}/g, first).replace(/\{name\}/g, person.name || first);
}

function textToHtml(text) {
  var esc = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  esc = esc.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#222">' +
    esc.replace(/\n/g, '<br>') + '</div>';
}

// ---------------------------------------------------------------- menu
function onOpen() {
  SpreadsheetApp.getUi().createMenu('AlmaED Email')
    .addItem('1. Set up / refresh email list', 'setUp')
    .addItem('2. Send a test email to me', 'sendTest')
    .addItem('3. Send next batch now', 'sendNow')
    .addItem('4. Start auto-send (hourly)', 'startAutoSend')
    .addSeparator()
    .addItem('Stop auto-send', 'stopAutoSend')
    .addItem('Show progress', 'showProgress')
    .addToUi();
}

// ---------------------------------------------------------------- template tab
function ensureTemplateTab_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(TEMPLATE_TAB);
  if (sh) return sh;
  sh = ss.insertSheet(TEMPLATE_TAB);
  sh.getRange(1, 1, 9, 2).setValues([
    ['Setting', 'Value'],
    ['Subject', DEFAULT_SUBJECT],
    ['Body', DEFAULT_BODY],
    ['Sender name', 'Kesav Krishna K'],
    ['Daily limit', 100],
    ['Emails per hourly run', 12],
    ['Send from hour (IST, 0-23)', 9],
    ['Send until hour (IST, 0-23)', 19],
    ['How it works', '{first} = first name, {name} = full name. Only rows in "Email list" with an EMPTY Status are emailed; type Skip in Status to leave someone out. Links are made clickable automatically.']
  ]);
  sh.getRange(1, 1, 1, 2).setFontWeight('bold').setBackground('#561132').setFontColor('#ffffff');
  sh.getRange(1, 1, 9, 1).setFontWeight('bold');
  sh.setColumnWidth(1, 210);
  sh.setColumnWidth(2, 720);
  sh.getRange(1, 2, 9, 1).setWrap(true).setVerticalAlignment('top');
  sh.setFrozenRows(1);
  return sh;
}

function readSettings_() {
  var sh = ensureTemplateTab_();
  var vals = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), 2).getValues();
  var map = {};
  vals.forEach(function (r) { map[String(r[0]).trim().toLowerCase()] = r[1]; });
  function num(key, dflt) { var v = Number(map[key]); return isFinite(v) && map[key] !== '' ? v : dflt; }
  return {
    subject: String(map['subject'] || DEFAULT_SUBJECT),
    body: String(map['body'] || DEFAULT_BODY),
    senderName: String(map['sender name'] || 'Kesav Krishna K'),
    dailyLimit: num('daily limit', 100),
    perRun: num('emails per hourly run', 12),
    fromHour: num('send from hour (ist, 0-23)', 9),
    untilHour: num('send until hour (ist, 0-23)', 19)
  };
}

// ---------------------------------------------------------------- email list tab
var LIST_HEADERS = ['Region', 'Name', 'First name', 'Email', 'Status', 'Sent at'];
var C_REGION = 0, C_NAME = 1, C_FIRST = 2, C_EMAIL = 3, C_STATUS = 4, C_SENT = 5;

function ensureListTab_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(LIST_TAB);
  if (sh) return sh;
  sh = ss.insertSheet(LIST_TAB);
  sh.getRange(1, 1, 1, LIST_HEADERS.length).setValues([LIST_HEADERS])
    .setFontWeight('bold').setBackground('#561132').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  sh.setColumnWidth(1, 150); sh.setColumnWidth(2, 220); sh.setColumnWidth(3, 110);
  sh.setColumnWidth(4, 280); sh.setColumnWidth(5, 260); sh.setColumnWidth(6, 150);
  sh.getRange('F:F').setNumberFormat('yyyy-mm-dd hh:mm');
  return sh;
}

function readList_(sh) {
  var n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, LIST_HEADERS.length).getValues();
}

/** Builds or refreshes the Email list. Existing rows (and their statuses) are never changed. */
function buildList_() {
  var ss = SpreadsheetApp.getActive();
  var list = ensureListTab_();
  var existing = readList_(list);
  var known = {};
  existing.forEach(function (r) { if (r[C_EMAIL]) known[String(r[C_EMAIL]).toLowerCase()] = true; });
  var me = (Session.getEffectiveUser().getEmail() || '').toLowerCase();
  if (me) known[me] = true;

  var added = [], skipped = 0, dupes = 0;
  ss.getSheets().forEach(function (sh) {
    var tab = sh.getName();
    if (NOT_REGION_TABS.indexOf(tab) >= 0 || /^email/i.test(tab)) return;
    var values = sh.getDataRange().getValues();
    if (!values.length) return;
    var header = values[0].map(function (h) { return String(h).trim().toLowerCase(); });
    var waStatusCol = header.indexOf('almaed status');
    var notesFrom = waStatusCol >= 0 ? waStatusCol + 1 : 7;
    values.forEach(function (row) {
      var email = pickEmail(row);
      if (!email) return;
      if (known[email]) { dupes++; return; }
      known[email] = true;
      var raw = row[NAME_COL];
      var status = '';
      var why = skipReason(row, notesFrom);
      if (why) status = 'Skip: ' + why;
      else if (waStatusCol >= 0 && String(row[waStatusCol]).trim()) status = 'Skip: already on WhatsApp (' + String(row[waStatusCol]).trim() + ')';
      if (status) skipped++;
      added.push([tab, fullName(raw), firstName(raw), email, status, '']);
    });
  });
  if (added.length) list.getRange(list.getLastRow() + 1, 1, added.length, LIST_HEADERS.length).setValues(added);
  return {added: added.length, skipped: skipped, dupes: dupes, total: existing.length + added.length};
}

function setUp() {
  ensureTemplateTab_();
  var r = buildList_();
  var p = progress_();
  SpreadsheetApp.getUi().alert('AlmaED Email is set up',
    'Added ' + r.added + ' new people to the "' + LIST_TAB + '" tab (' + r.skipped + ' of them marked Skip from the call notes).\n\n' +
    'Ready to send: ' + p.pending + '\nAlready sent: ' + p.sent + '\nSkipped: ' + p.skipped + '\n\n' +
    'Next: check the "' + TEMPLATE_TAB + '" tab, then use "Send a test email to me".',
    SpreadsheetApp.getUi().ButtonSet.OK);
}

// ---------------------------------------------------------------- sending
function istNow_() { return new Date(); }
function istDay_(d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); }
function istHour_(d) { return Number(Utilities.formatDate(d, TZ, 'H')); }

function sentToday_(rows) {
  var today = istDay_(istNow_()), n = 0;
  rows.forEach(function (r) {
    var s = r[C_SENT];
    if (String(r[C_STATUS]) === 'Sent' && s) {
      var d = s instanceof Date ? s : new Date(s);
      if (!isNaN(d) && istDay_(d) === today) n++;
    }
  });
  return n;
}

function sendOne_(settings, person, toOverride, subjectPrefix) {
  var body = fillTemplate(settings.body, person);
  MailApp.sendEmail({
    to: toOverride || person.email,
    subject: (subjectPrefix || '') + fillTemplate(settings.subject, person),
    body: body,
    htmlBody: textToHtml(body),
    name: settings.senderName
  });
}

/** Sends up to `maxThisRun` emails to rows with an empty Status. Returns a summary. */
function sendBatch_(maxThisRun) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return {sent: 0, note: 'Another send is already running.'};
  try {
    var started = Date.now();
    var settings = readSettings_();
    var sh = ensureListTab_();
    var rows = readList_(sh);
    var left = Math.min(maxThisRun, settings.dailyLimit - sentToday_(rows), MailApp.getRemainingDailyQuota());
    if (left <= 0) return {sent: 0, note: 'Daily limit reached for today.'};
    var sent = 0, errors = 0;
    for (var i = 0; i < rows.length && sent < left; i++) {
      var r = rows[i];
      if (String(r[C_STATUS]).trim() !== '' || !r[C_EMAIL]) continue;
      if (Date.now() - started > MAX_RUN_MS) break;
      var person = {email: String(r[C_EMAIL]).trim(), first: String(r[C_FIRST]).trim(), name: String(r[C_NAME]).trim()};
      var cell = sh.getRange(i + 2, C_STATUS + 1, 1, 2);
      try {
        sendOne_(settings, person);
        cell.setValues([['Sent', istNow_()]]);
        sent++;
      } catch (e) {
        var msg = String(e && e.message || e);
        cell.setValues([['Error: ' + msg.slice(0, 120), '']]);
        errors++;
        if (/limit|quota|too many/i.test(msg)) break;   // stop if Google says we've hit a limit
      }
      SpreadsheetApp.flush();
      Utilities.sleep(2000 + Math.floor(Math.random() * 3000));  // 2-5 s gap between emails
    }
    return {sent: sent, errors: errors, note: ''};
  } finally {
    lock.releaseLock();
  }
}

function sendTest() {
  var settings = readSettings_();
  var me = Session.getEffectiveUser().getEmail();
  var rows = readList_(ensureListTab_());
  var sample = {first: 'Kesav', name: 'Kesav Krishna K'};
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][C_STATUS]).trim() === '' && rows[i][C_FIRST]) { sample = {first: rows[i][C_FIRST], name: rows[i][C_NAME]}; break; }
  }
  sendOne_(settings, sample, me, '[TEST] ');
  SpreadsheetApp.getUi().alert('Test sent', 'A test email (filled in for "' + sample.name + '") was sent to ' + me + '.\nCheck your inbox to see how it looks.', SpreadsheetApp.getUi().ButtonSet.OK);
}

function sendNow() {
  var settings = readSettings_();
  var r = sendBatch_(settings.perRun);
  var p = progress_();
  SpreadsheetApp.getUi().alert('Batch done',
    'Sent ' + r.sent + ' email(s)' + (r.errors ? ', ' + r.errors + ' error(s)' : '') + '. ' + (r.note || '') +
    '\n\nSent so far: ' + p.sent + '  |  Still to send: ' + p.pending + '  |  Sent today: ' + p.today + ' of ' + settings.dailyLimit,
    SpreadsheetApp.getUi().ButtonSet.OK);
}

/** Runs every hour from the trigger. Sends only within the sending hours (IST). */
function autoSend() {
  var settings = readSettings_();
  var h = istHour_(istNow_());
  if (h < settings.fromHour || h >= settings.untilHour) return;
  var r = sendBatch_(settings.perRun);
  if (progress_().pending === 0) stopAutoSend_();
  return r;
}

function startAutoSend() {
  stopAutoSend_();
  ScriptApp.newTrigger('autoSend').timeBased().everyHours(1).create();
  var s = readSettings_();
  var p = progress_();
  SpreadsheetApp.getUi().alert('Auto-send is on',
    'Every hour between ' + s.fromHour + ':00 and ' + s.untilHour + ':00 IST, up to ' + s.perRun + ' emails go out, with at most ' + s.dailyLimit + ' a day.\n\n' +
    p.pending + ' people are left to email, so this will take about ' + Math.ceil(p.pending / Math.max(1, s.dailyLimit)) + ' day(s).\n' +
    'It stops by itself when everyone has been emailed. Use "Stop auto-send" to pause any time.',
    SpreadsheetApp.getUi().ButtonSet.OK);
}

function stopAutoSend_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'autoSend') ScriptApp.deleteTrigger(t);
  });
}
function stopAutoSend() {
  stopAutoSend_();
  SpreadsheetApp.getUi().alert('Auto-send stopped. Nothing more will be sent until you start it again.');
}

function progress_() {
  var rows = readList_(ensureListTab_());
  var p = {sent: 0, pending: 0, skipped: 0, errors: 0, today: sentToday_(rows)};
  rows.forEach(function (r) {
    var s = String(r[C_STATUS]).trim();
    if (!r[C_EMAIL]) return;
    if (s === '') p.pending++;
    else if (s === 'Sent') p.sent++;
    else if (/^error/i.test(s)) p.errors++;
    else p.skipped++;
  });
  return p;
}
function showProgress() {
  var p = progress_();
  var on = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'autoSend'; });
  SpreadsheetApp.getUi().alert('AlmaED Email progress',
    'Sent: ' + p.sent + ' (today: ' + p.today + ')\nStill to send: ' + p.pending + '\nSkipped: ' + p.skipped + '\nErrors: ' + p.errors +
    '\n\nAuto-send is ' + (on ? 'ON' : 'OFF') + '.', SpreadsheetApp.getUi().ButtonSet.OK);
}
