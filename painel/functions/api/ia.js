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
  const [op] = await get(`oportunidades?id=eq.${id}&select=id,objeto,orgao_nome,uf,municipio,modalidade,valor_estimado,valor_sigiloso,data_fim_proposta,ia_resumo,ia_termo,link_pncp`);
  if (!op) return J({ erro: "oportunidade não encontrada" }, 404);
  const [an] = await get(`edital_analise?oportunidade_id=eq.${id}&select=dados,resumo,risco,fonte`);
  const resumoEdital = JSON.stringify(an?.dados || {}).slice(0, 6000);
  const ctx = `OBJETO: ${(op.objeto || "").slice(0, 1200)}\nÓRGÃO: ${op.orgao_nome} (${op.municipio || ""}/${op.uf})\nMODALIDADE: ${op.modalidade || ""}\nVALOR ESTIMADO: ${op.valor_sigiloso ? "sigiloso" : op.valor_estimado}\nPRAZO PROPOSTAS: ${op.data_fim_proposta || ""}\nANÁLISE DO EDITAL (JSON): ${resumoEdital}`;

  try {
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
    return J({ erro: "ação inválida" }, 400);
  } catch (e) {
    return J({ erro: String(e.message || e) }, 502);
  }
}
