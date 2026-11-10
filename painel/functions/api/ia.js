// IA interativa do painel (Gemini). Exige login: o JWT do Supabase é validado e reutilizado nas consultas (RLS).
// Segredo necessário no Cloudflare Pages: GEMINI_API_KEY. Só texto público de edital é enviado ao Gemini.
const SB = "https://tkbkkqebsxvmxnqiwjfl.supabase.co";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRrYmtrcWVic3h2bXhucWl3amZsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM5MDk1MjIsImV4cCI6MjEwOTQ4NTUyMn0.v--eJcYHEanBh9WG1xgOP-jPGwbR_fikk65AkvMPEaI";
const MODELOS = ["gemini-3.1-flash-lite", "gemini-2.5-flash-lite", "gemini-2.5-flash"];
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

async function gemini(env, prompt, json) {
  for (const m of MODELOS) {
    for (const espera of [0, 4000]) {
      if (espera) await new Promise(r => setTimeout(r, espera));
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": env.GEMINI_API_KEY, "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, ...(json ? { responseMimeType: "application/json" } : {}) } }),
      });
      if (r.status === 404) break;                    // modelo inexistente: tenta o próximo
      if (r.status === 429 || r.status >= 500) continue;
      if (!r.ok) throw new Error(`Gemini ${r.status}`);
      const j = await r.json();
      const t = j.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";
      if (!json) return t;
      try { return JSON.parse(t); } catch { throw new Error("resposta da IA inválida"); }
    }
  }
  throw new Error("limite de uso da IA atingido; tente em alguns minutos");
}

async function geminiPartes(env, partes) {        // mesma escolha de modelo, mas aceita PDF junto do texto
  for (const m of MODELOS) {
    for (const espera of [0, 4000]) {
      if (espera) await new Promise(r => setTimeout(r, espera));
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": env.GEMINI_API_KEY, "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: partes }], generationConfig: { temperature: 0.3, responseMimeType: "application/json" } }),
      });
      if (r.status === 404) break;
      if (r.status === 429 || r.status >= 500) continue;
      if (!r.ok) throw new Error(`Gemini ${r.status}`);
      const j = await r.json();
      const t = j.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";
      try { return JSON.parse(t); } catch { throw new Error("resposta da IA inválida"); }
    }
  }
  throw new Error("limite de uso da IA atingido; tente em alguns minutos");
}

const b64 = buf => {                               // base64 em blocos, para nao estourar a pilha
  const u = new Uint8Array(buf); let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
};

const PNCP_MAX = 4 * 1024 * 1024;                  // acima disso o PDF vai pela API de arquivos do Gemini, nao inline
const MAX_PDF = 40 * 1024 * 1024;                  // teto por PDF lido

// Sobe um PDF grande para a API de arquivos do Gemini (some sozinho em 48 h; nada e guardado por nos).
async function gemArquivo(env, buf) {
  const f = 'x-goog-api-key';
  const corpo = new Blob(['--lim\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"file":{"display_name":"edital"}}\r\n--lim\r\nContent-Type: application/pdf\r\n\r\n', buf, '\r\n--lim--']);
  const r = await fetch('https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=multipart', { method: 'POST', headers: { [f]: env.GEMINI_API_KEY, 'content-type': 'multipart/related; boundary=lim' }, body: corpo });
  if (!r.ok) throw new Error(`envio do PDF à IA falhou (${r.status})`);
  let a = (await r.json()).file;
  for (let i = 0; i < 15 && a?.state && a.state !== 'ACTIVE'; i++) {
    if (a.state === 'FAILED') throw new Error('a IA não conseguiu processar o PDF');
    await new Promise(x => setTimeout(x, 2000));
    a = await (await fetch(`https://generativelanguage.googleapis.com/v1beta/${a.name}`, { headers: { [f]: env.GEMINI_API_KEY } })).json();
  }
  return { fileData: { mimeType: 'application/pdf', fileUri: a.uri } };
}

