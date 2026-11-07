// TEMPORARIO: so para medir se o Cloudflare consegue baixar documentos do PNCP. Remover depois do teste.
const SB = "https://tkbkkqebsxvmxnqiwjfl.supabase.co";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRrYmtrcWVic3h2bXhucWl3amZsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM5MDk1MjIsImV4cCI6MjEwOTQ4NTUyMn0.v--eJcYHEanBh9WG1xgOPZQgSHbwFHbCJXOQBBiXKjw";
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export async function onRequestGet({ request }) {
  const auth = request.headers.get("authorization") || "";
  const u = await fetch(`${SB}/auth/v1/user`, { headers: { authorization: auth, apikey: ANON } });
  if (!u.ok) return J({ erro: "não autenticado" }, 401);
  const q = new URL(request.url).searchParams;
  const cnpj = (q.get("cnpj") || "").replace(/\D/g, ""), ano = (q.get("ano") || "").replace(/\D/g, ""), seq = (q.get("seq") || "").replace(/\D/g, "");
  if (!cnpj || !ano || !seq) return J({ erro: "faltam cnpj, ano, seq" }, 400);
  const out = {};
  const lista = `https://pncp.gov.br/pncp-api/v1/orgaos/${cnpj}/compras/${ano}/${seq}/arquivos`;
  try {
    const r = await fetch(lista, { headers: { accept: "application/json", "user-agent": "sislicita" } });
    out.lista = { status: r.status, ct: r.headers.get("content-type") };
    if (r.ok) {
      const arqs = await r.json();
      out.arquivos = (arqs || []).slice(0, 3).map(a => ({ tipo: a.tipoDocumentoNome, titulo: a.titulo, url: a.url || a.uri }));
      const url = out.arquivos[0]?.url;
      if (url) {
        const d = await fetch(url, { headers: { "user-agent": "sislicita" } });
        const b = d.ok ? await d.arrayBuffer() : null;
        out.download = { status: d.status, ct: d.headers.get("content-type"), bytes: b ? b.byteLength : 0 };
      }
    } else out.corpo = (await r.text()).slice(0, 200);
  } catch (e) { out.erro = String(e.message || e).slice(0, 200); }
  return J(out);
}
