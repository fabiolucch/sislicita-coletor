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

const PNCP_MAX = 8 * 1024 * 1024;                  // teto do que mandamos ao Gemini de uma vez

async function pdfsDoEdital(numero) {
  const m = /^(\d{14})-\d+-(\d+)\/(\d{4})$/.exec(numero || "");
  if (!m) return [];
  const r = await fetch(`https://pncp.gov.br/pncp-api/v1/orgaos/${m[1]}/compras/${m[3]}/${parseInt(m[2], 10)}/arquivos`, { headers: { accept: "application/json" } });
  if (!r.ok) return [];
  const tipo = a => (a.tipoDocumentoNome || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const arqs = (await r.json() || []).filter(a => a.statusAtivo !== false && ["edital", "termo de referencia", "projeto basico"].includes(tipo(a)))
    .sort((a, b) => (tipo(a) === "edital" ? 0 : 1) - (tipo(b) === "edital" ? 0 : 1));
  const partes = []; let total = 0;
  for (const a of arqs.slice(0, 2)) {
    const url = a.url || a.uri; if (!url) continue;
    const d = await fetch(url); if (!d.ok) continue;
    const buf = await d.arrayBuffer();
    if (!buf.byteLength || total + buf.byteLength > PNCP_MAX) continue;
    const bytes = new Uint8Array(buf.slice(0, 5));
    if (String.fromCharCode(...bytes).slice(0, 4) !== "%PDF") continue;   // so PDF: o Gemini nao le .docx/.zip aqui
    total += buf.byteLength;
    partes.push({ inlineData: { mimeType: "application/pdf", data: b64(buf) } });
  }
  return partes;
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
      const pdfs = tx?.texto ? [] : await pdfsDoEdital(op.numero_controle_pncp).catch(() => []);
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
      await fetch(`${SB}/rest/v1/edital_analise?on_conflict=oportunidade_id`, {
        method: "POST",
        headers: { ...H, "content-type": "application/json", prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify([{ oportunidade_id: id, dados: d, risco, resumo: (d.resumo || "").slice(0, 700), fonte }]),
      });
      return J({ ok: true, dados: d, risco, resumo: d.resumo || "", fonte });
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
      if (!tx?.texto) return J({ erro: "o texto deste edital ainda não foi baixado (roda na etapa docs da coleta)" }, 404);
      const prompt = `Responda à pergunta de um consultor de licitações usando SOMENTE o texto do edital abaixo. Seja direto (até 6 frases), cite o item/cláusula quando houver e diga claramente se o edital não trata do assunto. Não dê parecer jurídico definitivo.\nResponda SOMENTE JSON: {"resposta":"","trechos":["citações curtas (até 200 caracteres) do edital que sustentam a resposta"],"encontrado":true}\nPERGUNTA: ${perg}\n\nEDITAL (${tx.arquivo || ""}):\n${tx.texto.slice(0, 120000)}`;
      return J({ ok: true, ...(await gemini(env, prompt, true)) });
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