// ---- prazo de impugnacao: 3 dias uteis antes da abertura (Lei 14.133/2021, art. 164)
function pascoa(a) {
  const f = Math.floor, c = f(a / 100), n = a % 19,
    i0 = f((c - f(c / 4) - f((8 * c + 13) / 25) + 19 * n + 15) % 30),
    i = i0 - f(i0 / 28) * (1 - f(29 / (i0 + 1)) * f((21 - n) / 11)),
    j0 = (a + f(a / 4) + i + 2 - c + f(c / 4)) % 7,
    l = i - j0, m = 3 + f((l + 40) / 44), d = l + 28 - 31 * f(m / 4);
  return new Date(Date.UTC(a, m - 1, d));
}
function feriados(ano) {
  const p = pascoa(ano), dia = (dt, n) => new Date(dt.getTime() + n * 864e5).toISOString().slice(0, 10);
  return new Set([`${ano}-01-01`, `${ano}-04-21`, `${ano}-05-01`, `${ano}-09-07`, `${ano}-10-12`,
    `${ano}-11-02`, `${ano}-11-15`, `${ano}-11-20`, `${ano}-12-25`,
    dia(p, -48), dia(p, -47), dia(p, -2), dia(p, 60)]);   // carnaval, sexta-feira santa, corpus christi
}
function diasUteisAntes(iso, n) {
  if (!iso) return null;
  let d = new Date(iso); d.setUTCHours(12, 0, 0, 0);
  let restam = n;
  while (restam > 0) {
    d = new Date(d.getTime() - 864e5);
    const s = d.getUTCDay(), f = feriados(d.getUTCFullYear());
    if (s !== 0 && s !== 6 && !f.has(d.toISOString().slice(0, 10))) restam--;
  }
  return d.toISOString().slice(0, 10);
}
function diasUteisEntre(aIso, bIso) {
  let a = new Date(aIso + "T12:00:00Z"), b = new Date(bIso + "T12:00:00Z"), n = 0, s = a <= b ? 1 : -1;
  while (a.toISOString().slice(0, 10) !== b.toISOString().slice(0, 10)) {
    a = new Date(a.getTime() + s * 864e5);
    const w = a.getUTCDay();
    if (w !== 0 && w !== 6 && !feriados(a.getUTCFullYear()).has(a.toISOString().slice(0, 10))) n += s;
  }
  return n;
}

// Extrai os PDFs de dentro de um .zip (muitos editais do PNCP vem zipados). Leitor minimo: diretorio central + deflate-raw.
async function pdfsDoZip(buf) {
  const v = new DataView(buf), u = new Uint8Array(buf);
  let e = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65600); i--) if (v.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) return [];
  const n = v.getUint16(e + 10, true); let p = v.getUint32(e + 16, true); const itens = [];
  for (let k = 0; k < n && v.getUint32(p, true) === 0x02014b50; k++) {
    const met = v.getUint16(p + 10, true), cs = v.getUint32(p + 20, true), us = v.getUint32(p + 24, true);
    const nl = v.getUint16(p + 28, true), el = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true), off = v.getUint32(p + 42, true);
    const nome = new TextDecoder().decode(u.subarray(p + 46, p + 46 + nl));
    if (/\.pdf$/i.test(nome)) itens.push({ nome, met, cs, us, off });
    p += 46 + nl + el + cl;
  }
  const pontos = nm => { const t = nm.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); return /edital/.test(t) ? 0 : /termo.*referencia|\btr\b|projeto basico/.test(t) ? 1 : /minuta|contrato/.test(t) ? 3 : 2; };
  itens.sort((a, b) => pontos(a.nome) - pontos(b.nome) || a.us - b.us);
  const saida = [];
  for (const it of itens) {
    if (saida.length >= 2 || !it.us || it.us > MAX_PDF) continue;
    const nl = v.getUint16(it.off + 26, true), el = v.getUint16(it.off + 28, true), ini = it.off + 30 + nl + el;
    const dados = u.subarray(ini, ini + it.cs);
    let pdf;
    if (it.met === 0) pdf = dados.slice().buffer;
    else if (it.met === 8) pdf = await new Response(new Blob([dados]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer();
    else continue;
    if (new TextDecoder().decode(new Uint8Array(pdf, 0, 4)) === "%PDF") saida.push(pdf);
  }
  return saida;
}

// Baixa o edital no PNCP (PDF direto ou PDF dentro de .zip). O motivo de nao ter achado vai em partes.motivo.
async function pdfsDoEdital(numero, env) {
  const m = /^(\d{14})-\d+-(\d+)\/(\d{4})$/.exec(numero || "");
  const vazio = motivo => Object.assign([], { motivo });
  if (!m) return vazio("o edital não tem número de controle do PNCP");
  let r;
  try { r = await fetch(`https://pncp.gov.br/pncp-api/v1/orgaos/${m[1]}/compras/${m[3]}/${parseInt(m[2], 10)}/arquivos`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) }); }
  catch { throw new Error("PNCP_FORA"); }
  if (r.status >= 500 || r.status === 429) throw new Error("PNCP_FORA");
  if (!r.ok) return vazio(`o PNCP respondeu ${r.status} ao listar os documentos`);
  const tipo = a => (a.tipoDocumentoNome || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const arqs = (await r.json() || []).filter(a => a.statusAtivo !== false && ["edital", "termo de referencia", "projeto basico"].includes(tipo(a)))
    .sort((a, b) => (tipo(a) === "edital" ? 0 : 1) - (tipo(b) === "edital" ? 0 : 1));
  if (!arqs.length) return vazio("o PNCP não lista documento do tipo edital para esta compra");
  const partes = []; let total = 0, motivo = "";
  for (const a of arqs.slice(0, 2)) {
    const url = a.url || a.uri; if (!url) continue;
    let d;
    try { d = await fetch(url, { signal: AbortSignal.timeout(25000) }); } catch { throw new Error("PNCP_FORA"); }
    if (d.status >= 500 || d.status === 429) throw new Error("PNCP_FORA");
    if (!d.ok) { motivo = `o PNCP respondeu ${d.status} ao baixar o arquivo`; continue; }
    const buf = await d.arrayBuffer();
    const cab = new TextDecoder().decode(new Uint8Array(buf.slice(0, 4)));
    let pdfs = [];
    if (cab === "%PDF") pdfs = buf.byteLength <= MAX_PDF ? [buf] : [];
    else if (cab.startsWith("PK")) pdfs = await pdfsDoZip(buf).catch(() => []);
    else { motivo = "o arquivo do edital não é PDF nem ZIP com PDF (ex.: Word)"; continue; }
    if (!pdfs.length) { motivo = motivo || "o arquivo do edital é grande demais ou não contém PDF legível"; continue; }
    for (const pdf of pdfs) {
      if (total + pdf.byteLength > MAX_PDF) continue;
      total += pdf.byteLength;
      partes.push(pdf.byteLength > PNCP_MAX ? await gemArquivo(env, pdf) : { inlineData: { mimeType: "application/pdf", data: b64(pdf) } });
    }
  }
  return partes.length ? partes : vazio(motivo || "não consegui extrair o PDF do edital");
}

