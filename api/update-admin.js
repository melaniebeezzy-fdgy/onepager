// Serverless (Vercel) — recibe el bloque de overrides del /admin y lo commitea al repo.
// Variables de entorno requeridas en Vercel:
//   GITHUB_TOKEN  -> token con permiso de escritura (Contents: read/write) sobre el repo
//   ADMIN_SECRET  -> passphrase que debe coincidir con la que se ingresa en /admin
//   GITHUB_REPO   -> opcional, por defecto "melaniebeezzy-fdgy/onepager"
//   GITHUB_BRANCH -> opcional, por defecto "main"
//
// El token NUNCA se expone al navegador: solo vive aquí, del lado del servidor.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const { secret, block } = body || {};

  const ADMIN_SECRET = process.env.ADMIN_SECRET;
  if (!ADMIN_SECRET) return res.status(500).json({ ok: false, error: 'server_missing_ADMIN_SECRET' });
  if (!secret || secret !== ADMIN_SECRET) return res.status(401).json({ ok: false, error: 'unauthorized' });

  if (!block || typeof block !== 'string' || block.length > 200000) {
    return res.status(400).json({ ok: false, error: 'bad_block' });
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ ok: false, error: 'server_missing_GITHUB_TOKEN' });
  const repo = process.env.GITHUB_REPO || 'melaniebeezzy-fdgy/onepager';
  const branch = process.env.GITHUB_BRANCH || 'main';
  const path = 'index.html';
  const api = `https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`;

  const gh = (url, opts = {}) => fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'onepager-admin',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {}),
    },
  });

  try {
    const cur = await gh(api);
    if (!cur.ok) return res.status(502).json({ ok: false, error: 'github_fetch_failed', detail: (await cur.text()).slice(0, 300) });
    const j = await cur.json();
    const content = Buffer.from(j.content, 'base64').toString('utf-8');

    const re = /(\/\*\s*===\s*ADMIN-REFRESH START[\s\S]*?\*\/)\n[\s\S]*?\n(\/\*\s*===\s*ADMIN-REFRESH END\s*===\s*\*\/)/;
    if (!re.test(content)) return res.status(500).json({ ok: false, error: 'markers_not_found' });

    const updated = content.replace(re, (m, a, b) => `${a}\n${block}\n${b}`);
    if (updated === content) return res.status(200).json({ ok: true, changed: false });

    const putUrl = `https://api.github.com/repos/${repo}/contents/${path}`;
    const put = await gh(putUrl, {
      method: 'PUT',
      body: JSON.stringify({
        message: 'admin: actualizar KPIs (Accuracy / GAP Weekly / GAP MTD)',
        content: Buffer.from(updated, 'utf-8').toString('base64'),
        sha: j.sha,
        branch,
      }),
    });
    if (!put.ok) return res.status(502).json({ ok: false, error: 'github_commit_failed', detail: (await put.text()).slice(0, 300) });
    const pj = await put.json();
    return res.status(200).json({ ok: true, changed: true, commit: pj.commit && pj.commit.sha });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'exception', detail: String(e).slice(0, 300) });
  }
}
