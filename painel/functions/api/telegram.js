// Webhook do bot do Telegram: responde /start, /status e /ajuda na hora.
// Segurança: o Telegram envia o cabeçalho X-Telegram-Bot-Api-Secret-Token, conferido no banco (tg_ok).
// A resposta vai no próprio retorno do webhook (método sendMessage), então o token do bot não fica no Cloudflare.
const SB = "https://tkbkkqebsxvmxnqiwjfl.supabase.co";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRrYmtrcWVic3h2bXhucWl3amZsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM5MDk1MjIsImV4cCI6MjEwOTQ4NTUyMn0.v--eJcYHEanBh9WG1xgOP-jPGwbR_fikk65AkvMPEaI";
const PAINEL = "https://sislicita.pages.dev";
const rpc = (fn, body) => fetch(`${SB}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: ANON, authorization: "Bearer " + ANON, "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.ok ? r.json() : null);
const n = v => Number(v || 0).toLocaleString("pt-BR");
const quando = iso => iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
const h = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const responder = (chat, text) => new Response(JSON.stringify({ method: "sendMessage", chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }), { headers: { "content-type": "application/json" } });

const SOBRE = `🛰️ <b>SISLICITA · Radar de licitações públicas</b>

Este bot avisa você sobre:
🎯 <b>Oportunidades</b> novas no radar com score ≥ 80 (editais e itens do PCA)
🧭 <b>Briefing diário</b> por perfil, gerado por IA
📄 <b>Documentos novos</b> (retificações, esclarecimentos) nos editais do radar, com resumo da mudança
⏰ <b>Sessões</b> dos seus processos nas próximas 48 h
🗂️ <b>Documentos das empresas</b> vencendo em até 15 dias

As coletas rodam às 06:17 e 18:17 (Brasília); os avisos chegam ao fim de cada coleta.

Comandos: /status (situação agora) · /ajuda`;

function proxima() {
  const agora = new Date(), sp = new Date(agora.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const m = sp.getHours() * 60 + sp.getMinutes();
  return m < 377 ? "hoje às 06:17" : m < 1097 ? "hoje às 18:17" : "amanhã às 06:17";
}

function status(s) {
  if (!s) return "⚠️ Não consegui ler a situação do sistema agora.";
  const u = s.ultima || {}, ok = s.ultima_ok ? (Date.now() - new Date(s.ultima_ok)) / 36e5 : 999;
  const rodando = u.status === "rodando" && (Date.now() - new Date(u.inicio)) / 36e5 < 6;
  const saude = rodando ? "🔄 <b>Coletando agora</b>" : ok <= 14 && !s.erros_24h ? "✅ <b>Operando normalmente</b>" : ok <= 14 ? `🟡 <b>Operando, com ${s.erros_24h} erro(s) em 24 h</b>` : "🔴 <b>Sem coleta concluída há mais de 14 h</b>";
  return `${saude}
Última etapa: ${h(u.fonte)} · ${h(u.status)} · ${quando(u.fim || u.inicio)}${u.erro ? `\n<i>${h(u.erro)}</i>` : ""}
Próxima coleta: ${proxima()}

📊 Editais abertos: <b>${n(s.abertos)}</b>
🎯 No radar com score ≥ 80: <b>${n(s.radar_alto)}</b> · novos para analisar: <b>${n(s.radar_novo)}</b>
⏳ Do radar que encerram em 7 dias: <b>${n(s.encerram7)}</b>
🔔 Alertas nos últimos 7 dias: <b>${n(s.alertas_7d)}</b>${s.briefing ? `\n🧭 Último briefing: ${h(s.briefing.titulo)} (${quando(s.briefing.em)})` : ""}

Painel: ${PAINEL}`;
}

export async function onRequestPost({ request }) {
  const secret = request.headers.get("x-telegram-bot-api-secret-token") || "";
  let up; try { up = await request.json(); } catch { return new Response("ok"); }
  const msg = up.message || up.edited_message;
  if (!msg?.chat?.id || !msg.text) return new Response("ok");
  if (!(await rpc("tg_ok", { p_secret: secret }))) return new Response("ok");   // não veio do Telegram
  const chat = String(msg.chat.id), cmd = msg.text.trim().split(/[\s@]/)[0].toLowerCase();

  if (cmd === "/start") {
    const reg = await rpc("tg_registrar", { p_secret: secret, p_chat: chat });
    if (reg === "outro") return responder(chat, SOBRE + "\n\n🔒 Este bot é privado e já está vinculado a outra conta.");
    const s = await rpc("tg_status", { p_secret: secret });
    return responder(chat, SOBRE + `\n\n${reg === "registrado" ? "✅ <b>Este chat foi vinculado.</b> Os avisos chegarão aqui." : "✅ Este chat já está vinculado."}\n\n<b>Situação agora</b>\n` + status(s));
  }
  const reg = await rpc("tg_registrar", { p_secret: secret, p_chat: chat });
  if (reg === "outro") return responder(chat, "🔒 Bot privado.");
  if (cmd === "/status") return responder(chat, status(await rpc("tg_status", { p_secret: secret })));
  return responder(chat, SOBRE);
}

export const onRequestGet = () => new Response("SISLICITA bot: webhook ativo", { headers: { "content-type": "text/plain; charset=utf-8" } });