// Recorte inteligente: manda ao Gemini só os trechos do edital que decidem a participação.
const TERMOS_RECORTE = [
  [6, ["habilitacao", "qualificacao tecnica", "qualificacao economico", "atestado de capacidade", "documentos de habilitacao", "regularidade fiscal", "certidao negativa", "balanco patrimonial", "indice de liquidez", "capital social minimo", "registro no conselho", "cnae"]],
  [5, ["prazo de entrega", "prazo de execucao", "cronograma de entrega", "local de entrega", "prazo de vigencia", "vigencia do contrato", "prorrogacao"]],
  [5, ["garantia contratual", "garantia da proposta", "garantia do produto", "seguro garantia", "caucao", "retencao"]],
  [5, ["sancao", "sancoes", "penalidade", "multa", "advertencia", "impedimento de licitar", "declaracao de inidoneidade", "rescisao"]],
  [4, ["pagamento", "nota fiscal", "liquidacao", "reajuste", "repactuacao", "dotacao orcamentaria"]],
  [4, ["amostra", "prova de conceito", "visita tecnica", "vistoria", "laudo", "selo de inspecao", "anvisa", "inmetro"]],
  [4, ["criterio de julgamento", "menor preco", "maior desconto", "tecnica e preco", "modo de disputa", "valor estimado", "valor maximo", "preco de referencia", "orcamento estimado"]],
  [3, ["exclusiva para microempresa", "me/epp", "microempresa e empresa de pequeno porte", "cota reservada", "beneficio da lei complementar"]],
  [3, ["objeto", "especificacao tecnica", "descricao do objeto", "quantitativo", "unidade de medida"]],
  [3, ["subcontratacao", "consorcio", "obrigacoes da contratada", "fiscalizacao", "recebimento provisorio"]],
];
const semAcento = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function pedacos(linha, alvo) {
  if (linha.length <= alvo) return [linha];
  const out = []; let atual = "";
  for (const fr of linha.split(/(?<=[.;:])\s+/)) {
    if (atual && atual.length + fr.length > alvo) { out.push(atual); atual = fr; }
    else atual = (atual + " " + fr).trim();
  }
  if (atual) out.push(atual);
  return out.flatMap(p => p.length <= alvo * 2 ? [p] : p.match(new RegExp(`.{1,${alvo}}`, "gs")) || []);
}

function blocos(texto, alvo = 900) {
  const out = []; let buf = [], n = 0;
  for (const bruta of texto.split("\n")) for (const linha of pedacos(bruta, alvo)) {
    buf.push(linha); n += linha.length + 1;
    if (n >= alvo) { out.push(buf.join("\n")); buf = []; n = 0; }
  }
  if (buf.length) out.push(buf.join("\n"));
  return out;
}

function peso(bloco) {
  const b = semAcento(bloco);
  let p = 0;
  for (const [valor, termos] of TERMOS_RECORTE) {
    const achou = termos.filter(t => b.includes(t)).length;
    if (achou) p += valor * Math.min(achou, 3);
  }
  if (/^\s*(\d{1,2}(\.\d{1,2})*\s*[-.–)]?\s+|cl[aá]usula\b|anexo\b)/i.test(bloco)) p += 1;
  if (b.trim().length < 120) p -= 2;
  return p;
}

