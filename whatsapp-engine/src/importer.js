// Reads the alumni Sheet (downloaded as .xlsx) into contact records.
'use strict';
const ExcelJS = require('exceljs');
const R = require('./rules');

const NOT_REGION_TABS = ['distribution', 'whatsapp message', 'email list', 'email template'];

function cellText(cell) {
  const v = cell && cell.value;
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v.text != null) return String(v.text);                // hyperlink
    if (v.result != null) return String(v.result);            // formula
    if (v instanceof Date) return v.toISOString();
    if (v.formula != null) return '';
  }
  return String(v);
}

function sheetRows(ws) {
  const rows = [];
  const width = ws.columnCount || 0;
  ws.eachRow({ includeEmpty: true }, (row, n) => {
    const out = [];
    for (let c = 1; c <= Math.max(width, row.cellCount); c++) out.push(cellText(row.getCell(c)).trim());
    rows[n - 1] = out;
  });
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return rows;
}

/**
 * Returns { contacts, stats } where contacts are unique by phone.
 * Options: skipIfAlreadyEmailed - skip people whose email shows "Sent" in the Email list tab.
 */
async function importWorkbook(file, opts = {}) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);

  // Emails already sent by the email campaign (if the Email list tab exists)
  const emailed = new Set();
  const emailTab = wb.worksheets.find((w) => w.name.trim().toLowerCase() === 'email list');
  if (emailTab) {
    const rows = sheetRows(emailTab);
    const h = (rows[0] || []).map((x) => x.toLowerCase());
    const ce = h.indexOf('email'), cs = h.indexOf('status');
    if (ce >= 0 && cs >= 0) rows.slice(1).forEach((r) => { if ((r[cs] || '') === 'Sent' && r[ce]) emailed.add(r[ce].toLowerCase()); });
  }

  const seen = new Set();
  const contacts = [];
  const stats = { tabs: 0, rows: 0, withPhone: 0, duplicates: 0, skipped: {} };

  for (const ws of wb.worksheets) {
    const tab = ws.name.trim();
    if (NOT_REGION_TABS.includes(tab.toLowerCase()) || /^email/i.test(tab)) continue;
    stats.tabs++;
    const rows = sheetRows(ws);
    if (!rows.length) continue;
    const header = rows[0].map((x) => x.toLowerCase());
    const waCol = header.indexOf('wa number') >= 0 ? header.indexOf('wa number') : 1;
    const statusCol = header.indexOf('almaed status');
    const notesFrom = statusCol >= 0 ? statusCol + 1 : 7;

    rows.forEach((row, i) => {
      if (String(row[waCol] || '').toLowerCase() === 'wa number') return;   // header row
      if (!row.some((x) => x)) return;
      stats.rows++;
      // Only the "WA number" column: other cells often hold landlines written without the 0 (e.g. 80-2552-9608)
      const phone = R.normalisePhone(row[waCol]);
      if (!phone) return;
      stats.withPhone++;
      if (seen.has(phone)) { stats.duplicates++; return; }
      seen.add(phone);

      const raw = row[0];
      const email = R.pickEmail(row);
      let skip = R.skipReason(row, notesFrom);
      if (!skip && statusCol >= 0 && row[statusCol]) skip = 'already contacted on WhatsApp (' + row[statusCol] + ')';
      if (!skip && opts.skipIfAlreadyEmailed && email && emailed.has(email)) skip = 'already emailed';
      if (skip) stats.skipped[skip.replace(/ \(.*/, '')] = (stats.skipped[skip.replace(/ \(.*/, '')] || 0) + 1;

      contacts.push({
        phone, region: tab, name: R.fullName(raw), first: R.firstName(raw), email,
        status: skip ? 'skipped' : 'pending', skipReason: skip,
        sentAt: null, messageId: null, replies: [], detailsAt: null, needsYou: false,
      });
    });
  }
  return { contacts, stats };
}

module.exports = { importWorkbook };
