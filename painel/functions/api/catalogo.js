// Consultas públicas sob demanda (exige login). Nada aqui grava no banco.
//  ?pdm=CODIGO&pagina=N  → itens de material de um PDM (API de Dados Abertos do Compras.gov.br, 4_consultarItemMaterial)
//  ?historico=CNPJ       → o que o CNPJ já vendeu em atas de registro de preços (Compras.gov.br, filtro niFornecedor),
//                          agregado por PDM (material) ou código de serviço; o banco sobe isso para classe/grupo
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
    if (q.get("historico")) {
      const c = (q.get("historico") || "").replace(/\D/g, "");
      if (c.length !== 14) return J({ erro: "CNPJ inválido" }, 400);
      const hoje = new Date(), ini = new Date(hoje.getTime() - 3 * 365 * 86400000), f = d => d.toISOString().slice(0, 10);
      const agg = new Map(); let total = 0, paginas = 1, parcial = false;
      for (let pag = 1; pag <= Math.min(paginas, 8); pag++) {
        let j;
        try { j = await obter(`${DA}/modulo-arp/2_consultarARPItem?pagina=${pag}&tamanhoPagina=500&niFornecedor=${c}&dataVigenciaInicialMin=${f(ini)}&dataVigenciaInicialMax=${f(hoje)}`); }
        catch (e) { if (pag === 1) throw e; parcial = true; break; }
        if (!j) break;
        total = j.totalRegistros || total; paginas = j.totalPaginas || 1;
        for (const r of j.resultado || []) {
          if (r.itemExcluido) continue;
          const t = /serv/i.test(r.tipoItem || "") ? "S" : "M", cod = t === "M" ? r.codigoPdm : r.codigoItem;
          if (!cod) continue;
          const k = t + cod, a = agg.get(k) || { t, c: String(cod), n: 0, v: 0, u: null };
          a.n++; a.v += Number(r.valorTotal) || 0;
          const d = (r.dataAssinatura || r.dataVigenciaInicial || "").slice(0, 10); if (d && (!a.u || d > a.u)) a.u = d;
          agg.set(k, a);
        }
      }
      if (paginas > 8) parcial = true;
      return J({ itens: [...agg.values()], registros: total, parcial, janela: [f(ini), f(hoje)], fonte: "atas de registro de preços (Compras.gov.br)" });
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
          porte: r.porte, cnae: r.cnae_fiscal ? String(r.cnae_fiscal) : null, cnae_desc: r.cnae_fiscal_descricao || null, cnaes_sec: (r.cnaes_secundarios || []).slice(0, 30).map(x => ({ codigo: String(x.codigo), descricao: x.descricao })), situacao: r.descricao_situacao_cadastral || null } : null,
        sicaf: s ? { ativo: s.ativo, habilitadoLicitar: s.habilitadoLicitar, porteEmpresaNome: s.porteEmpresaNome, naturezaJuridicaNome: s.naturezaJuridicaNome } : null,
        receita_erro: rf.status === "rejected" ? String(rf.reason.message) : null, sicaf_erro: sf.status === "rejected" ? String(sf.reason.message) : null });
    }
    return J({ erro: "informe pdm ou cnpj" }, 400);
  } catch (e) { return J({ erro: String(e.message || e).slice(0, 160) }, 502); }
}