function recortar(texto, limite = 22000, cabeca = 6000) {
  if (texto.length <= limite) return texto;
  const inicio = texto.slice(0, cabeca), bl = blocos(texto.slice(cabeca));
  const ordem = bl.map((b, i) => [peso(b), i]).sort((a, c) => c[0] - a[0]);
  const orcamento = limite - inicio.length - 200;
  const escolhidos = new Set(); let usado = 0;
  for (const [p, i] of ordem) {
    if (p <= 0 || usado + bl[i].length > orcamento) continue;
    escolhidos.add(i); usado += bl[i].length + 8;
  }
  if (!escolhidos.size) return texto.slice(0, limite);
  const partes = [inicio]; let anterior = -1;
  for (const i of [...escolhidos].sort((a, b) => a - b)) {
    if (i !== anterior + 1) partes.push("[...]");
    partes.push(bl[i]); anterior = i;
  }
  if (anterior < bl.length - 1) partes.push("[...]");
  return partes.join("\n").slice(0, limite);
}

export async function onRequestPost({ request, env }) {
  if (!env.GEMINI_API_KEY) return J({ erro: "GEMINI_API_KEY não configurada no Cloudflare" }, 500);
  const auth = request.headers.get("authorization") || "";
  const u = await fetch(`${SB}/auth/v1/user`, { headers: { authorization: auth, apikey: ANON } });
  if (!u.ok) return J({ erro: "não autenticado" }, 401);
  const H = { authorization: auth, apikey: ANON };
  const get = async path => { const r = await fetch(`${SB}/rest/v1/${path}`, { headers: H }); return r.ok ? r.json() : []; };

  let b; try { b = await request.json(); } catch { return J({ erro: "JSON inválido" }, 400); }
  if (!["arquivos", "baixar"].includes(b.acao)) {
    const ok = await fetch(`${SB}/rest/v1/rpc/tem_recurso`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ p_recurso: "ia" }) }).then(r => r.ok ? r.json() : false).catch(() => false);
    if (ok !== true) return J({ erro: "A leitura por IA faz parte dos planos Básico e Premium.", plano: true }, 402);
  }
  const id = parseInt(b.oportunidade_id, 10);
  if (!id) return J({ erro: "informe oportunidade_id" }, 400);
  const [op] = await get(`oportunidades?id=eq.${id}&select=id,objeto,orgao_nome,uf,municipio,modalidade,valor_estimado,valor_sigiloso,data_fim_proposta,ia_resumo,ia_termo,link_pncp,numero_controle_pncp`);
  if (!op) return J({ erro: "oportunidade não encontrada" }, 404);
  const [an] = await get(`edital_analise?oportunidade_id=eq.${id}&select=dados,resumo,risco,fonte`);
  const resumoEdital = JSON.stringify(an?.dados || {}).slice(0, 6000);
  const ctx = `OBJETO: ${(op.objeto || "").slice(0, 1200)}\nÓRGÃO: ${op.orgao_nome} (${op.municipio || ""}/${op.uf})\nMODALIDADE: ${op.modalidade || ""}\nVALOR ESTIMADO: ${op.valor_sigiloso ? "sigiloso" : op.valor_estimado}\nPRAZO PROPOSTAS: ${op.data_fim_proposta || ""}\nANÁLISE DO EDITAL (JSON): ${resumoEdital}`;

  try {
    if (b.acao === "analisar") {
      // Análise completa do edital sob demanda (a coleta também faz isso, mas só para editais do radar).
      const [tx] = await get(`edital_textos?oportunidade_id=eq.${id}&select=texto,arquivo`);
      // sem texto salvo: baixa o PDF no PNCP e manda ao Gemini, que le PDF direto
      let pncpFora = false;
      const pdfs = tx?.texto ? [] : await pdfsDoEdital(op.numero_controle_pncp, env).catch(e => { if (e.message === "PNCP_FORA") pncpFora = true; return Object.assign([], { motivo: "" }); });
      const motivo = pdfs.motivo || "";
      // leitura pedida pelo botao: com o PNCP fora do ar nao devolve analise "so pelo objeto", avisa
      if (pncpFora && b.exigir_edital) return J({ erro: "PNCP_FORA" }, 503);
      const fonte = tx?.texto || pdfs.length ? "edital" : "objeto";
      const corpo = pdfs.length
        ? `O EDITAL COMPLETO VAI ANEXADO EM PDF. OBJETO: ${(op.objeto || "").slice(0, 1200)}`
        : tx?.texto
        ? `TEXTO DO EDITAL (${tx.arquivo || ""}):\n${recortar(tx.texto)}`
        : `SÓ O OBJETO (o edital ainda não foi baixado):\n${(op.objeto || "").slice(0, 4000)}\nÓRGÃO: ${op.orgao_nome} (${op.municipio || ""}/${op.uf})\nMODALIDADE: ${op.modalidade || ""}\nVALOR ESTIMADO: ${op.valor_sigiloso ? "sigiloso" : op.valor_estimado}\nPRAZO PARA PROPOSTAS: ${op.data_fim_proposta || ""}`;
      const prompt = `Você analisa editais de licitação pública brasileira para uma consultoria que ajuda empresas fornecedoras a participar.
Responda SOMENTE um objeto JSON com estes campos (use null ou lista vazia quando não constar; NÃO invente):
{
 "resumo": "até 3 frases: o que se contrata, critério de julgamento e principais condições",
 "habilitacao": {"juridica": [], "fiscal_trabalhista": [], "tecnica": [], "economico_financeira": []},
 "exige_amostra": true ou false, "exige_visita_tecnica": true ou false, "exclusivo_me_epp": true ou false,
 "criterio_julgamento": "", "prazo_entrega": "", "local_entrega": "", "vigencia": "", "garantia": "", "pagamento": "",
 "riscos": [{"nivel": "alto" ou "medio" ou "baixo", "tema": "", "descricao": ""}],
 "risco_geral": número de 0 a 100 (100 = muito arriscado ou restritivo para um fornecedor),
 "oportunidade": "1 ou 2 frases: por que vale (ou não vale) a pena para um fornecedor deste setor",
 "perfil_fornecedor": "1 frase: que tipo de empresa tem condições de atender"
}
Cada item de habilitação deve ser curto (até 120 caracteres).
Em riscos considere prazo curto, exigência desproporcional, amostra, garantia alta, pagamento longo, possível direcionamento e multas elevadas.
${fonte === "objeto" ? 'Você recebeu apenas o objeto resumido: analise só o que ele permite, deixe o resto vazio e inclua em riscos um item {"nivel":"medio","tema":"Edital não lido","descricao":"Confirme exigências e prazos no edital completo no PNCP."}.' : ""}

${corpo}`;
      const res = pdfs.length ? await geminiPartes(env, [{ text: prompt }, ...pdfs]) : await gemini(env, prompt, true);
      const d = Array.isArray(res) ? (res[0] || {}) : (res || {});
      let risco = parseInt(d.risco_geral, 10);
      risco = isNaN(risco) ? null : Math.max(0, Math.min(100, risco));
      await fetch(`${SB}/rest/v1/rpc/salvar_analise`, {
        method: "POST",
        headers: { ...H, "content-type": "application/json" },
        body: JSON.stringify({ p_op: id, p_dados: d, p_risco: risco, p_resumo: (d.resumo || "").slice(0, 700), p_fonte: fonte }),
      });
      return J({ ok: true, dados: d, risco, resumo: d.resumo || "", fonte, pncp_fora: pncpFora, motivo: fonte === "objeto" ? motivo : "" });
    }
    if (b.acao === "arquivos" || b.acao === "baixar") {
      // Lista os documentos do edital no PNCP; "baixar" entrega o arquivo pelo proprio dominio do painel.
      const m = /^(\d{14})-\d+-(\d+)\/(\d{4})$/.exec(op.numero_controle_pncp || "");
      if (!m) return J({ ok: true, arquivos: [] });
      let r;
      try { r = await fetch(`https://pncp.gov.br/pncp-api/v1/orgaos/${m[1]}/compras/${m[3]}/${parseInt(m[2], 10)}/arquivos`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10000) }); }
      catch { return J({ erro: "o PNCP não respondeu a tempo (instabilidade deles). Tente de novo em alguns minutos." }, 504); }
      if (!r.ok) return J({ erro: `PNCP respondeu ${r.status}` }, 502);
      const todos = (await r.json()) || [];
      const urlDe = a => a.url || a.uri || "";
      if (b.acao === "baixar") {
        const a = todos[parseInt(b.n, 10)];
        if (!a || !urlDe(a).startsWith("https://pncp.gov.br/")) return J({ erro: "documento não encontrado" }, 404);
        let d;
        try { d = await fetch(urlDe(a), { signal: AbortSignal.timeout(25000) }); } catch { return J({ erro: "o PNCP não respondeu a tempo. Tente de novo em alguns minutos." }, 504); }
        if (!d.ok) return J({ erro: `PNCP respondeu ${d.status}` }, 502);
        const cd = d.headers.get("content-disposition") || "";
        const nome = (/filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(cd)?.[1]) || `${(a.titulo || "documento").replace(/[^\w.-]+/g, "_")}.pdf`;
        return new Response(d.body, { headers: { "content-type": d.headers.get("content-type") || "application/octet-stream", "x-nome": encodeURIComponent(decodeURIComponent(nome)), "access-control-expose-headers": "x-nome" } });
      }
      const lista = todos.map((a, n) => ({ n, a })).filter(x => x.a.statusAtivo !== false && urlDe(x.a)).map(x => ({
        n: x.n, titulo: x.a.titulo || "documento", tipo: x.a.tipoDocumentoNome || "", data: x.a.dataPublicacaoPncp || "",
      }));
      return J({ ok: true, arquivos: lista });
    }
    if (b.acao === "direcionamento" || b.acao === "impugnacao") {
      // Le o edital (texto salvo ou PDF do PNCP) e procura clausulas restritivas.
      const [tx] = await get(`edital_textos?oportunidade_id=eq.${id}&select=texto,arquivo`);
      const pdfs = tx?.texto ? [] : await pdfsDoEdital(op.numero_controle_pncp, env).catch(() => []);
      const fonte = tx?.texto || pdfs.length ? "edital" : "objeto";
      const corpo = pdfs.length
        ? `O EDITAL COMPLETO VAI ANEXADO EM PDF. OBJETO: ${(op.objeto || "").slice(0, 1200)}`
        : tx?.texto ? `TEXTO DO EDITAL (${tx.arquivo || ""}):\n${recortar(tx.texto)}`
        : `SÓ O OBJETO (o edital não foi baixado):\n${ctx}\nANÁLISE JÁ FEITA: ${resumoEdital.slice(0, 2500)}`;

      if (b.acao === "direcionamento" && fonte === "objeto") {
        return J({ ok: true, fonte, indisponivel: true, nivel: "indefinido", itens: [],
          conclusao: "O texto do edital ainda não está disponível (o PNCP não devolveu o arquivo). Sem ele não dá para apontar cláusulas restritivas. A coleta baixa os editais do radar a cada rodada; tente de novo depois." });
      }
      if (b.acao === "direcionamento") {
        const prompt = `Você é advogado de licitações e defende FORNECEDORES. Procure no edital abaixo cláusulas que restrinjam a competição além do necessário ou que pareçam desenhadas para um fornecedor específico.
Procure especificamente: marca, modelo ou fabricante exigido sem "ou equivalente"; atestado de capacidade técnica desproporcional (quantidade/valor muito acima do objeto, exigência de atestado do mesmo órgão, de um único contrato ou de prazo longo demais); exigência de instalação, filial, sede ou visita técnica na cidade como condição de participação; índices contábeis fora do usual; capital social ou patrimônio líquido acima de 10% do valor estimado; garantia de proposta acima de 1%; prazo de entrega incompatível; amostra exigida de todos antes do julgamento; agrupamento de itens distintos em um lote só; qualificação exigida da empresa em vez do profissional; exigência de certificação sem previsão legal.
NÃO invente: só aponte o que estiver no documento. Se o documento não permitir avaliar, diga isso.
Responda SOMENTE JSON:
{"nivel":"alto"|"medio"|"baixo"|"indefinido",
 "itens":[{"clausula":"item/cláusula do edital, ex.: 9.2.1","tema":"curto","trecho":"citação literal de até 220 caracteres","problema":"por que restringe a competição, 1 a 2 frases","base_legal":"dispositivo da Lei 14.133/2021 ou súmula/acórdão do TCU aplicável","pedido":"o que pedir: supressão, retificação ou esclarecimento"}],
 "conclusao":"2 a 3 frases para o consultor decidir se vale impugnar",
 "vale_impugnar": true|false}
Ordene os itens do mais grave para o menos grave e traga no máximo 6.

${corpo}`;
        const res = pdfs.length ? await geminiPartes(env, [{ text: prompt }, ...pdfs]) : await gemini(env, prompt, true);
        const d = Array.isArray(res) ? (res[0] || {}) : (res || {});
        return J({ ok: true, fonte, ...d });
      }

      // ---- impugnacao: prazo + minuta
      const abertura = op.data_fim_proposta;
      const hoje = new Date().toISOString().slice(0, 10);
      const limite = diasUteisAntes(abertura, 3);
      const prazo = {
        abertura, limite,
        dias_uteis: limite ? diasUteisEntre(hoje, limite) : null,
        no_prazo: limite ? limite >= hoje : null,
        base: "Lei 14.133/2021, art. 164: qualquer pessoa pode impugnar o edital ou pedir esclarecimento até 3 dias úteis antes da data de abertura; a resposta sai em até 3 dias úteis e antes da abertura.",
      };
      if (fonte === "objeto" && !(Array.isArray(b.pontos) && b.pontos.length)) {
        return J({ ok: true, fonte, prazo, indisponivel: true,
          resumo: "O texto do edital ainda não foi baixado, então não dá para redigir a peça com citação de cláusulas. O prazo abaixo já está calculado." });
      }
      const pontos = Array.isArray(b.pontos) && b.pontos.length
        ? JSON.stringify(b.pontos).slice(0, 4000)
        : "(não informados: identifique você mesmo no edital os pontos restritivos mais graves)";
      const prompt = `Redija uma IMPUGNAÇÃO AO EDITAL completa, em português do Brasil, no padrão forense brasileiro, pronta para a empresa assinar e protocolar.
Estrutura obrigatória, nesta ordem:
1. Endereçamento ao pregoeiro/agente de contratação e ao órgão, com o número da licitação e do processo.
2. Qualificação da impugnante com campos entre colchetes para a empresa preencher ([RAZÃO SOCIAL], [CNPJ], [ENDEREÇO], [REPRESENTANTE], [E-MAIL]).
3. TEMPESTIVIDADE: diga que a abertura é em ${abertura ? new Date(abertura).toLocaleDateString("pt-BR") : "[DATA]"} e o prazo final para impugnar é ${limite ? limite.split("-").reverse().join("/") : "[DATA]"}, citando o art. 164 da Lei 14.133/2021.
4. DOS FATOS: o que o edital exige, em poucos parágrafos.
5. DO DIREITO: um subtítulo por ponto impugnado, cada um citando o item do edital, transcrevendo o trecho entre aspas, explicando a restrição à competitividade e fundamentando em dispositivos da Lei 14.133/2021 (em especial arts. 5º, 9º, 11, 37, 40, 62, 67 e 72, conforme o caso) e em jurisprudência do TCU quando couber. Só cite acórdão ou súmula se tiver certeza do número; na dúvida, escreva apenas "entendimento consolidado do TCU".
6. DOS PEDIDOS: pedidos numerados (recebimento e processamento, suspensão da sessão se necessário, retificação ou supressão de cada cláusula, republicação com reabertura do prazo).
7. Fecho com local, data e assinatura entre colchetes.
Seja objetivo e técnico, sem adjetivos. Não invente fatos nem números do edital.
Responda SOMENTE JSON: {"minuta":"texto completo da peça, com quebras de linha","resumo":"1 frase sobre o que a peça pede","pontos_usados":["lista curta dos pontos impugnados"]}

PONTOS A IMPUGNAR: ${pontos}

${corpo}`;
      const res = pdfs.length ? await geminiPartes(env, [{ text: prompt }, ...pdfs]) : await gemini(env, prompt, true);
      const d = Array.isArray(res) ? (res[0] || {}) : (res || {});
      return J({ ok: true, fonte, prazo, ...d });
    }
    if (b.acao === "checklist") {
      const eid = parseInt(b.empresa_id, 10);
      if (!eid) return J({ erro: "informe empresa_id" }, 400);
      const [emp] = await get(`empresas?id=eq.${eid}&select=*`);
      const docs = await get(`empresa_docs?empresa_id=eq.${eid}&select=tipo,numero,validade,observacao`);
      const hoje = new Date().toISOString().slice(0, 10);
      const prompt = `Você confere a habilitação de uma empresa em uma licitação pública brasileira.\nHoje: ${hoje}.\n${ctx}\n\nEMPRESA: ${JSON.stringify(emp || {}).slice(0, 1200)}\nDOCUMENTOS DA EMPRESA (tipo, validade): ${JSON.stringify(docs).slice(0, 3000)}\n\nCompare o que o edital exige com os documentos cadastrados. Responda SOMENTE JSON:\n{"veredito":"apta|atencao|inapta|indefinido","resumo":"2 frases","itens":[{"exigencia":"","situacao":"ok|vencido|falta|verificar","detalhe":"curto"}],"proximos_passos":["curto"]}\nNão invente exigências que não constem na análise; se a análise for só do objeto, diga que é preciso ler o edital e use "verificar".`;
      return J({ ok: true, ...(await gemini(env, prompt, true)) });
    }
    if (b.acao === "abordagem") {
      const canal = b.canal === "email" ? "e-mail" : "WhatsApp";
      const [emp] = b.empresa_id ? await get(`empresas?id=eq.${parseInt(b.empresa_id, 10)}&select=*`) : [];
      const prompt = `Escreva em português do Brasil uma mensagem de ${canal} de uma consultoria de licitações para uma empresa fornecedora, apresentando UMA oportunidade concreta e oferecendo apoio na habilitação e na participação (remuneração por êxito/comissão). Tom profissional, cordial e direto; sem promessas de ganho garantido; ${canal === "WhatsApp" ? "até 700 caracteres" : "com assunto e até 1200 caracteres"}. Termine convidando para uma conversa. Não invente dados de contato nem valores que não estejam no contexto. Inclua uma linha final: "Para deixar de receber contatos, basta avisar." (LGPD).\n${ctx}\nEMPRESA (opcional): ${JSON.stringify(emp || {}).slice(0, 800)}\nResponda SOMENTE JSON: {"assunto":"(vazio no WhatsApp)","mensagem":""}`;
      return J({ ok: true, ...(await gemini(env, prompt, true)) });
    }
    if (b.acao === "termos") {
      const prompt = `Sugira termos de busca para pesquisar preços de referência desta contratação no Catálogo do Compras.gov.br e em atas de registro de preços. Responda SOMENTE JSON: {"termos":["3 a 6 termos curtos e específicos (2 a 4 palavras)"],"observacao":"1 frase sobre o que cuidar na comparação (unidade, especificação, região)"}\n${ctx}`;
      return J({ ok: true, ...(await gemini(env, prompt, true)) });
    }
    if (b.acao === "risco") {
      const prompt = `Explique para um consultor, em até 6 tópicos curtos, os principais riscos e pontos de atenção desta licitação para um fornecedor (prazos, exigências, garantias, amostra, pagamento, direcionamento). Se não houver dados suficientes, diga o que verificar no edital. Responda SOMENTE JSON: {"nivel":"alto|medio|baixo|indefinido","topicos":["..."]}\n${ctx}`;
      return J({ ok: true, ...(await gemini(env, prompt, true)) });
    }
    if (b.acao === "pergunta") {
      const perg = String(b.pergunta || "").slice(0, 500).trim();
      if (!perg) return J({ erro: "escreva a pergunta" }, 400);
      const [tx] = await get(`edital_textos?oportunidade_id=eq.${id}&select=texto,arquivo`);
      const cab = `Responda à pergunta de um consultor de licitações usando SOMENTE o edital. Seja direto (até 6 frases), cite o item/cláusula quando houver e diga claramente se o edital não trata do assunto. Não dê parecer jurídico definitivo.\nResponda SOMENTE JSON: {"resposta":"","trechos":["citações curtas (até 200 caracteres) do edital que sustentam a resposta"],"encontrado":true}\nPERGUNTA: ${perg}\n\n`;
      if (tx?.texto) return J({ ok: true, ...(await gemini(env, cab + `EDITAL (${tx.arquivo || ""}):\n${tx.texto.slice(0, 120000)}`, true)) });
      // sem texto salvo (ex.: edital encerrado): le o PDF direto no PNCP, so para responder
      let pdfs;
      try { pdfs = await pdfsDoEdital(op.numero_controle_pncp, env); }
      catch (e) { return J({ erro: e.message === "PNCP_FORA" ? "PNCP_FORA" : String(e.message || e) }, e.message === "PNCP_FORA" ? 503 : 502); }
      if (!pdfs.length) return J({ erro: `Não consegui ler o PDF do edital: ${pdfs.motivo || "sem arquivo"}.` }, 422);
      const res = await geminiPartes(env, [{ text: cab + "O EDITAL VAI ANEXADO EM PDF." }, ...pdfs]);
      return J({ ok: true, ...(Array.isArray(res) ? res[0] || {} : res || {}) });
    }
    if (b.acao === "proposta") {
      const [emp] = b.empresa_id ? await get(`empresas?id=eq.${parseInt(b.empresa_id, 10)}&select=*`) : [];
      const itens = await get(`oportunidade_itens?oportunidade_id=eq.${id}&select=numero_item,descricao,quantidade,unidade,valor_unitario&order=numero_item&limit=40`);
      const prompt = `Monte um RASCUNHO de kit de proposta para esta licitação, em português do Brasil, para a empresa abaixo. Use campos entre colchetes para o que a empresa precisa preencher (ex.: [preço unitário], [marca]). Não invente preços. Inclua:\n1) Proposta comercial (identificação da empresa, órgão, número do processo se houver, tabela de itens com quantidade e unidade, validade da proposta de 60 dias ou a exigida no edital, prazo de entrega e condições de pagamento conforme o edital, local, data e assinatura).\n2) Declarações usuais da Lei 14.133/2021 que o edital costuma pedir (cumprimento dos requisitos de habilitação, inexistência de fato impeditivo, não emprego de menor (art. 7º, XXXIII, CF), enquadramento ME/EPP se aplicável, reserva de cargos para PCD e reabilitados, cumprimento das normas de saúde e segurança). Avise que a lista final deve ser conferida no edital.\nResponda SOMENTE JSON: {"proposta":"texto em markdown","declaracoes":"texto em markdown","conferir":["pontos do edital a confirmar antes de enviar"]}\n${ctx}\nEMPRESA: ${JSON.stringify(emp || {}).slice(0, 1000)}\nITENS: ${JSON.stringify(itens).slice(0, 5000)}`;
      return J({ ok: true, ...(await gemini(env, prompt, true)) });
    }
    return J({ erro: "ação inválida" }, 400);
  } catch (e) {
    return J({ erro: String(e.message || e) }, 502);
  }
}
