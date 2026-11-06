// Proxy + estatística de preços do Compras.gov.br (Dados Abertos).
// O navegador não consegue chamar a API direto (CORS); esta função faz a chamada no servidor.
// Exige login: o token do Supabase é validado antes de qualquer consulta.
const SB = "https://tkbkkqebsxvmxnqiwjfl.supabase.co";
const CAT = "https://dadosabertos.compras.gov.br";
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

const q = (a, p) => { if (!a.length) return null; const i = (a.length - 1) * p, l = Math.floor(i), h = Math.ceil(i); return a[l] + (a[h] - a[l]) * (i - l); };
const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;

export async function onRequestGet({ request, env }) {
  const auth = request.headers.get("authorization") || "";
  const key = env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRrYmtrcWVic3h2bXhucWl3amZsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM5MDk1MjIsImV4cCI6MjEwOTQ4NTUyMn0.v--eJcYHEanBh9WG1xgOP-jPGwbR_fikk65AkvMPEaI"; // chave anon é pública por desenho
  const u = await fetch(`${SB}/auth/v1/user`, { headers: { authorization: auth, apikey: key } });
  if (!u.ok) return J({ erro: "não autenticado" }, 401);

  const p = new URL(request.url).searchParams;
  const tipo = p.get("tipo") === "S" ? "S" : "M";
  const codigo = (p.get("codigo") || "").replace(/\D/g, "");
  if (!codigo) return J({ erro: "informe o código" }, 400);
  const uf = (p.get("uf") || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2);
  const meses = Math.min(Math.max(parseInt(p.get("meses") || "12", 10) || 12, 1), 36);
  const ini = new Date(Date.now() - meses * 30.44 * 864e5).toISOString().slice(0, 10);

  const base = tipo === "M"
    ? `${CAT}/modulo-pesquisa-preco/1_consultarMaterial?tipo=codigoPdm&codigo=${codigo}`
    : `${CAT}/modulo-pesquisa-preco/3_consultarServico?codigoItemCatalogo=${codigo}`;
  const url = n => `${base}&tamanhoPagina=500&pagina=${n}&dataCompraInicio=${ini}${uf ? `&estado=${uf}` : ""}`;

  // Compras.gov.br limita a taxa (429): páginas em sequência, com nova tentativa e cache de 12 h por consulta
  const cache = caches.default;
  const pegar = async (n) => {
    const u = url(n), ck = new Request(u);
    const hit = await cache.match(ck);
    if (hit) return hit.json();
    for (const espera of [0, 1500, 4000, 8000]) {
      if (espera) await new Promise(r => setTimeout(r, espera));
      const r = await fetch(u, { headers: { accept: "application/json" } });
      if (r.status === 429 || r.status >= 500) continue;
      if (!r.ok) throw new Error(`Compras.gov.br respondeu ${r.status}`);
      const j = await r.json();
      await cache.put(ck, new Response(JSON.stringify(j), { headers: { "content-type": "application/json", "cache-control": "public, max-age=43200" } }));
      return j;
    }
    return null;
  };
  let j1;
  try { j1 = await pegar(1); } catch (e) { return J({ erro: String(e.message) }, 502); }
  if (!j1) return J({ erro: "O Compras.gov.br está limitando as consultas agora. Aguarde um minuto e tente de novo." }, 429);
  const total = j1.totalRegistros || 0;
  const paginas = Math.min(j1.totalPaginas || 1, 6); // até 3.000 registros por consulta
  let itens = j1.resultado || [];
  for (let n = 2; n <= paginas; n++) {
    let j = null;
    try { j = await pegar(n); } catch { j = null; }
    if (!j) break;                         // limite atingido: segue com o que já leu (parcial)
    itens = itens.concat(j.resultado || []);
    await new Promise(r => setTimeout(r, 350));
  }
  itens = itens.filter(i => Number(i.precoUnitario) > 0);

  // unidade de fornecimento predominante (evita misturar kg com caixa etc.)
  const un = i => (i.siglaUnidadeFornecimento || i.siglaUnidadeMedida || i.nomeUnidadeFornecimento || i.nomeUnidadeMedida || "UN").toUpperCase();
  const cont = {};
  itens.forEach(i => { const k = un(i); cont[k] = (cont[k] || 0) + 1; });
  const unidades = Object.entries(cont).sort((a, b) => b[1] - a[1]).map(([sigla, n]) => ({ sigla, n }));
  const unSel = (p.get("un") || unidades[0]?.sigla || "").toUpperCase();
  const base1 = itens.filter(i => un(i) === unSel);

  const precos = base1.map(i => Number(i.precoUnitario)).sort((a, b) => a - b);
  const q1 = q(precos, .25), q3 = q(precos, .75), iqr = (q3 ?? 0) - (q1 ?? 0);
  const limpos = precos.filter(x => x >= q1 - 1.5 * iqr && x <= q3 + 1.5 * iqr);
  const estat = precos.length ? {
    n: precos.length, n_sem_outliers: limpos.length,
    minimo: precos[0], minimo_robusto: limpos[0], p25: q1, mediana: q(precos, .5), media: avg(precos), media_robusta: avg(limpos), p75: q3, maximo: precos[precos.length - 1],
  } : null;

  const porUf = {};
  base1.forEach(i => { const k = i.estado || "—"; (porUf[k] ||= []).push(Number(i.precoUnitario)); });
  const ufs = Object.entries(porUf).map(([sigla, a]) => { a.sort((x, y) => x - y); return { uf: sigla, n: a.length, minimo: a[0], mediana: q(a, .5), media: avg(a) }; }).sort((a, b) => b.n - a.n);

  const amostra = base1.sort((a, b) => String(b.dataCompra).localeCompare(String(a.dataCompra))).slice(0, 25).map(i => ({
    data: i.dataCompra, preco: i.precoUnitario, qtd: i.quantidade, un: un(i), uf: i.estado, municipio: i.municipio,
    orgao: i.nomeOrgao, uasg: i.nomeUasg, fornecedor: i.nomeFornecedor, cnpj: i.niFornecedor, item: (i.descricaoItem || "").slice(0, 140), marca: i.marca, modalidade: i.modalidade,
  }));

  // fornecedores que mais vendem (potenciais clientes da assessoria)
  const forn = {};
  base1.forEach(i => { const k = i.niFornecedor || i.nomeFornecedor; if (!k) return; const f = (forn[k] ||= { nome: i.nomeFornecedor, cnpj: i.niFornecedor, n: 0, valor: 0, uf: i.estado }); f.n++; f.valor += Number(i.precoUnitario) * Number(i.quantidade || 1); });
  const fornecedores = Object.values(forn).sort((a, b) => b.valor - a.valor).slice(0, 10);

  return J({ tipo, codigo, uf: uf || null, meses, total_api: total, lidos: itens.length, parcial: total > itens.length, unidades, unidade: unSel, estat, ufs, amostra, fornecedores });
}
