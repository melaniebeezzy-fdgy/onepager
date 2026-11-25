// Serverless (Vercel) — "Refrescar métrica" del Bono Trimestral Ops Managers.
// POST { secret, metric, month }   metric: if | tb | gap | acc | rot   month: 10 | 11 | 12
//
//  if   -> warehouse (ontime_infull_order): 1 - quejas/ordenes por cocina
//  tb   -> warehouse (RTWT Turbo, solo COL): handed_to_delivery - max(en tienda, recibida+5), piso 0, null=0
//  acc  -> warehouse (counting_details): promedio de los conteos weekly+monthly del mes. Compara contra la pestaña ACC del sheet y TOMA el warehouse.
//  gap  -> Sheet del bono, pestaña GAP+ACC (la que se actualiza manualmente)
//  rot  -> Sheet del bono, pestaña Rotacion (alimentada con la info de People)
//
// Variables de entorno en Vercel (nunca llegan al navegador):
//   ADMIN_SECRET, GITHUB_TOKEN                      (ya existen, las usa /api/update-admin y /api/ops-config)
//   REDSHIFT_HOST, REDSHIFT_PORT(5439), REDSHIFT_DB, REDSHIFT_USER, REDSHIFT_PASSWORD   (usuario de SOLO LECTURA)
//   GOOGLE_SA_EMAIL, GOOGLE_SA_PRIVATE_KEY          (cuenta de servicio; compartirle el sheet como lector)
//   opcionales: OPS_SHEET_ID, OPS_YEAR (2026), REDSHIFT_COMPANY_ID (fdgy), GITHUB_REPO, GITHUB_BRANCH
// Los resultados se guardan en ops-data.json (repo) y la vista los superpone sobre la foto base.

import crypto from 'crypto';

export const config = { maxDuration: 60 };

const YEAR = parseInt(process.env.OPS_YEAR || '2026', 10);
const MONTHS = [10, 11, 12];
const METRICS = ['if', 'tb', 'gap', 'acc', 'rot'];
const OPS_SHEET = process.env.OPS_SHEET_ID || '1p2v8rTu8ZJeDxsKiqgsmN3NJ3dLdQTpwxmHaQ8HKtro';
const CID = /^[A-Za-z0-9_-]+$/.test(process.env.REDSHIFT_COMPANY_ID || 'fdgy') ? (process.env.REDSHIFT_COMPANY_ID || 'fdgy') : 'fdgy';
const MOD_BASE = { AA: 1.8, A: 2.2, B: 2.55, C: 3.0, PF: 0.7 };

/* ---------- helpers puros (exportados para pruebas) ---------- */
const pad = (n) => String(n).padStart(2, '0');
export function monthRange(m) {
  const ny = m === 12 ? YEAR + 1 : YEAR, nm = m === 12 ? 1 : m + 1;
  return [`${YEAR}-${pad(m)}-01`, `${ny}-${pad(nm)}-01`];
}
export function num(s) {
  if (s === null || s === undefined) return null;
  if (typeof s === 'number') return isFinite(s) ? s : null;
  const t = String(s).trim().replace('%', '').replace(/,/g, '');
  if (t === '' || t[0] === '#') return null;
  const v = parseFloat(t);
  return isFinite(v) ? v : null;
}
const r2 = (v) => Math.round(v * 100) / 100;
const sameMonth = (cell, m) => String(cell).trim() === String(m);

export function parseGap(rows, m) {            // GAP+ACC: Mes|Cumple|Tipo|OPS|MIN|Moderado|Locacion|Fecha|%Gap|ACC
  const out = {};
  (rows || []).slice(1).forEach((r) => {
    if (!sameMonth(r[0], m) || !r[6]) return;
    const gap = num(r[8]);
    if (gap === null) return;
    const tipo = String(r[2] || '').trim();
    const e = { gap, tipo };
    const mod = num(r[5]);
    if (mod !== null && MOD_BASE[tipo] !== undefined && Math.abs(mod - MOD_BASE[tipo]) > 1e-9) e.mod = mod; // excepciones (p.ej. Mérida)
    out[String(r[6]).trim()] = e;
  });
  return out;
}
export function parseRot(rows, m) {            // Rotacion: Mes|Cumple|OPS|Moderada|Cocina|Fecha|Ciudad|CC|Planta|Retiros|Rotación
  const out = {};
  (rows || []).slice(1).forEach((r) => {
    if (!sameMonth(r[0], m) || !r[4]) return;
    const rot = num(r[10]), meta = num(r[3]);
    if (rot === null) return;
    out[String(r[4]).trim()] = meta === null ? { rot } : { rot, meta };
  });
  return out;
}
export function parseAccFile(rows, m) {        // ACC: Mes|Cumple|Tipo|OPS|Meta|Fecha|kitchen_id|Accuracy
  const out = {};
  (rows || []).slice(1).forEach((r) => {
    if (!sameMonth(r[0], m) || !r[6]) return;
    const a = num(r[7]);
    if (a !== null) out[String(r[6]).trim()] = a;
  });
  return out;
}

