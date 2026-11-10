// Filtro v2: vetoriza a descrição do perfil e os editais marcados como exemplo, recompõe e refaz a triagem na hora.
// Exige login; todas as gravações usam o token do próprio usuário (RLS). Segredo: GEMINI_API_KEY.
const SB = "https://tkbkkqebsxvmxnqiwjfl.supabase.co";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRrYmtrcWVic3h2bXhucWl3amZsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM5MDk1MjIsImV4cCI6MjEwOTQ4NTUyMn0.v--eJcYHEanBh9WG1xgOP-jPGwbR_fikk65AkvMPEaI";
const GEM = "https://generativelanguage.googleapis.com/v1beta";
const EMB = "gemini-embedding-001", DIM = 768;
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

const sb = (auth, path, init = {}) => fetch(`${SB}/rest/v1/${path}`, {
  ...init, headers: { apikey: ANON, authorization: auth, "content-type": "application/json", ...(init.headers || {}) },
});
async function rpc(auth, fn, args) {
  const r = await sb(auth, `rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${fn}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

async function vetor(env, texto, tarefa) {
  for (const espera of [0, 3000, 8000]) {
    if (espera) await new Promise(r => setTimeout(r, espera));
    const r = await fetch(`${GEM}/models/${EMB}:embedContent`, {
      method: "POST", headers: { "x-goog-api-key": env.GEMINI_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ model: `models/${EMB}`, content: { parts: [{ text: texto.slice(0, 6000) }] }, taskType: tarefa, outputDimensionality: DIM }),
    });
    if (r.status === 429 || r.status >= 500) continue;
    if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const v = (await r.json()).embedding.values;
    const m = Math.hypot(...v) || 1;
    return "[" + v.map(x => (x / m).toFixed(5)).join(",") + "]";
  }
  throw new Error("Gemini está no limite de uso agora (429); tente em 1 minuto");
}

function textoPerfil(p) {
  const partes = [p.prompt || ""];
  if ((p.palavras_incluir || []).length) partes.push("Termos importantes: " + p.palavras_incluir.join(", ") + ".");
  if ((p.categorias || []).length && !(p.categorias.length === 2 && p.categorias.includes("bens") && p.categorias.includes("servicos")))
    partes.push("Categorias: " + p.categorias.join(", ") + ".");
  return partes.join("\n").trim();
}

async function garantirVetorEdital(env, auth, id) {
  const ja = await (await sb(auth, `edital_emb?oportunidade_id=eq.${id}&select=oportunidade_id`)).json();
  if (ja.length) return;
  const o = (await (await sb(auth, `oportunidades?id=eq.${id}&select=objeto`)).json())[0];
  if (!o || !o.objeto) throw new Error("edital sem objeto");
  const emb = await vetor(env, o.objeto, "RETRIEVAL_DOCUMENT");
  const r = await sb(auth, "rpc/salvar_vetor_edital", { method: "POST", body: JSON.stringify({ p_op: id, p_emb: JSON.stringify(emb) }) });
  if (!r.ok) throw new Error("gravar vetor: " + (await r.text()).slice(0, 160));
}

async function sugerir(env, texto) {
  const prompt = `Você ajuda um consultor de licitações públicas a descrever um perfil de busca de editais no PNCP.
Reescreva a descrição abaixo em 4 a 8 linhas, em português, deixando claro: o que a empresa vende ou presta; variações e sinônimos que aparecem em editais (inclua termos técnicos e populares); o que NÃO interessa (coisas parecidas que devem ficar de fora). Não invente limites de valor, UF ou prazo. Responda só com o texto.

Descrição: ${texto}`;
  let r, ultimo = 0;
  for (const m of ["gemini-3.1-flash-lite", "gemini-2.5-flash-lite", "gemini-2.5-flash"]) {  // mesma lista do ia.js: segue se um modelo nao existir (404)
    r = await fetch(`${GEM}/models/${m}:generateContent`, {
      method: "POST", headers: { "x-goog-api-key": env.GEMINI_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3 } }),
    });
    if (r.ok) break;
    ultimo = r.status;
  }
  if (!r.ok) throw new Error(`Gemini ${ultimo}`);
  return ((await r.json()).candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
}

export async function onRequestPost({ request, env }) {
  const auth = request.headers.get("authorization") || "";
  const u = await fetch(`${SB}/auth/v1/user`, { headers: { authorization: auth, apikey: ANON } });
  if (!u.ok) return J({ erro: "não autenticado" }, 401);
  if (!env.GEMINI_API_KEY) return J({ erro: "GEMINI_API_KEY não configurada" }, 500);
  const b = await request.json().catch(() => ({}));
  const okPlano = await sb(auth, "rpc/tem_recurso", { method: "POST", body: JSON.stringify({ p_recurso: "perfis" }) }).then(r => r.ok ? r.json() : false).catch(() => false);
  if (okPlano !== true) return J({ erro: "Perfis de busca fazem parte dos planos Básico e Premium.", plano: true }, 402);
  try {
    if (b.acao === "sugerir") return J({ texto: await sugerir(env, String(b.texto || "").slice(0, 3000)) });
    const id = String(b.perfil || "");
    if (!/^[0-9a-f-]{36}$/.test(id)) return J({ erro: "perfil inválido" }, 400);
    const p = (await (await sb(auth, `perfis_busca?id=eq.${id}&select=*`)).json())[0];
    if (!p) return J({ erro: "perfil não encontrado" }, 404);

    if (b.acao === "salvar") {
      const t = textoPerfil(p);
      const emb_desc = t ? await vetor(env, t, "RETRIEVAL_QUERY") : null;
      const r = await sb(auth, `perfis_busca?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ emb_desc }) });
      if (!r.ok) throw new Error("gravar perfil: " + (await r.text()).slice(0, 160));
    } else if (b.acao === "exemplo") {
      const op = Number(b.oportunidade), tipo = b.tipo;
      if (!op || !["pos", "neg", "remover"].includes(tipo)) return J({ erro: "exemplo inválido" }, 400);
      if (tipo !== "remover") await garantirVetorEdital(env, auth, op);
      const pos = new Set(p.exemplos_pos || []), neg = new Set(p.exemplos_neg || []);
      pos.delete(op); neg.delete(op);
      if (tipo === "pos") pos.add(op);
      if (tipo === "neg") neg.add(op);
      const r = await sb(auth, `perfis_busca?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ exemplos_pos: [...pos], exemplos_neg: [...neg] }) });
      if (!r.ok) throw new Error("gravar exemplo: " + (await r.text()).slice(0, 160));
    } else if (b.acao !== "triar") return J({ erro: "ação inválida" }, 400);

    const funil = await rpc(auth, "triar_perfil", { p_id: id });
    let funil_pca = null;
    if (!funil?.erro) funil_pca = await rpc(auth, "triar_pca", { p_id: id }).catch(() => null);  // PCA e opcional: so tem nota se ja houver vetores
    if (p.ativo && !funil?.erro) await rpc(auth, "radar_v2", { p_id: id });
    return J({ ok: true, funil, funil_pca });
  } catch (e) { return J({ erro: String(e.message || e).slice(0, 240) }, 500); }
}
