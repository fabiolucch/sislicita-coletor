// Aba Serviços: execuções do GitHub Actions, disparo manual, teste do Gemini e conferência de cobertura no PNCP.
// Exige login (JWT do Supabase). Segredos no Cloudflare Pages:
//   GH_DISPARO  = token do GitHub (fine-grained, só neste repositório, permissão "Actions: Read and write") - necessário só para os botões de disparo
//   GEMINI_API_KEY = já existente (usada no teste do Gemini)
const SB = "https://tkbkkqebsxvmxnqiwjfl.supabase.co";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRrYmtrcWVic3h2bXhucWl3amZsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM5MDk1MjIsImV4cCI6MjEwOTQ4NTUyMn0.v--eJcYHEanBh9WG1xgOP-jPGwbR_fikk65AkvMPEaI";
const REPO = "fabiolucch/sislicita-coletor", WORKFLOW = "coleta.yml", REF = "main";
const ETAPAS = ["editais", "pca", "radar", "catalogo", "ia", "radar_ia", "itens", "vigia", "docs", "radar_pca_ia", "interesse", "briefing", "aprender", "alertas", "contratos", "resultados", "fornecedores", "historico", "tudo"];
const MODALIDADES = { 4: "Concorrência Eletrônica", 5: "Concorrência Presencial", 6: "Pregão Eletrônico", 7: "Pregão Presencial", 8: "Dispensa", 12: "Credenciamento" };
const MODELOS = ["gemini-3.1-flash-lite", "gemini-2.5-flash-lite", "gemini-2.5-flash"];
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

async function autenticar(request) {
  const auth = request.headers.get("authorization") || "";
  const u = await fetch(`${SB}/auth/v1/user`, { headers: { authorization: auth, apikey: ANON } });
  return u.ok;
}

const gh = (env, path, init = {}) => fetch(`https://api.github.com/repos/${REPO}/${path}`, {
  ...init,
  headers: { accept: "application/vnd.github+json", "user-agent": "sislicita-painel", "x-github-api-version": "2022-11-28", ...(env.GH_DISPARO ? { authorization: "Bearer " + env.GH_DISPARO } : {}), ...(init.headers || {}) },
});

async function execucoes(env) {
  const r = await gh(env, "actions/runs?per_page=15");
  if (!r.ok) return { erro: `GitHub ${r.status}` };
  const j = await r.json();
  return {
    token: !!env.GH_DISPARO,
    runs: (j.workflow_runs || []).map(x => ({
      id: x.id, status: x.status, conclusao: x.conclusion, evento: x.event, inicio: x.run_started_at, fim: x.updated_at,
      url: x.html_url, titulo: x.display_title,
    })),
  };
}

async function disparar(env, b) {
  if (!env.GH_DISPARO) return J({ erro: "GH_DISPARO não configurado no Cloudflare (veja as instruções na aba Serviços)" }, 400);
  const modo = String(b.modo || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!modo.length || modo.some(m => !ETAPAS.includes(m))) return J({ erro: "modo inválido" }, 400);
  const inputs = { modo: modo.join(",") };
  if (b.max_ia) inputs.max_ia = String(Math.min(2000, Math.max(1, parseInt(b.max_ia, 10) || 300)));
  const r = await gh(env, `actions/workflows/${WORKFLOW}/dispatches`, { method: "POST", body: JSON.stringify({ ref: REF, inputs }) });
  if (r.status !== 204) return J({ erro: `GitHub ${r.status}: ${(await r.text()).slice(0, 200)}` }, 502);
  return J({ ok: true, modo: inputs.modo });
}

async function testarGemini(env) {
  if (!env.GEMINI_API_KEY) return { erro: "GEMINI_API_KEY não configurada no Cloudflare" };
  const out = [];
  for (const m of MODELOS) {
    const t0 = Date.now();
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: "POST", headers: { "x-goog-api-key": env.GEMINI_API_KEY, "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: "Responda apenas: ok" }] }], generationConfig: { temperature: 0, maxOutputTokens: 8 } }),
      });
      out.push({ modelo: m, http: r.status, ms: Date.now() - t0, ok: r.ok });
    } catch (e) { out.push({ modelo: m, http: 0, ms: Date.now() - t0, ok: false, erro: String(e.message || e).slice(0, 80) }); }
  }
  return { modelos: out };
}

// Total de editais que o PNCP tem publicados no dia, por modalidade (para comparar com o que está no banco).
async function cobertura(dia) {
  if (!/^\d{8}$/.test(dia)) return { erro: "dia inválido" };
  const por = {};
  for (const [cod, nome] of Object.entries(MODALIDADES)) {
    let n = null, http = 0;
    for (const espera of [0, 1500, 4000]) {
      if (espera) await new Promise(r => setTimeout(r, espera));
      try {
        const r = await fetch(`https://pncp.gov.br/api/consulta/v1/contratacoes/publicacao?dataInicial=${dia}&dataFinal=${dia}&codigoModalidadeContratacao=${cod}&pagina=1&tamanhoPagina=10`, { headers: { accept: "application/json", "user-agent": "sislicita-painel" } });
        http = r.status;
        if (r.status === 204) { n = 0; break; }
        if (r.ok) { n = (await r.json()).totalRegistros ?? 0; break; }
        if (r.status !== 429 && r.status < 500) break;
      } catch { http = 0; }
    }
    por[nome] = { n, http };
  }
  const falhou = Object.values(por).some(v => v.n == null);
  return { dia, por, total: falhou ? null : Object.values(por).reduce((a, v) => a + v.n, 0), pncp_ok: !falhou };
}

export async function onRequest({ request, env }) {
  if (!(await autenticar(request))) return J({ erro: "não autenticado" }, 401);
  const url = new URL(request.url);
  try {
    if (request.method === "GET") {
      const a = url.searchParams.get("acao");
      if (a === "execucoes") return J(await execucoes(env));
      if (a === "cobertura") return J(await cobertura(url.searchParams.get("dia") || ""));
      return J({ erro: "ação inválida" }, 400);
    }
    const b = await request.json().catch(() => ({}));
    if (b.acao === "disparar") return await disparar(env, b);
    if (b.acao === "testar_gemini") return J(await testarGemini(env));
    return J({ erro: "ação inválida" }, 400);
  } catch (e) { return J({ erro: String(e.message || e).slice(0, 200) }, 500); }
}