/* ---------- warehouse ---------- */
async function withDb(fn) {
  const miss = ['REDSHIFT_HOST', 'REDSHIFT_DB', 'REDSHIFT_USER', 'REDSHIFT_PASSWORD'].filter((k) => !process.env[k]);
  if (miss.length) { const e = new Error('missing_env:' + miss.join(',')); e.code = 'cfg'; throw e; }
  const pgm = await import('pg');
  const Client = (pgm.default || pgm).Client;
  const c = new Client({
    host: process.env.REDSHIFT_HOST, port: parseInt(process.env.REDSHIFT_PORT || '5439', 10),
    database: process.env.REDSHIFT_DB, user: process.env.REDSHIFT_USER, password: process.env.REDSHIFT_PASSWORD,
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 12000, statement_timeout: 50000,
  });
  await c.connect();
  try { return await fn(c); } finally { try { await c.end(); } catch (e) { /* ignore */ } }
}
async function mIF(m) {
  const [a, b] = monthRange(m);
  const rows = (await withDb((c) => c.query(
    `SELECT kitchen_id, COUNT(order_id) AS total, SUM(is_infull) AS quejas
       FROM fdgy_views.ontime_infull_order
      WHERE company_id = '${CID}' AND order_date >= '${a}' AND order_date < '${b}' AND country IN ('COL','MEX')
      GROUP BY 1`))).rows;
  const out = {};
  rows.forEach((r) => { const t = Number(r.total); if (t > 0) out[r.kitchen_id] = { if: r2((1 - Number(r.quejas) / t) * 100) }; });
  return out;
}
async function mTB(m) {
  const [a, b] = monthRange(m);
  const rows = (await withDb((c) => c.query(
    `SELECT oi.kitchen_id,
            AVG(COALESCE(GREATEST(DATEDIFF(second, GREATEST(oi.provider_domiciliary_in_store, DATEADD(minute,5,oi.order_received_at_local)), oc.order_state_handed_to_delivery)/60.0, 0), 0)) AS rtwt
       FROM (SELECT * FROM fdgy_views.ontime_infull_order WHERE company_id = '${CID}') oi
       JOIN (SELECT * FROM fdgy_views.orders_consolidado WHERE company_id = '${CID}') oc ON oc.provider_order_id = oi.provider_order_id
      WHERE oi.order_date >= '${a}' AND oi.order_date < '${b}' AND oi.country = 'COL' AND oi.brand ILIKE '%turbo%'
      GROUP BY 1`))).rows;
  const out = {};
  rows.forEach((r) => { out[r.kitchen_id] = { tb: r2(Number(r.rtwt)) }; });
  return out;
}
async function mACC(m) {
  const [a, b] = monthRange(m);
  const rows = (await withDb((c) => c.query(
    `SELECT k, AVG(acc) * 100 AS acc FROM (
        SELECT kitchen_id AS k, counting_id, MAX(accuracy) AS acc
          FROM fdgy_views.counting_details
         WHERE company_id = '${CID}' AND deleted_at IS NULL AND status IN ('FINISHED','VALIDATED')
           AND counting_type_code IN ('weekly','monthly') AND accuracy IS NOT NULL
           AND scheduled_date >= '${a}' AND scheduled_date < '${b}'
         GROUP BY 1, 2) GROUP BY 1`))).rows;
  const out = {};
  rows.forEach((r) => { out[r.k] = { acc: r2(Number(r.acc)) }; });
  return out;
}

