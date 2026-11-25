// Serverless (Vercel) — verifica la contraseña de admin y guarda las metas del Bono Ops Managers (ops-config.json) en el repo.
// Reutiliza las variables de entorno que ya usa /api/update-admin:
//   ADMIN_SECRET  -> contraseña de administración (la misma de /admin)
//   GITHUB_TOKEN  -> token con permiso de escritura (Contents: read/write) sobre el repo
//   GITHUB_REPO / GITHUB_BRANCH -> opcionales
// POST { secret }            -> solo verifica la contraseña
// POST { secret, config }    -> verifica y guarda las metas
// El token y la contraseña nunca viajan en el HTML: se validan aquí, del lado del servidor.

const num = (v, lo, hi) => typeof v === 'number' && isFinite(v) && v >= lo && v <= hi;

function validate(c) {
  try {
    if (!c || typeof c !== 'object') return 'config_invalida';
    if (!num(c['if'].t100, 0, 100) || !num(c['if'].t80, 0, 100) || c['if'].t80 > c['if'].t100) return 'if_invalido';
    if (!num(c.tb.t100, 0, 60) || !num(c.tb.t80, 0, 60) || c.tb.t80 < c.tb.t100) return 'turbo_invalido';
    if (!num(c.gap.min, 0, 20) || !num(c.gap.minPF, -20, 20)) return 'gap_piso_invalido';
    for (const t of ['AA', 'A', 'B', 'C', 'PF']) if (!num(c.gap.mod[t], 0, 30)) return 'gap_moderado_invalido';
    if (!num(c.acc, 0, 100)) return 'acc_invalido';
    for (const k of ['110', '153', '206']) if (!num(c.rot[k], 0, 1000)) return 'rot_invalido';
    const sum = (o) => Object.values(o).reduce((s, v) => s + v, 0);
    for (const k of ['if', 'gap', 'tb', 'rot']) if (!num(c.w.si[k], 0, 100)) return 'pesos_invalidos';
    for (const k of ['if', 'gap', 'rot']) if (!num(c.w.no[k], 0, 100)) return 'pesos_invalidos';
    if (Math.round(sum(c.w.si)) !== 100 || Math.round(sum(c.w.no)) !== 100) return 'pesos_no_suman_100';
    return null;
  } catch (e) { return 'config_invalida'; }
}

// Solo guardamos los campos conocidos (nada extra viaja al repo)
function clean(c) {
  return {
    'if': { t100: c['if'].t100, t80: c['if'].t80 },
    tb: { t100: c.tb.t100, t80: c.tb.t80 },
    gap: { min: c.gap.min, minPF: c.gap.minPF, mod: { AA: c.gap.mod.AA, A: c.gap.mod.A, B: c.gap.mod.B, C: c.gap.mod.C, PF: c.gap.mod.PF } },
    acc: c.acc,
    rot: { '110': c.rot['110'], '153': c.rot['153'], '206': c.rot['206'] },
    w: {
      si: { 'if': c.w.si['if'], gap: c.w.si.gap, tb: c.w.si.tb, rot: c.w.si.rot },
      no: { 'if': c.w.no['if'], gap: c.w.no.gap, rot: c.w.no.rot },
    },
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const { secret, config } = body || {};

  const ADMIN_SECRET = process.env.ADMIN_SECRET;
  if (!ADMIN_SECRET) return res.status(500).json({ ok: false, error: 'server_missing_ADMIN_SECRET' });
  if (!secret || secret !== ADMIN_SECRET) return res.status(401).json({ ok: false, error: 'unauthorized' });

  if (config === undefined) return res.status(200).json({ ok: true, verified: true });

  const bad = validate(config);
  if (bad) return res.status(400).json({ ok: false, error: bad });

  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ ok: false, error: 'server_missing_GITHUB_TOKEN' });
  const repo = process.env.GITHUB_REPO || 'melaniebeezzy-fdgy/onepager';
  const branch = process.env.GITHUB_BRANCH || 'main';
  const path = 'ops-config.json';
  const url = `https://api.github.com/repos/${repo}/contents/${path}`;
  const gh = (u, opts = {}) => fetch(u, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'onepager-ops-config',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {}),
    },
  });

  try {
    let sha;
    const cur = await gh(`${url}?ref=${branch}`);
    if (cur.ok) sha = (await cur.json()).sha;
    else if (cur.status !== 404) return res.status(502).json({ ok: false, error: 'github_fetch_failed' });

    const content = Buffer.from(JSON.stringify(clean(config), null, 1) + '\n', 'utf-8').toString('base64');
    const put = await gh(url, {
      method: 'PUT',
      body: JSON.stringify({ message: 'Bono Ops Managers: actualizar metas', content, branch, ...(sha ? { sha } : {}) }),
    });
    if (!put.ok) return res.status(502).json({ ok: false, error: 'github_commit_failed' });
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'exception' });
  }
}
