// Consultas públicas sob demanda (exige login). Nada aqui grava no banco.
//  ?pdm=CODIGO&pagina=N  → itens de material de um PDM (API de Dados Abertos do Compras.gov.br, 4_consultarItemMaterial)
//  ?cnpj=NUMERO          → dados cadastrais públicos (BrasilAPI/Receita) e situação na base pública do SICAF
//                          (modulo-fornecedor/1_consultarFornecedor; essa base NÃO traz linhas de fornecimento)
const SB = "https://tkbkkqebsxvmxnqiwjfl.supabase.co";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRrYmtrcWVic3h2bXhucWl3amZsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM5MDk1MjIsImV4cCI6MjEwOTQ4NTUyMn0.v--eJcYHEanBh9WG1xgOP-jPGwbR_fikk65AkvMPEaI";
const DA = "https://dadosabertos.compras.gov.br";
const J = (o, s = 200, cache = "no-store") => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": cache } });

// até 3 tentativas, 12 s cada; falha devolve erro claro (o cadastro não depende disto)
async function obter(url) {
  let ultimo = "";
  for (const espera of [0, 1500, 4000]) {
    if (espera) await new Promise(r => setTimeout(r, espera));
    try {
      const r = await fetch(url, { headers: { accept: "application/json", "user-agent": "editalvector/1.0" }, signal: AbortSignal.timeout(12000) });
      if (r.status === 404 || r.status === 204) return null;
      if (r.ok) return await r.json();
      ultimo = "HTTP " + r.status;
      if (r.status < 500 && r.status !== 429) break;
    } catch (e) { ultimo = e.name === "TimeoutError" ? "tempo esgotado" : "falha de rede"; }
  }
  throw new Error("fonte indisponível (" + ultimo + ")");
}

export async function onRequestGet({ request }) {
  const auth = request.headers.get("authorization") || "";
  const u = await fetch(`${SB}/auth/v1/user`, { headers: { authorization: auth, apikey: ANON } });
  if (!u.ok) return J({ erro: "não autenticado" }, 401);
  const q = new URL(request.url).searchParams;
  try {
    if (q.get("pdm")) {
      const pdm = q.get("pdm"), pag = Math.max(1, Math.min(200, parseInt(q.get("pagina") || "1", 10) || 1));
      if (!/^\d{1,9}$/.test(pdm)) return J({ erro: "PDM inválido" }, 400);
      const j = await obter(`${DA}/modulo-material/4_consultarItemMaterial?pagina=${pag}&tamanhoPagina=50&codigoPdm=${pdm}`) || {};
      const itens = (j.resultado || []).map(r => ({ tipo: "M", nivel: "item", codigo: String(r.codigoItem), nome: String(r.descricaoItem || "").trim(),
        ativo: r.statusItem !== false, caminho: { grupo: String(r.codigoGrupo), classe: String(r.codigoClasse), pdm: String(r.codigoPdm), item: String(r.codigoItem) },
        rotulo: `${r.codigoGrupo} ${r.nomeGrupo} › ${r.codigoClasse} ${r.nomeClasse} › ${r.codigoPdm} ${r.nomePdm}` }));
      return J({ itens, paginas: j.totalPaginas || 1, total: j.totalRegistros || itens.length }, 200, "public, max-age=86400");
    }
    if (q.get("cnpj")) {
      const c = (q.get("cnpj") || "").replace(/\D/g, "");
      if (c.length !== 14) return J({ erro: "CNPJ inválido" }, 400);
      const [rf, sf] = await Promise.allSettled([obter(`https://brasilapi.com.br/api/cnpj/v1/${c}`),
        obter(`${DA}/modulo-fornecedor/1_consultarFornecedor?pagina=1&tamanhoPagina=10&cnpj=${c}&ativo=true`)]);
      const r = rf.status === "fulfilled" && rf.value ? rf.value : null;
      const s = sf.status === "fulfilled" && sf.value ? (sf.value.resultado || [])[0] || null : null;
      if (!r && rf.status === "rejected" && sf.status === "rejected") return J({ erro: "fontes públicas indisponíveis agora" }, 503);
      return J({
        receita: r ? { razao_social: r.razao_social, nome_fantasia: r.nome_fantasia || null, uf: r.uf, municipio: r.municipio,
          porte: r.porte, cnae: r.cnae_fiscal ? String(r.cnae_fiscal) : null, cnae_desc: r.cnae_fiscal_descricao || null, situacao: r.descricao_situacao_cadastral || null } : null,
        sicaf: s ? { ativo: s.ativo, habilitadoLicitar: s.habilitadoLicitar, porteEmpresaNome: s.porteEmpresaNome, naturezaJuridicaNome: s.naturezaJuridicaNome } : null,
        receita_erro: rf.status === "rejected" ? String(rf.reason.message) : null, sicaf_erro: sf.status === "rejected" ? String(sf.reason.message) : null });
    }
    return J({ erro: "informe pdm ou cnpj" }, 400);
  } catch (e) { return J({ erro: String(e.message || e).slice(0, 160) }, 502); }
}