/* ---------- Google Sheets (cuenta de servicio) ---------- */
let _tok = null;
async function googleToken() {
  if (_tok && _tok.exp > Date.now() + 60000) return _tok.v;
  const email = process.env.GOOGLE_SA_EMAIL, rawKey = process.env.GOOGLE_SA_PRIVATE_KEY;
  if (!email || !rawKey) { const e = new Error('missing_env:GOOGLE_SA_EMAIL,GOOGLE_SA_PRIVATE_KEY'); e.code = 'cfg'; throw e; }
  const key = rawKey.replace(/\\n/g, '\n');
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', typ: 'JWT' });
  const claim = b64({ iss: email, scope: 'https://www.googleapis.com/auth/spreadsheets.readonly', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + claim).sign(key).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + head + '.' + claim + '.' + sig,
  });
  if (!r.ok) { const e = new Error('google_auth_failed'); e.code = 'upstream'; throw e; }
  const j = await r.json();
  _tok = { v: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return _tok.v;
}
async function sheetRows(id, title) {
  const t = await googleToken();
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent("'" + title + "'")}?valueRenderOption=FORMATTED_VALUE`, { headers: { Authorization: 'Bearer ' + t } });
  if (!r.ok) { const e = new Error('sheet_read_failed:' + title + ':' + r.status); e.code = 'upstream'; throw e; }
  return (await r.json()).values || [];
}

/* ---------- persistencia en el repo (ops-data.json) ---------- */
const REPO = () => process.env.GITHUB_REPO || 'melaniebeezzy-fdgy/onepager';
const BRANCH = () => process.env.GITHUB_BRANCH || 'main';
function gh(url, opts = {}) {
  return fetch(url, { ...opts, headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'onepager-ops-refresh', 'X-GitHub-Api-Version': '2022-11-28', ...(opts.headers || {}) } });
}
async function saveData(metric, month, values, ts) {
  const url = `https://api.github.com/repos/${REPO()}/contents/ops-data.json`;
  for (let attempt = 0; attempt < 2; attempt++) {
    let sha, cur = { m: {}, upd: {} };
    const g = await gh(`${url}?ref=${BRANCH()}`);
    if (g.ok) { const j = await g.json(); sha = j.sha; try { cur = JSON.parse(Buffer.from(j.content, 'base64').toString('utf-8')); } catch (e) { /* vacío */ } }
    else if (g.status !== 404) { const e = new Error('github_fetch_failed'); e.code = 'upstream'; throw e; }
    cur.m = cur.m || {}; cur.upd = cur.upd || {};
    const mm = (cur.m[month] = cur.m[month] || {});
    Object.keys(values).forEach((k) => { mm[k] = { ...(mm[k] || {}), ...values[k] }; });
    (cur.upd[metric] = cur.upd[metric] || {})[month] = ts;
    const put = await gh(url, { method: 'PUT', body: JSON.stringify({ message: `Bono Ops: refrescar ${metric} mes ${month}`, content: Buffer.from(JSON.stringify(cur) + '\n').toString('base64'), branch: BRANCH(), ...(sha ? { sha } : {}) }) });
    if (put.ok) return;
    if (put.status !== 409 && put.status !== 422) break;
  }
  const e = new Error('github_commit_failed'); e.code = 'upstream'; throw e;
}

/* ---------- handler ---------- */
function okSecret(s) {
  const a = Buffer.from(String(s || '')), b = Buffer.from(String(process.env.ADMIN_SECRET || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const { secret, metric } = body || {};
  const month = parseInt((body || {}).month, 10);
  if (!process.env.ADMIN_SECRET) return res.status(500).json({ ok: false, error: 'server_missing_ADMIN_SECRET' });
  if (!okSecret(secret)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!METRICS.includes(metric) || !MONTHS.includes(month)) return res.status(400).json({ ok: false, error: 'bad_request' });
  if (!process.env.GITHUB_TOKEN) return res.status(500).json({ ok: false, error: 'server_missing_GITHUB_TOKEN' });

  try {
    const extra = {};
    let values;
    if (metric === 'if') values = await mIF(month);
    else if (metric === 'tb') values = await mTB(month);
    else if (metric === 'gap') values = parseGap(await sheetRows(OPS_SHEET, 'GAP+ACC'), month);
    else if (metric === 'rot') values = parseRot(await sheetRows(OPS_SHEET, 'Rotacion'), month);
    else {                                           // acc: warehouse manda; se compara con el file
      values = await mACC(month);
      let file = null;
      try { file = parseAccFile(await sheetRows(OPS_SHEET, 'ACC'), month); } catch (e) { extra.fileError = String(e.message || e); }
      if (file) {
        extra.compare = Object.keys({ ...Object.fromEntries(Object.keys(values).map((k) => [k, 1])), ...Object.fromEntries(Object.keys(file).map((k) => [k, 1])) })
          .map((k) => ({ k, mcp: values[k] ? values[k].acc : null, file: file[k] === undefined ? null : file[k] }));
      }
    }
    const n = Object.keys(values).length;
    if (!n) return res.status(200).json({ ok: false, error: 'sin_datos_para_el_mes', metric, month });
    const ts = new Date().toISOString();
    await saveData(metric, month, values, ts);
    return res.status(200).json({ ok: true, metric, month, ts, n, data: values, ...extra });
  } catch (e) {
    const code = e && e.code === 'cfg' ? 400 : 502;
    return res.status(code).json({ ok: false, error: String((e && e.message) || 'exception').slice(0, 200) });
  }
}
