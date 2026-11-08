"""SISLICITA - coletor do PNCP para o Supabase.

Uso: python coletor.py [editais|pca|radar|tudo]
Variaveis: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (obrigatorias).
Opcionais: MODALIDADES, WORKERS, ANOS_PCA, MAX_PLANOS, PCA_PAGINA.
"""
import concurrent.futures as cf
import io
import json
import os
import re
import sys
import time
import unicodedata
import zipfile
from datetime import datetime, timedelta, timezone

import requests

PNCP = "https://pncp.gov.br/api"
SB = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1"
KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
HDR = {"apikey": KEY, "Authorization": "Bearer " + KEY, "Content-Type": "application/json"}
UA = {"User-Agent": "sislicita-coletor/1.0"}
UFS = "AC AL AM AP BA CE DF ES GO MA MG MS MT PA PB PE PI PR RJ RN RO RR RS SC SE SP TO".split()
MODALIDADES = os.getenv("MODALIDADES", "4,5,6,7,8,12").split(",")
WORKERS = int(os.getenv("WORKERS", "4"))
ANOS_PCA = os.getenv("ANOS_PCA", "2026,2027").split(",")
MAX_PLANOS = int(os.getenv("MAX_PLANOS", "1500"))
PCA_PAGINA = int(os.getenv("PCA_PAGINA", "100"))


def get(url, params=None, tentativas=7):
    """GET no PNCP com repeticao. Retorna JSON ou None (sem conteudo/parametro invalido)."""
    ult = "sem resposta"
    for i in range(tentativas):
        try:
            r = requests.get(url, params=params, headers=UA, timeout=90)
            if r.status_code == 200:
                return r.json()
            if r.status_code == 400:
                print(f"[get] 400 em {url} {params}: {r.text[:160]}", flush=True)
                return None
            if r.status_code in (204, 404):
                return None
            if r.status_code == 429:                       # limite de requisicoes do PNCP
                time.sleep(min(10 + i * 15, 60))
            ult = f"HTTP {r.status_code}: {r.text[:120]!r}"
        except (requests.RequestException, ValueError) as e:
            ult = f"{type(e).__name__}: {str(e)[:120]}"
        time.sleep(min(2 ** i, 30))
    raise RuntimeError(f"falha ao consultar {url} {params} -> {ult}")


def norm(s):
    s = unicodedata.normalize("NFD", (s or "").lower())
    return "".join(c for c in s if unicodedata.category(c) != "Mn")


def ts(s):
    """Datas do PNCP vem sem fuso: assume horario de Brasilia."""
    if not s:
        return None
    return s if re.search(r"(Z|[+-]\d\d:?\d\d)$", s) else s + "-03:00"


def upsert(tabela, rows, conflito):
    unicos = {}
    for r in rows:
        unicos[tuple(r[c] for c in conflito.split(","))] = r
    rows = list(unicos.values())
    for i in range(0, len(rows), 500):
        r = requests.post(
            f"{SB}/{tabela}",
            params={"on_conflict": conflito},
            headers={**HDR, "Prefer": "resolution=merge-duplicates,return=minimal"},
            data=json.dumps(rows[i:i + 500]),
            timeout=120,
        )
        if r.status_code >= 300:
            raise RuntimeError(f"{tabela}: {r.status_code} {r.text[:300]}")
    return len(rows)


def log_inicio(fonte):
    r = requests.post(f"{SB}/coletas_log", headers={**HDR, "Prefer": "return=representation"},
                      data=json.dumps({"fonte": fonte}), timeout=60)
    r.raise_for_status()
    return r.json()[0]["id"]


def log_fim(id_, n, status, erro=None):
    requests.patch(f"{SB}/coletas_log", params={"id": f"eq.{id_}"}, headers=HDR, timeout=60,
                   data=json.dumps({"finalizado_em": datetime.now(timezone.utc).isoformat(),
                                    "registros": n, "status": status, "erro": erro}))


# ---------------------------------------------------------------- editais
def parse_edital(c):
    u = c.get("unidadeOrgao") or {}
    o = c.get("orgaoEntidade") or {}
    vt = c.get("valorTotalEstimado")
    cnpj, ano, seq = o.get("cnpj"), c.get("anoCompra"), c.get("sequencialCompra")
    return {
        "numero_controle_pncp": c["numeroControlePNCP"],
        "orgao_cnpj": cnpj,
        "orgao_nome": o.get("razaoSocial"),
        "unidade_nome": u.get("nomeUnidade"),
        "esfera": o.get("esferaId"),
        "uf": u.get("ufSigla"),
        "municipio": u.get("municipioNome"),
        "codigo_ibge": str(u.get("codigoIbge") or ""),
        "modalidade": c.get("modalidadeNome"),
        "modo_disputa": c.get("modoDisputaNome"),
        "amparo_legal": (c.get("amparoLegal") or {}).get("nome"),
        "srp": c.get("srp"),
        "situacao": c.get("situacaoCompraNome"),
        "objeto": c.get("objetoCompra"),
        "valor_estimado": vt or None,
        "valor_sigiloso": not vt,
        "data_publicacao": (c.get("dataPublicacaoPncp") or "")[:10] or None,
        "data_inicio_proposta": ts(c.get("dataAberturaProposta")),
        "data_fim_proposta": ts(c.get("dataEncerramentoProposta")),
        "plataforma": c.get("usuarioNome"),
        "link_pncp": f"https://pncp.gov.br/app/editais/{cnpj}/{ano}/{seq}",
    }


AVISOS = []                    # (etapa, texto) de problemas parciais: aparecem no Telegram sem derrubar a coleta
FALHAS_EDITAIS = []            # (modalidade, uf, pagina) que o PNCP nao devolveu; repetidas no fim da etapa


def coletar_edital(modalidade, uf, pagina=1, anotar=True):
    """Pagina os editais abertos de uma modalidade/UF. Se o PNCP falhar, anota de onde retomar."""
    rows = []
    while True:
        try:
            j = get(f"{PNCP}/consulta/v1/contratacoes/proposta",
                    {"dataFinal": "20271231", "codigoModalidadeContratacao": modalidade, "uf": uf,
                     "pagina": pagina, "tamanhoPagina": 50})
        except RuntimeError as e:
            print(f"[editais] AVISO modalidade={modalidade} uf={uf} pag={pagina}: {e}", file=sys.stderr)
            if anotar:
                FALHAS_EDITAIS.append((modalidade, uf, pagina))
            break
        if not j or not j.get("data"):
            break
        rows += [parse_edital(c) for c in j["data"]]
        if pagina >= (j.get("totalPaginas") or 1):
            break
        pagina += 1
    return rows


def editais():
    FALHAS_EDITAIS.clear()
    tarefas = [(m, u) for m in MODALIDADES for u in UFS]
    total = 0
    with cf.ThreadPoolExecutor(WORKERS) as ex:
        for rows in ex.map(lambda t: coletar_edital(*t), tarefas):
            if rows:
                total += upsert("oportunidades", rows, "numero_controle_pncp")
    # O PNCP recusa consultas de vez em quando (429/5xx). Retoma as que falharam, devagar e em serie.
    pendentes = list(FALHAS_EDITAIS)
    FALHAS_EDITAIS.clear()
    if pendentes:
        print(f"[editais] repetindo {len(pendentes)} consulta(s) que o PNCP recusou", flush=True)
        time.sleep(60)
        for m, uf, pag in pendentes:
            rows = coletar_edital(m, uf, pag)
            if rows:
                total += upsert("oportunidades", rows, "numero_controle_pncp")
            time.sleep(3)
    if FALHAS_EDITAIS:
        faltou = ", ".join(f"{u}/mod {m}" for m, u, _ in FALHAS_EDITAIS[:6])
        aviso = (f"{len(FALHAS_EDITAIS)} consulta(s) o PNCP nao devolveu nem na 2a tentativa "
                 f"({faltou}{'...' if len(FALHAS_EDITAIS) > 6 else ''}) - entram na proxima coleta")
        print(f"[editais] AVISO {aviso}", file=sys.stderr)
        AVISOS.append(("editais", aviso))
        if not total:            # nada coletado: ai sim a etapa falhou de verdade
            raise RuntimeError(aviso)
    return total


# ---------------------------------------------------------------- historico de editais (ja encerrados)
HIST_DIAS = int(os.getenv("HIST_DIAS", "180"))               # ate onde voltar (dias)
HIST_ORCAMENTO_MIN = os.getenv("HIST_ORCAMENTO_MIN", "")      # minutos; vazio = 110 se for so o historico, 40 dentro de outra coleta
MODO_SOLO = False                                             # True quando a execucao e so "historico" (definido no main)
HIST_RESULT = {"dias": 0, "completo": False}                  # lido no fim da execucao para encadear/avisar
HIST_PAR = int(os.getenv("HIST_PAR", "3"))                   # paginas em paralelo (acima disso o PNCP devolve 429)


def coletar_dia(s):
    """Todos os editais (das modalidades configuradas) publicados no dia s (AAAAMMDD)."""
    rows = []
    for m in MODALIDADES:
        lista = paginas(f"{PNCP}/consulta/v1/contratacoes/publicacao",
                        {"dataInicial": s, "dataFinal": s, "codigoModalidadeContratacao": m}, 50, HIST_PAR)
        rows += [parse_edital(c) for c in lista if c.get("numeroControlePNCP")]
    return rows


def historico():
    """Preenche o banco com editais publicados no passado, ja encerrados ou nao.

    A etapa 'editais' so ve o que esta recebendo proposta agora, entao nada anterior a primeira
    coleta existe no banco. Esta etapa anda de tras para a frente, dia a dia, por data de publicacao,
    guarda onde parou em coleta_estado e retoma na proxima execucao."""
    inicio = time.monotonic()
    orcamento = int(HIST_ORCAMENTO_MIN) if HIST_ORCAMENTO_MIN != "" else (110 if MODO_SOLO else 40)
    hoje = datetime.now(timezone.utc).date()
    limite = hoje - timedelta(days=HIST_DIAS)
    mn = estado("historico_min")
    d = (datetime.strptime(mn, "%Y%m%d").date() - timedelta(days=1)) if mn else hoje
    total, dias_feitos = 0, 0
    while d >= limite:
        if dias_feitos and (time.monotonic() - inicio) / 60 > orcamento:   # sempre grava ao menos 1 dia por rodada
            print(f"[historico] orcamento de {orcamento} min atingido; retoma em {d:%Y-%m-%d}", flush=True)
            break
        s = d.strftime("%Y%m%d")
        rows, erro = None, None
        for tent in range(3):            # o PNCP limita (429) e oscila (503): espera e tenta o mesmo dia de novo
            try:
                rows = coletar_dia(s)
                break
            except RuntimeError as e:
                erro = e
                if tent < 2 and (time.monotonic() - inicio) / 60 < orcamento + 15:
                    print(f"[historico] {s}: PNCP recusou ({str(e)[-90:]}); aguardo 5 min e tento o dia de novo", flush=True)
                    time.sleep(300)
        if rows is None:
            print(f"[historico] AVISO {s}: {erro}; paro aqui e retomo nesta data na proxima execucao", file=sys.stderr, flush=True)
            break
        if rows:
            total += upsert("oportunidades", rows, "numero_controle_pncp")
        estado("historico_min", s)           # so avanca depois que o dia inteiro foi gravado
        dias_feitos += 1
        print(f"[historico] {s}: {len(rows)} editais", flush=True)
        d -= timedelta(days=1)
    else:
        HIST_RESULT["completo"] = True
        print(f"[historico] concluido ate {limite:%Y-%m-%d}", flush=True)
    HIST_RESULT["dias"] = dias_feitos
    print(f"[historico] {dias_feitos} dia(s), {total} editais nesta execucao", flush=True)
    return total



# ------------------------------------------------------------------ filtro v2: vetores e triagem
EMB_MODELO = os.getenv("EMB_MODELO", "gemini-embedding-001")
EMB_DIM = 768
VET_MAX = int(os.getenv("VET_MAX", "40000"))        # editais vetorizados por execucao
VET_MIN = float(os.getenv("VET_MIN", "45"))          # minutos de orcamento por execucao
VET_LOTE = 100
VET_PCA_MAX = int(os.getenv("VET_PCA_MAX", "15000"))  # itens de PCA por execucao (carga inicial sao ~80 mil)
VET_PAUSA = float(os.getenv("VET_PAUSA", "0.4"))        # pausa entre lotes do PCA, em segundos


def _norm(v):
    m = sum(x * x for x in v) ** 0.5 or 1.0
    return [x / m for x in v]


def vetorizar(textos, tarefa="RETRIEVAL_DOCUMENT"):
    """Vetores normalizados (768) para uma lista de textos, em um lote."""
    url = f"{GEM}/models/{EMB_MODELO}:batchEmbedContents"
    corpo = {"requests": [{"model": f"models/{EMB_MODELO}", "content": {"parts": [{"text": t[:6000]}]},
                           "taskType": tarefa, "outputDimensionality": EMB_DIM} for t in textos]}
    for espera in (0, 20, 60, 120, 240):
        time.sleep(espera)
        _uso(EMB_MODELO, "chamadas")
        try:
            r = requests.post(url, headers={"x-goog-api-key": GKEY, "Content-Type": "application/json"},
                              data=json.dumps(corpo), timeout=120)
        except requests.RequestException as e:
            _uso(EMB_MODELO, "falhas")
            print(f"[vetores] {type(e).__name__}, aguardando...", flush=True)
            continue
        if r.status_code == 429 or r.status_code >= 500:
            _uso(EMB_MODELO, "limite" if r.status_code == 429 else "falhas")
            print(f"[vetores] HTTP {r.status_code}: {r.text[:160]}", flush=True)
            continue
        if r.status_code >= 300:
            _uso(EMB_MODELO, "falhas")
            raise RuntimeError(f"embedding {r.status_code}: {r.text[:300]}")
        _uso(EMB_MODELO, "ok")
        _uso(EMB_MODELO, "tokens_in", sum(len(t) for t in textos) // 4)
        return [_norm(e["values"]) for e in r.json()["embeddings"]]
    raise RuntimeError("embedding: limite do Gemini esgotado (429) - continua na proxima execucao")


def _vetorizar_fonte(rpc, tabela, coluna, rotulo, inicio, total, teto=None, pausa=0.0):
    """Vetoriza o que a RPC listar como pendente, respeitando o orcamento de tempo/quantidade."""
    teto = min(VET_MAX, teto) if teto else VET_MAX
    while total < teto and (time.monotonic() - inicio) / 60 < VET_MIN:
        r = requests.post(f"{SB}/rpc/{rpc}", headers=HDR, data=json.dumps({"p_limite": 1000}), timeout=120)
        if r.status_code >= 300:
            raise RuntimeError(f"{rpc}: {r.status_code} {r.text[:200]}")
        pend = r.json()
        if not pend:
            break
        for i in range(0, len(pend), VET_LOTE):
            lote = pend[i:i + VET_LOTE]
            vs = vetorizar([x["texto"] for x in lote])
            rows = [{coluna: x["id"], "emb": "[" + ",".join(f"{v:.5f}" for v in vec) + "]"} for x, vec in zip(lote, vs)]
            upsert(tabela, rows, coluna)
            total += len(rows)
            if pausa:
                time.sleep(pausa)      # deixa o disco do banco respirar entre os lotes
            if total >= teto or (time.monotonic() - inicio) / 60 >= VET_MIN:
                break
        print(f"[vetores] {total} vetorizados ate agora (ultima fonte: {rotulo})", flush=True)
    return total


def vetores():
    """Vetor de significado dos editais abertos e, com o tempo que sobrar, dos itens futuros do PCA.

    O PCA tem um teto menor por execucao (VET_PCA_MAX): sao 80 mil itens de uma vez so na primeira
    carga, e gravar tudo de uma vez esgota o orcamento de disco do Supabase. Depois da carga inicial
    sobram poucos itens novos por dia, bem abaixo do teto, entao nao ha nada para desfazer.
    """
    inicio = time.monotonic()
    total = _vetorizar_fonte("pendentes_vetor", "edital_emb", "oportunidade_id", "editais", inicio, 0)
    total = _vetorizar_fonte("pendentes_vetor_pca", "pca_emb", "pca_item_id", "PCA", inicio, total,
                             teto=total + VET_PCA_MAX, pausa=VET_PAUSA)
    return total


def triagem():
    """Da nota a todos os editais abertos para cada perfil ativo (filtro v2) e atualiza o radar.
    Um perfil por chamada: cada RPC roda em transacao propria (a tabela temporaria _tri nao pode
    ser recriada dentro da mesma transacao, o que quebrava com 2+ perfis em triar_todos)."""
    pr = requests.get(f"{SB}/perfis_busca", headers=HDR, timeout=60,
                      params={"select": "id,nome,emb_desc", "ativo": "eq.true", "emb_desc": "not.is.null"})
    pr.raise_for_status()
    total, erros = 0, []
    for p in pr.json():
        try:
            for rpc, obrigatorio in (("triar_perfil", True), ("triar_pca", False), ("radar_v2", True)):
                r = requests.post(f"{SB}/rpc/{rpc}", headers=HDR, data=json.dumps({"p_id": p["id"]}), timeout=900)
                if r.status_code >= 300:
                    if obrigatorio:
                        raise RuntimeError(f"{rpc}: {r.status_code} {r.text[:200]}")
                    print(f"[triagem] {p['nome']}: {rpc} ignorado ({r.status_code})", flush=True)
                    continue
                if rpc == "radar_v2":
                    n = r.json()
                    total += int(n) if isinstance(n, (int, float)) else 0
                    print(f"[triagem] {p['nome']}: {n} no radar", flush=True)
        except Exception as e:
            erros.append(f"{p['nome']}: {e}")
            print(f"[triagem] erro em {p['nome']}: {e}", flush=True)
    if erros:
        raise RuntimeError("triagem: " + " | ".join(erros)[:400])
    return total

# ------------------------------------------------------------------ cobertura
COB_DIAS = int(os.getenv("COB_DIAS", "14"))
COB_MINIMO = float(os.getenv("COB_MINIMO", "0.98"))


def contar_banco(iso):
    r = requests.get(f"{SB}/oportunidades", timeout=120, params={"data_publicacao": "eq." + iso, "select": "id"},
                     headers={**HDR, "Prefer": "count=exact", "Range-Unit": "items", "Range": "0-0"})
    r.raise_for_status()
    return int(r.headers.get("content-range", "0-0/0").split("/")[-1] or 0)


def total_pncp(s):
    """Quantos editais o PNCP diz ter publicado no dia (soma das modalidades coletadas)."""
    t = 0
    for m in MODALIDADES:
        j = get(f"{PNCP}/consulta/v1/contratacoes/publicacao",
                {"dataInicial": s, "dataFinal": s, "codigoModalidadeContratacao": m, "pagina": 1, "tamanhoPagina": 50})
        t += int((j or {}).get("totalRegistros") or 0)
    return t


def cobertura():
    """Compara, dia a dia, o que o PNCP publicou com o que esta no banco; refaz o dia que estiver abaixo do minimo."""
    hoje = datetime.now(timezone.utc).date()
    dias, refeitos = [], 0
    for k in range(1, COB_DIAS + 1):
        d = hoje - timedelta(days=k)
        s, iso = d.strftime("%Y%m%d"), d.isoformat()
        item = {"dia": iso}
        try:
            pncp, banco = total_pncp(s), contar_banco(iso)
            item.update(pncp=pncp, banco=banco)
            if pncp and banco < pncp * COB_MINIMO:
                print(f"[cobertura] {iso}: banco {banco} de {pncp} no PNCP; refazendo o dia", flush=True)
                rows = coletar_dia(s)
                if rows:
                    upsert("oportunidades", rows, "numero_controle_pncp")
                item.update(banco=contar_banco(iso), refeito=True, antes=banco)
                refeitos += 1
        except RuntimeError as e:
            item["erro"] = str(e)[:160]
            print(f"[cobertura] AVISO {iso}: {e}", file=sys.stderr, flush=True)
        dias.append(item)
        print(f"[cobertura] {iso}: {item.get('banco')} de {item.get('pncp')}", flush=True)
    estado("cobertura", json.dumps({"em": datetime.now(timezone.utc).isoformat(), "dias": dias}))
    return refeitos


# -------------------------------------------------------------------- PCA
def listar_planos(ano, esfera):
    pagina = 1
    while True:
        j = get(f"{PNCP}/search/", {"tipos_documento": "pcaorgao", "pagina": pagina, "tam_pagina": 100,
                                    "anos": ano, "esferas": esfera, "ordenacao": "-data"})
        itens = (j or {}).get("items") or []
        if not itens:
            return
        yield from itens
        if pagina * 100 >= min(j.get("total", 0), 10000):
            return
        pagina += 1
        time.sleep(0.5)


def planos():
    total = 0
    for ano in ANOS_PCA:
        for esfera in "MEFDN":
            rows = []
            try:
                for it in listar_planos(ano, esfera):
                    rows.append({
                        "orgao_cnpj": it["orgao_cnpj"], "ano": int(it["ano"]),
                        "orgao_nome": it.get("orgao_nome"), "esfera": it.get("esfera_nome"),
                        "poder": it.get("poder_nome"),
                        "valor_total": it.get("valor_global"),
                        "data_atualizacao": ts(it.get("data_atualizacao_pncp")),
                    })
            except RuntimeError as e:
                print(f"[pca] AVISO ano={ano} esfera={esfera}: lista parcial ({len(rows)} planos): {e}",
                      file=sys.stderr)
            if rows:
                total += upsert("pca_planos", rows, "orgao_cnpj,ano")
    return total


MAX_UF_PCA = int(os.getenv("MAX_UF_PCA", "250"))
def preencher_uf_pca():
    """A busca de PCA do PNCP nao traz UF. 1) deduz pelo CNPJ nos editais ja coletados; 2) o resto vem da BrasilAPI."""
    r = requests.post(f"{SB}/rpc/preencher_uf_pca", headers=HDR, data="{}", timeout=600)
    if r.status_code >= 300:
        raise RuntimeError(f"preencher_uf_pca: {r.status_code} {r.text[:200]}")
    por_edital = r.json()
    r = requests.get(f"{SB}/pca_planos", headers=HDR, timeout=120, params={
        "select": "id,orgao_cnpj", "uf": "is.null", "order": "valor_total.desc.nullslast", "limit": str(MAX_UF_PCA)})
    r.raise_for_status()
    feitos = 0
    for p in r.json():
        b = None
        for espera in (0, 5, 20):
            time.sleep(espera)
            try:
                b = requests.get(f"https://brasilapi.com.br/api/cnpj/v1/{p['orgao_cnpj']}", headers=UA, timeout=40)
            except requests.RequestException:
                continue
            if b.status_code != 429:
                break
        if b is not None and b.status_code == 200 and b.json().get("uf"):
            requests.patch(f"{SB}/pca_planos", params={"orgao_cnpj": f"eq.{p['orgao_cnpj']}", "uf": "is.null"}, headers=HDR,
                           timeout=60, data=json.dumps({"uf": b.json()["uf"]}))
            feitos += 1
        time.sleep(0.6)
    print(f"[pca] UF preenchida: {por_edital} planos pelos editais, {feitos} pela BrasilAPI", flush=True)


PCA_VALOR_MIN = float(os.getenv("PCA_VALOR_MIN", "30000"))


def processar_plano(plano):
    """Le todos os itens do plano. Guarda um resumo por (classificacao, categoria, mes) e,
    como detalhe, so os itens de valor alto (>= PCA_VALOR_MIN)."""
    cnpj, ano = plano["orgao_cnpj"], plano["ano"]
    base = f"{PNCP}/pncp/v1/orgaos/{cnpj}/pca/{ano}"
    sequenciais, pagina = set(), 1
    while True:
        un = get(f"{base}/consolidado/unidades", {"pagina": pagina, "tamanhoPagina": 100}) or []
        sequenciais |= {u["sequencialPca"] for u in un}
        if len(un) < 100:
            break
        pagina += 1
    itens, agg = [], {}
    for seq in sorted(sequenciais):
        pagina = 1
        while True:
            lote = get(f"{base}/{seq}/itens", {"pagina": pagina, "tamanhoPagina": PCA_PAGINA}) or []
            for it in lote:
                valor = float(it.get("valorTotal") or 0)
                dd = str(it.get("dataDesejada") or "")
                mes = dd[:7] + "-01" if len(dd) >= 7 else "1900-01-01"
                cod = str(it.get("classificacaoSuperiorCodigo") or "")
                cat = str(it.get("categoriaItemPcaNome") or "")
                a = agg.setdefault((cod, cat, mes), {
                    "plano_id": plano["id"], "classificacao_codigo": cod, "categoria": cat, "mes": mes,
                    "classificacao_nome": it.get("classificacaoSuperiorNome"),
                    "grupo_contratacao": it.get("grupoContratacaoNome"), "n_itens": 0, "valor_total": 0.0})
                a["n_itens"] += 1
                a["valor_total"] += valor
                if valor >= PCA_VALOR_MIN:
                    itens.append({
                        "plano_id": plano["id"], "sequencial_pca": seq, "numero_item": it.get("numeroItem"),
                        "descricao": it.get("descricao"), "categoria": it.get("categoriaItemPcaNome"),
                        "unidade_medida": it.get("unidadeFornecimento"), "quantidade": it.get("quantidade"),
                        "valor_unitario": it.get("valorUnitario"), "valor_total": it.get("valorTotal"),
                        "data_desejada": dd[:10] or None, "codigo_unidade": it.get("codigoUnidade"),
                        "nome_unidade": it.get("nomeUnidade"),
                        "classificacao_codigo": it.get("classificacaoSuperiorCodigo"),
                        "classificacao_nome": it.get("classificacaoSuperiorNome"),
                        "grupo_contratacao": it.get("grupoContratacaoNome"),
                    })
            if len(lote) < PCA_PAGINA:
                break
            pagina += 1
    return plano, itens, list(agg.values())


def processar_seguro(plano):
    try:
        return processar_plano(plano)
    except RuntimeError as e:
        print(f"[pca] AVISO plano {plano['orgao_cnpj']}/{plano['ano']}: {e}", file=sys.stderr)
        return plano, None, None


def apagar(tabela, plano_id):
    r = requests.delete(f"{SB}/{tabela}", params={"plano_id": f"eq.{plano_id}"}, headers=HDR, timeout=90)
    if r.status_code >= 300:
        raise RuntimeError(f"{tabela}: {r.status_code} {r.text[:200]}")


def pca():
    n = planos()
    try:
        preencher_uf_pca()
    except Exception as e:
        AVISOS.append(("pca", f"UF dos orgaos nao preenchida ({str(e)[:120]})"))
    r = requests.get(f"{SB}/pca_planos", headers=HDR, timeout=120, params={
        "select": "id,orgao_cnpj,ano,data_atualizacao,itens_coletados_em",
        "ano": "in.(" + ",".join(ANOS_PCA) + ")", "order": "data_atualizacao.desc", "limit": 10000})
    r.raise_for_status()
    pendentes = [p for p in r.json()
                 if not p["itens_coletados_em"]
                 or (p["data_atualizacao"] and p["itens_coletados_em"] < p["data_atualizacao"])][:MAX_PLANOS]
    print(f"{n} planos listados; {len(pendentes)} para ler os itens")
    total = 0
    with cf.ThreadPoolExecutor(WORKERS) as ex:
        for plano, itens, demanda in ex.map(processar_seguro, pendentes):
            if itens is None:
                continue  # falhou: fica pendente para a proxima coleta
            apagar("pca_demanda", plano["id"])
            apagar("pca_itens", plano["id"])
            if demanda:
                upsert("pca_demanda", demanda, "plano_id,classificacao_codigo,categoria,mes")
            if itens:
                total += upsert("pca_itens", itens, "plano_id,sequencial_pca,numero_item")
            requests.patch(f"{SB}/pca_planos", params={"id": f"eq.{plano['id']}"}, headers=HDR, timeout=60,
                           data=json.dumps({"itens_coletados_em": datetime.now(timezone.utc).isoformat()}))
    return total


# ------------------------------------------------------------------ radar
def interesse():
    """Recalcula o score de interesse (aderencia + retorno + margem + risco + prazo)."""
    r = requests.post(f"{SB}/rpc/calcular_interesse", headers=HDR, timeout=600, data=json.dumps({"p_limite": 20000}))
    if r.status_code >= 300:
        raise RuntimeError(f"calcular_interesse: {r.status_code} {r.text[:200]}")
    n = r.json()
    print(f"[interesse] {n} linhas recalculadas", flush=True)
    return n


def radar():
    r = requests.post(f"{SB}/rpc/atualizar_radar", headers=HDR, data="{}", timeout=600)
    if r.status_code >= 300:
        raise RuntimeError(f"radar: {r.status_code} {r.text[:300]}")
    r = requests.post(f"{SB}/rpc/limpar_antigos", headers=HDR, data="{}", timeout=300)
    if r.status_code >= 300:
        raise RuntimeError(f"limpar_antigos: {r.status_code} {r.text[:300]}")
    print(f"[radar] editais antigos removidos: {r.text}")
    return 0


# ------------------------------------------------------------------ catalogo (CATMAT/CATSER)
CAT = "https://dadosabertos.compras.gov.br"


def catalogo():
    """Carrega PDMs de materiais e servicos do catalogo do Compras.gov.br (para a pesquisa de precos)."""
    total = 0
    pag = 1
    while True:
        j = get(f"{CAT}/modulo-material/3_consultarPdmMaterial",
                {"pagina": pag, "tamanhoPagina": 500, "statusPdm": "true"})
        rows = [{"tipo": "M", "codigo": r["codigoPdm"], "nome": r.get("nomePdm"), "grupo": r.get("nomeGrupo"),
                 "classe": r.get("nomeClasse")} for r in j.get("resultado", [])]
        if rows:
            total += upsert("catalogo", rows, "tipo,codigo")
        if pag >= (j.get("totalPaginas") or 1):
            break
        pag += 1
        time.sleep(0.3)
    pag = 1
    while True:
        j = get(f"{CAT}/modulo-servico/6_consultarItemServico",
                {"pagina": pag, "tamanhoPagina": 500, "statusServico": "true"})
        rows = [{"tipo": "S", "codigo": r["codigoServico"], "nome": r.get("nomeServico"), "grupo": r.get("nomeGrupo"),
                 "classe": r.get("nomeClasse")} for r in j.get("resultado", [])]
        if rows:
            total += upsert("catalogo", rows, "tipo,codigo")
        if pag >= (j.get("totalPaginas") or 1):
            break
        pag += 1
        time.sleep(0.3)
    return total


# ------------------------------------------------------------------ ia (Gemini)
GEM = "https://generativelanguage.googleapis.com/v1beta"
GKEY = os.getenv("GEMINI_API_KEY", "")
GMODEL = os.getenv("GEMINI_MODEL", "gemini-3.1-flash-lite")
MAX_IA = int(os.getenv("MAX_IA", "300"))
LOTE_IA = int(os.getenv("LOTE_IA", "15"))
PAUSA_IA = float(os.getenv("PAUSA_IA", "7"))   # so usado se RPM_IA for 0
RPM_IA = int(os.getenv("RPM_IA", "12"))        # teto de chamadas por minuto (free tier do Gemini: ~15)
_ult_ia = [0.0]


def ritmo():
    """Espera so o que falta para respeitar RPM_IA. A chamada da IA ja consome a maior
    parte do intervalo, entao normalmente nao dorme nada."""
    if RPM_IA <= 0:
        time.sleep(PAUSA_IA)
        return
    intervalo = 60.0 / RPM_IA
    falta = intervalo - (time.monotonic() - _ult_ia[0])
    if falta > 0:
        time.sleep(falta)
    _ult_ia[0] = time.monotonic()

PROMPT_IA = """Voce analisa objetos de licitacoes publicas brasileiras para uma consultoria que assessora empresas fornecedoras.
Para CADA item abaixo devolva um objeto JSON com:
- id: o mesmo id recebido
- tipo: "M" (fornecimento de material/bem), "S" (servico comum) ou "O" (obra, engenharia ou outro)
- categoria: area em 1 a 3 palavras (ex.: alimentos, informatica, limpeza, saude, veiculos)
- termo_catalogo: nome do principal item ou servico, o MAIS ESPECIFICO possivel, como aparece em catalogos de compras (ex.: CARNE BOVINA, CADEIRA ESCRITORIO, SERVICO DE LIMPEZA; nunca termos amplos como GENEROS ALIMENTICIOS ou MATERIAL DE CONSTRUCAO); vazio se nao der para identificar
- generico: true se o objeto reune muitos itens diferentes (cesta basica, generos alimenticios variados, material de construcao diversos, merenda, kits) e portanto nao tem um item unico de catalogo; senao false
- resumo: no maximo 2 frases simples dizendo o que o orgao quer comprar, sem inventar nada que nao esteja no texto
- atencao: ponto de atencao para um fornecedor que seja visivel no texto (ex.: registro de precos, credenciamento, exige amostra, lote unico) ou vazio
Responda SOMENTE com um array JSON, sem texto extra.

ITENS:
"""


USO_IA = {}          # (fase, modelo) -> contadores; gravado em ia_uso ao fim de cada etapa
FASE_ATUAL = ""


def _uso(modelo, campo, n=1):
    d = USO_IA.setdefault((FASE_ATUAL, modelo), {"chamadas": 0, "ok": 0, "limite": 0, "falhas": 0, "tokens_in": 0, "tokens_out": 0})
    d[campo] += n


def gravar_uso():
    """Grava o consumo de Gemini da etapa que acabou (melhor esforco: nunca derruba a coleta)."""
    global USO_IA
    linhas = [{"fase": f, "modelo": m, **d} for (f, m), d in USO_IA.items() if d["chamadas"]]
    USO_IA = {}
    if not linhas:
        return
    try:
        requests.post(f"{SB}/ia_uso", headers={**HDR, "Prefer": "return=minimal"}, data=json.dumps(linhas), timeout=60)
    except Exception as e:
        print(f"[ia] aviso: nao gravei o uso do Gemini: {e}", flush=True)


def gemini(prompt, modelo):
    url = f"{GEM}/models/{modelo}:generateContent"
    corpo = {"contents": [{"parts": [{"text": prompt}]}],
             "generationConfig": {"temperature": 0.1, "responseMimeType": "application/json"}}
    for espera in (0, 30, 60, 120):
        time.sleep(espera)
        _uso(modelo, "chamadas")
        try:
            r = requests.post(url, headers={"x-goog-api-key": GKEY, "Content-Type": "application/json"},
                              data=json.dumps(corpo), timeout=120)
        except requests.RequestException as e:      # timeout/queda de conexao: tenta de novo, nao derruba a etapa
            _uso(modelo, "falhas")
            print(f"[ia] {type(e).__name__}, aguardando...", flush=True)
            continue
        if r.status_code == 429 or r.status_code >= 500:
            _uso(modelo, "limite" if r.status_code == 429 else "falhas")
            print(f"[ia] HTTP {r.status_code}, aguardando...", flush=True)
            continue
        if r.status_code >= 300:
            _uso(modelo, "falhas")
            raise RuntimeError(f"gemini {r.status_code}: {r.text[:300]}")
        j = r.json()
        um = j.get("usageMetadata") or {}
        _uso(modelo, "tokens_in", int(um.get("promptTokenCount") or 0))
        _uso(modelo, "tokens_out", int(um.get("candidatesTokenCount") or 0))
        try:
            res = json.loads(j["candidates"][0]["content"]["parts"][0]["text"])
        except Exception:
            _uso(modelo, "falhas")
            raise RuntimeError("gemini: resposta fora do formato: " + json.dumps(j)[:300])
        _uso(modelo, "ok")
        return res
    return None  # limite esgotado


def escolher_modelo():
    r = requests.get(f"{GEM}/models", headers={"x-goog-api-key": GKEY}, params={"pageSize": 200}, timeout=60)
    if r.status_code >= 300:
        raise RuntimeError(f"gemini models {r.status_code}: {r.text[:200]}")
    nomes = [m["name"].split("/")[-1] for m in r.json().get("models", [])
             if "generateContent" in m.get("supportedGenerationMethods", []) and "flash-lite" in m["name"]
             and "preview" not in m["name"] and "tts" not in m["name"]]
    if not nomes:
        raise RuntimeError("nenhum modelo flash-lite encontrado para a chave")
    return sorted(nomes)[-1]


def gemini_auto(prompt):
    global GMODEL
    try:
        return gemini(prompt, GMODEL)
    except RuntimeError as e:
        if " 404" in str(e):
            GMODEL = escolher_modelo()
            print(f"[ia] modelo padrao indisponivel; usando {GMODEL}", flush=True)
            return gemini(prompt, GMODEL)
        raise


def candidatos_catalogo(tipo, termo):
    palavras = [w for w in re.sub(r"[^A-Z0-9 ]", " ", norm(termo or "").upper()).split() if len(w) > 2][:4]
    for n in range(len(palavras), 0, -1):
        filtros = [("nome_busca", "ilike.*" + w + "*") for w in palavras[:n]]
        r = requests.get(f"{SB}/catalogo", headers=HDR, timeout=60,
                         params=[("select", "codigo,nome"), ("tipo", "eq." + tipo), ("limit", "40")] + filtros)
        if r.status_code < 300 and r.json():
            return sorted(r.json(), key=lambda x: len(x["nome"]))[:12]
    return []


PROMPT_ESC = """Para cada licitacao abaixo escolha, entre as opcoes do catalogo de compras, o item que representa o objeto principal.
Se nenhuma opcao representar bem o objeto (item amplo demais, produto diferente ou apenas parte do objeto), responda codigo 0.
Responda SOMENTE com um array JSON de objetos {"id": ..., "codigo": ...}.

LICITACOES:
"""


def escolher_catalogo(itens):
    """itens: lista de (oportunidade, candidatos). Devolve {id: candidato escolhido}."""
    linhas = []
    for o, cands in itens:
        ops = " | ".join(f"{c['codigo']}={c['nome']}" for c in cands)
        linhas.append(f"[{o['id']}] OBJETO: {(o['objeto'] or '')[:300]}\n   OPCOES: {ops}")
    res = gemini_auto(PROMPT_ESC + "\n".join(linhas))
    escolhidos = {}
    if not res:
        return escolhidos
    por_cod = {o["id"]: {str(c["codigo"]): c for c in cands} for o, cands in itens}
    for x in res:
        if not isinstance(x, dict):
            continue
        try:
            oid = int(x.get("id"))
        except (TypeError, ValueError):
            continue
        c = por_cod.get(oid, {}).get(str(x.get("codigo")))
        if c:
            escolhidos[oid] = c
    return escolhidos


def ia():
    if not GKEY:
        raise RuntimeError("GEMINI_API_KEY nao configurada")
    r = requests.get(f"{SB}/radar", headers=HDR, timeout=120, params={
        "select": "oportunidade_id,oportunidades(id,objeto,ia_processado_em,data_fim_proposta)",
        "oportunidade_id": "not.is.null", "limit": "5000"})
    r.raise_for_status()
    agora = datetime.now(timezone.utc).isoformat()
    vistos, fila = set(), []
    for x in r.json():
        o = x.get("oportunidades")
        if o and o["id"] not in vistos and not o.get("ia_processado_em") and (o.get("data_fim_proposta") or "") >= agora:
            vistos.add(o["id"])
            fila.append(o)
    print(f"[ia] pendentes no radar: {len(fila)}; processando ate {MAX_IA}", flush=True)
    fila = fila[:MAX_IA]
    feitos = 0
    for i in range(0, len(fila), LOTE_IA):
        lote = fila[i:i + LOTE_IA]
        texto = PROMPT_IA + "\n".join(f"[{o['id']}] {(o['objeto'] or '')[:700]}" for o in lote)
        res = gemini_auto(texto)
        if res is None:
            print("[ia] limite de uso atingido; encerrando por hoje", flush=True)
            break
        por_id = {str(x.get("id")): x for x in res if isinstance(x, dict)}
        info, para_escolher = {}, []
        for o in lote:
            x = por_id.get(str(o["id"]))
            if not x:
                continue
            tipo = x.get("tipo") if x.get("tipo") in ("M", "S", "O") else "O"
            generico = bool(x.get("generico"))
            info[o["id"]] = (x, tipo, generico)
            if tipo in ("M", "S") and not generico and x.get("termo_catalogo"):
                cands = candidatos_catalogo(tipo, x.get("termo_catalogo"))
                if cands:
                    para_escolher.append((o, cands))
        escolhidos = escolher_catalogo(para_escolher) if para_escolher else {}
        for o in lote:
            if o["id"] not in info:
                continue
            x, tipo, generico = info[o["id"]]
            cat = escolhidos.get(o["id"])
            patch = {"ia_categoria": (x.get("categoria") or "")[:60], "ia_resumo": (x.get("resumo") or "")[:600],
                     "ia_tipo": tipo, "ia_termo": (x.get("termo_catalogo") or "")[:120],
                     "ia_atencao": (x.get("atencao") or "")[:300], "ia_generico": generico,
                     "ia_catalogo_codigo": cat["codigo"] if cat else None,
                     "ia_catalogo_nome": cat["nome"] if cat else None,
                     "ia_processado_em": agora}
            rr = requests.patch(f"{SB}/oportunidades", headers={**HDR, "Prefer": "return=minimal"},
                                params={"id": "eq." + str(o["id"])}, data=json.dumps(patch), timeout=60)
            if rr.status_code >= 300:
                raise RuntimeError(f"ia patch: {rr.status_code} {rr.text[:200]}")
            feitos += 1
        print(f"[ia] {feitos}/{len(fila)} (modelo {GMODEL})", flush=True)
        ritmo()
    return feitos


# ------------------------------------------------------------------ radar_ia (perfis com prompt)
MAX_RADAR_IA = int(os.getenv("MAX_RADAR_IA", "200"))
LOTE_RIA = int(os.getenv("LOTE_RIA", "20"))

PROMPT_RIA = """Voce e analista de licitacoes publicas brasileiras. Uma consultoria procura oportunidades para este perfil:

PERFIL: {perfil}

Para CADA licitacao abaixo avalie a aderencia ao perfil de 0 a 100 (0 = nada a ver, 50 = possivel, 80 ou mais = encaixa bem) e justifique em uma frase curta (ate 140 caracteres), baseada somente no texto.
Responda SOMENTE com um array JSON de objetos {"id": ..., "score": ..., "justificativa": ...}.

LICITACOES:
"""


def radar_ia():
    if not GKEY:
        raise RuntimeError("GEMINI_API_KEY nao configurada")
    r = requests.get(f"{SB}/perfis_busca", headers=HDR, timeout=60, params={"select": "*", "ativo": "eq.true"})
    r.raise_for_status()
    perfis = [p for p in r.json() if (p.get("prompt") or "").strip() and "edital" in (p.get("fontes") or ["edital"])]
    restante, total = MAX_RADAR_IA, 0
    agora = datetime.now(timezone.utc)
    for p in perfis:
        if restante <= 0:
            break
        limite = (agora + timedelta(days=p.get("dias_min_abertura") or 0)).isoformat()
        params = {"select": "id,objeto,uf,modalidade,valor_estimado,valor_sigiloso",
                  "situacao": "eq.Divulgada no PNCP", "data_fim_proposta": "gte." + limite,
                  "order": "coletado_em.desc", "limit": "10000"}
        if p.get("ufs"):
            params["uf"] = "in.(" + ",".join(p["ufs"]) + ")"
        rr = requests.get(f"{SB}/oportunidades", headers=HDR, params=params, timeout=180)
        rr.raise_for_status()
        av = requests.get(f"{SB}/avaliacoes_ia", headers=HDR, timeout=120,
                          params={"select": "oportunidade_id", "perfil_id": "eq." + p["id"], "limit": "100000"})
        av.raise_for_status()
        ja = {x["oportunidade_id"] for x in av.json()}
        excl = [norm(w) for w in (p.get("palavras_excluir") or []) if w]
        incl = [norm(w) for w in (p.get("palavras_incluir") or []) if w]
        fila = []
        for o in rr.json():
            if o["id"] in ja:
                continue
            v = o.get("valor_estimado")
            if not o.get("valor_sigiloso") and v is not None:
                if p.get("valor_min") is not None and v < p["valor_min"]:
                    continue
                if p.get("valor_max") is not None and v > p["valor_max"]:
                    continue
            if p.get("modalidades") and o.get("modalidade") not in p["modalidades"]:
                continue
            txt = norm(o.get("objeto"))
            if any(w in txt for w in excl):
                continue
            o["_pri"] = 0 if any(w in txt for w in incl) else 1
            fila.append(o)
        fila.sort(key=lambda o: o["_pri"])
        fila = fila[:restante]
        restante -= len(fila)
        minimo = p.get("score_minimo") or 60
        print(f"[radar_ia] {p['nome']}: {len(fila)} a avaliar (score minimo {minimo})", flush=True)
        for i in range(0, len(fila), LOTE_RIA):
            lote = fila[i:i + LOTE_RIA]
            linhas = []
            for o in lote:
                val = "valor sigiloso" if o.get("valor_sigiloso") else f"R$ {o.get('valor_estimado') or 0:,.0f}"
                linhas.append(f"[{o['id']}] ({o.get('uf')}; {val}) {(o.get('objeto') or '')[:600]}")
            res = gemini_auto(PROMPT_RIA.replace("{perfil}", p["prompt"].strip()[:1500]) + "\n".join(linhas))
            if res is None:
                print("[radar_ia] limite de uso atingido; encerrando por hoje", flush=True)
                return total
            por = {str(x.get("id")): x for x in res if isinstance(x, dict)}
            aval, novos = [], []
            for o in lote:
                x = por.get(str(o["id"]))
                if not x:
                    continue
                try:
                    sc = max(0, min(100, int(float(x.get("score")))))
                except (TypeError, ValueError):
                    continue
                just = (x.get("justificativa") or "")[:200]
                aval.append({"perfil_id": p["id"], "oportunidade_id": o["id"], "score": sc, "justificativa": just})
                alvo = {"perfil_id": p["id"], "oportunidade_id": o["id"], "score": sc, "justificativa": just}
                if sc >= minimo:
                    novos.append(alvo)
                else:  # reprova casamento antigo por palavras-chave, se ainda nao foi trabalhado
                    requests.patch(f"{SB}/radar", headers={**HDR, "Prefer": "return=minimal"}, timeout=60,
                                   params={"perfil_id": "eq." + p["id"], "oportunidade_id": "eq." + str(o["id"]),
                                           "status": "eq.novo"},
                                   data=json.dumps({"status": "descartado", "score": sc, "justificativa": just, "observacoes": "auto-ia"}))
            if aval:
                upsert("avaliacoes_ia", aval, "perfil_id,oportunidade_id")
            if novos:
                rp = requests.post(f"{SB}/radar", headers={**HDR, "Prefer": "resolution=ignore-duplicates,return=minimal"},
                                   data=json.dumps(novos), timeout=120)
                if rp.status_code >= 300:
                    raise RuntimeError(f"radar_ia insert: {rp.status_code} {rp.text[:200]}")
                for n in novos:
                    requests.patch(f"{SB}/radar", headers={**HDR, "Prefer": "return=minimal"}, timeout=60,
                                   params={"perfil_id": "eq." + n["perfil_id"], "oportunidade_id": "eq." + str(n["oportunidade_id"])},
                                   data=json.dumps({"score": n["score"], "justificativa": n["justificativa"]}))
            total += len(aval)
            print(f"[radar_ia] {p['nome']}: {total} avaliados (modelo {GMODEL})", flush=True)
            ritmo()
    return total


# ------------------------------------------------------------------ itens e documentos dos editais (PNCP)
MAX_ITENS = int(os.getenv("MAX_ITENS", "400"))
MAX_DOCS = int(os.getenv("MAX_DOCS", "150"))
PNCP_ARQ = "https://pncp.gov.br/pncp-api/v1"
MAX_TEXTO = 150000          # caracteres guardados por edital
MAX_PROMPT_TEXTO = int(os.getenv("MAX_PROMPT_TEXTO", "22000"))  # caracteres enviados ao Gemini (apos o recorte)


def chave_pncp(o):
    m = re.match(r"^(\d{14})-\d+-(\d+)/(\d{4})$", o.get("numero_controle_pncp") or "")
    return (m.group(1), m.group(3), int(m.group(2))) if m else None


def radar_abertos(campos):
    """Editais abertos que estao no radar (sem repeticao), do maior para o menor score."""
    r = requests.get(f"{SB}/radar", headers=HDR, timeout=120, params={
        "select": "score,oportunidades(" + campos + ")", "oportunidade_id": "not.is.null",
        "status": "neq.descartado", "order": "interesse.desc.nullsfirst", "limit": "5000"})
    r.raise_for_status()
    agora = datetime.now(timezone.utc).isoformat()
    vistos, saida = set(), []
    for x in r.json():
        o = x.get("oportunidades")
        if o and o["id"] not in vistos and (o.get("data_fim_proposta") or "") >= agora:
            vistos.add(o["id"])
            saida.append(o)
    return saida


def itens():
    fila = [o for o in radar_abertos("id,numero_controle_pncp,data_fim_proposta,itens_em") if not o.get("itens_em")][:MAX_ITENS]
    print(f"[itens] {len(fila)} editais para ler os itens", flush=True)

    def um(o):
        try:
            k = chave_pncp(o)
            if not k:
                return o, []
            lista = get(f"{PNCP}/pncp/v1/orgaos/{k[0]}/compras/{k[1]}/{k[2]}/itens",
                        params={"pagina": 1, "tamanhoPagina": 200}) or []
            rows = []
            for i, x in enumerate(lista, 1):
                rows.append({"oportunidade_id": o["id"], "numero_item": i, "descricao": (x.get("descricao") or "")[:600],
                             "tipo": x.get("materialOuServico"), "quantidade": x.get("quantidade"),
                             "unidade": x.get("unidadeMedida"), "valor_unitario": x.get("valorUnitarioEstimado"),
                             "valor_total": x.get("valorTotal"), "criterio": x.get("criterioJulgamentoNome"),
                             "beneficio": x.get("tipoBeneficioNome"), "sigiloso": x.get("orcamentoSigiloso"),
                             "situacao": x.get("situacaoCompraItemNome")})
            return o, rows
        except Exception as e:  # noqa: BLE001
            print(f"[itens] falha em {o.get('id')}: {e}", flush=True)
            return o, None

    total = 0
    with cf.ThreadPoolExecutor(WORKERS) as ex:
        for o, rows in ex.map(um, fila):
            if rows is None:
                continue
            if rows:
                total += upsert("oportunidade_itens", rows, "oportunidade_id,numero_item")
            requests.patch(f"{SB}/oportunidades", params={"id": f"eq.{o['id']}"}, headers=HDR, timeout=60,
                           data=json.dumps({"itens_em": datetime.now(timezone.utc).isoformat()}))
    return total


def baixar(url, limite=30_000_000):
    r = requests.get(url, headers=UA, timeout=180, stream=True)
    if r.status_code != 200:
        return None
    buf = bytearray()
    for ch in r.iter_content(1 << 16):
        buf += ch
        if len(buf) > limite:
            return None
    return bytes(buf)


def texto_pdf(b):
    from pypdf import PdfReader
    rd = PdfReader(io.BytesIO(b))
    partes = []
    for pg in rd.pages[:150]:
        try:
            partes.append(pg.extract_text() or "")
        except Exception:  # noqa: BLE001
            partes.append("")
    return "\n".join(partes), len(rd.pages)


def texto_docx(b):
    with zipfile.ZipFile(io.BytesIO(b)) as z:
        xml = z.read("word/document.xml").decode("utf-8", "ignore")
    return re.sub(r"<[^>]+>", "", xml.replace("</w:p>", "\n")), 0


def extrair(nome, b):
    n = (nome or "").lower()
    try:
        if b[:4] == b"%PDF" or n.endswith(".pdf"):
            return texto_pdf(b)
        if n.endswith(".docx"):
            return texto_docx(b)
        if n.endswith((".txt", ".htm", ".html")):
            return b.decode("utf-8", "ignore"), 0
    except Exception as e:  # noqa: BLE001
        print(f"[docs] nao consegui ler {nome}: {e}", flush=True)
    return "", 0


def pontos_nome(n):
    n = norm(n)
    return (3 if "edital" in n else 0) + (2 if "termo" in n or "referencia" in n else 0) + (1 if "anexo" in n else 0)


def texto_do_edital(k):
    """Baixa os arquivos do edital (Edital e Termo de Referencia) e devolve (texto, nomes, paginas)."""
    arqs = get(f"{PNCP}/pncp/v1/orgaos/{k[0]}/compras/{k[1]}/{k[2]}/arquivos") or []
    pref = [a for a in arqs if a.get("statusAtivo", True) and norm(a.get("tipoDocumentoNome") or "") in ("edital", "termo de referencia", "projeto basico")]
    pref.sort(key=lambda a: 0 if norm(a.get("tipoDocumentoNome") or "") == "edital" else 1)
    partes, nomes, pags = [], [], 0
    for a in pref[:3]:
        url = a.get("url") or a.get("uri")
        b = baixar(url) if url else None
        if not b:
            continue
        if b[:2] == b"PK" and not (a.get("titulo") or "").lower().endswith(".docx"):
            try:
                with zipfile.ZipFile(io.BytesIO(b)) as z:
                    ents = sorted([i for i in z.infolist() if i.filename.lower().endswith((".pdf", ".docx", ".txt"))],
                                  key=lambda i: -pontos_nome(i.filename))[:4]
                    for i in ents:
                        t, p = extrair(i.filename, z.read(i))
                        if t.strip():
                            partes.append(t)
                            nomes.append(i.filename)
                            pags += p
            except zipfile.BadZipFile:
                pass
        else:
            t, p = extrair(a.get("titulo"), b)
            if t.strip():
                partes.append(t)
                nomes.append(a.get("titulo") or "")
                pags += p
        if sum(len(x) for x in partes) > MAX_TEXTO:
            break
    return "\n\n".join(partes)[:MAX_TEXTO], "; ".join(nomes)[:300], pags


# --- recorte inteligente: manda para a IA so os trechos que decidem a participacao ---
TERMOS_RECORTE = (
    (6, ("habilitacao", "qualificacao tecnica", "qualificacao economico", "atestado de capacidade",
         "documentos de habilitacao", "regularidade fiscal", "certidao negativa", "balanco patrimonial",
         "indice de liquidez", "capital social minimo", "registro no conselho", "cnae")),
    (5, ("prazo de entrega", "prazo de execucao", "cronograma de entrega", "local de entrega",
         "prazo de vigencia", "vigencia do contrato", "prorrogacao")),
    (5, ("garantia contratual", "garantia da proposta", "garantia do produto", "seguro garantia",
         "caucao", "retencao")),
    (5, ("sancao", "sancoes", "penalidade", "multa", "advertencia", "impedimento de licitar",
         "declaracao de inidoneidade", "rescisao")),
    (4, ("pagamento", "nota fiscal", "liquidacao", "reajuste", "repactuacao", "dotacao orcamentaria")),
    (4, ("amostra", "prova de conceito", "visita tecnica", "vistoria", "laudo", "registro no ministerio",
         "selo de inspecao", "sif", "anvisa", "inmetro")),
    (4, ("criterio de julgamento", "menor preco", "maior desconto", "tecnica e preco", "lance",
         "modo de disputa", "valor estimado", "valor maximo", "preco de referencia", "orcamento estimado")),
    (3, ("exclusiva para microempresa", "me/epp", "microempresa e empresa de pequeno porte",
         "cota reservada", "beneficio da lei complementar")),
    (3, ("objeto", "especificacao tecnica", "descricao do objeto", "quantitativo", "unidade de medida")),
    (3, ("subcontratacao", "consorcio", "obrigacoes da contratada", "fiscalizacao", "recebimento provisorio")),
)
RE_SECAO = re.compile(r"^\s*(\d{1,2}(\.\d{1,2})*\s*[-.\u2013)]?\s+|cl[a\u00e1]usula\b|anexo\b)", re.I)


def _pedacos(linha, alvo):
    """Linha muito longa (PDF sem quebras) vira varios pedacos, cortando em frases."""
    if len(linha) <= alvo:
        return [linha]
    out, atual = [], ""
    for fr in re.split(r"(?<=[.;:])\s+", linha):
        if atual and len(atual) + len(fr) > alvo:
            out.append(atual)
            atual = fr
        else:
            atual = (atual + " " + fr).strip()
    if atual:
        out.append(atual)
    return [x for p in out for x in ([p] if len(p) <= alvo * 2 else
                                     [p[i:i + alvo] for i in range(0, len(p), alvo)])]


def _blocos(texto, alvo=900):
    """Quebra o texto em blocos de ~alvo caracteres, respeitando linhas e frases."""
    out, buf, n = [], [], 0
    for bruta in texto.splitlines():
        for linha in _pedacos(bruta, alvo):
            buf.append(linha)
            n += len(linha) + 1
            if n >= alvo:
                out.append("\n".join(buf))
                buf, n = [], 0
    if buf:
        out.append("\n".join(buf))
    return out


def _peso(bloco):
    b = norm(bloco)
    p = 0
    for valor, termos in TERMOS_RECORTE:
        achou = sum(1 for t in termos if t in b)
        if achou:
            p += valor * min(achou, 3)
    if RE_SECAO.match(bloco.lstrip()):
        p += 1
    if len(b.strip()) < 120:
        p -= 2
    return p


def recortar(texto, limite=None, cabeca=6000):
    """Devolve so os trechos do edital que importam para decidir a participacao.

    Mantem o inicio (objeto, modalidade, criterio) e depois os blocos de maior peso,
    sempre na ordem original, marcando os cortes com [...]."""
    limite = limite or MAX_PROMPT_TEXTO
    if len(texto) <= limite:
        return texto
    inicio, resto = texto[:cabeca], texto[cabeca:]
    blocos = _blocos(resto)
    pontuados = sorted(((_peso(b), i) for i, b in enumerate(blocos)), reverse=True)
    orcamento = limite - len(inicio) - 200
    escolhidos, usado = set(), 0
    for p, i in pontuados:
        if p <= 0 or usado + len(blocos[i]) > orcamento:
            continue
        escolhidos.add(i)
        usado += len(blocos[i]) + 8
    if not escolhidos:
        return texto[:limite]
    partes, anterior = [inicio], -1
    for i in sorted(escolhidos):
        if i != anterior + 1:
            partes.append("[...]")
        partes.append(blocos[i])
        anterior = i
    if anterior < len(blocos) - 1:
        partes.append("[...]")
    return "\n".join(partes)[:limite]


PROMPT_DOC = """Voce analisa editais de licitacao publica brasileira para uma consultoria que ajuda empresas fornecedoras a participar.
Leia o texto abaixo e responda SOMENTE com um objeto JSON com estes campos (use null ou lista vazia quando nao constar no texto; nao invente):
{
 "resumo": "ate 3 frases: o que se contrata, criterio de julgamento e principais condicoes",
 "habilitacao": {"juridica": [], "fiscal_trabalhista": [], "tecnica": [], "economico_financeira": []},
 "exige_amostra": true ou false, "exige_visita_tecnica": true ou false, "exclusivo_me_epp": true ou false,
 "criterio_julgamento": "", "prazo_entrega": "", "local_entrega": "", "vigencia": "", "garantia": "", "pagamento": "",
 "riscos": [{"nivel": "alto" ou "medio" ou "baixo", "tema": "", "descricao": ""}],
 "risco_geral": numero de 0 a 100 (100 = muito arriscado ou restritivo para um fornecedor)
}
Cada item de habilitacao deve ser curto (ate 120 caracteres), por exemplo "Atestado de capacidade tecnica compativel com o objeto".
Em riscos considere prazo de entrega curto, exigencia desproporcional, amostra, garantia alta, pagamento longo, possivel direcionamento e multas elevadas.
Se o texto for apenas o objeto resumido, analise so o que ele permite e deixe o resto vazio.

TEXTO:
"""


def docs():
    if not GKEY:
        raise RuntimeError("GEMINI_API_KEY nao configurada")
    fila = [o for o in radar_abertos("id,numero_controle_pncp,data_fim_proposta,analise_em,objeto") if not o.get("analise_em")][:MAX_DOCS]
    print(f"[docs] {len(fila)} editais para analisar", flush=True)
    feitos = 0
    for o in fila:
        texto, arquivo, pags = "", "", 0
        try:
            k = chave_pncp(o)
            if k:
                texto, arquivo, pags = texto_do_edital(k)
        except Exception as e:  # noqa: BLE001
            print(f"[docs] falha ao baixar {o['id']}: {e}", flush=True)
        fonte = "edital" if len(texto) > 800 else "objeto"
        if fonte == "edital":
            upsert("edital_textos", [{"oportunidade_id": o["id"], "arquivo": arquivo, "paginas": pags, "texto": texto}], "oportunidade_id")
            entrada = recortar(texto)
        else:
            entrada = "OBJETO: " + (o.get("objeto") or "")[:2000]
        try:
            res = gemini_auto(PROMPT_DOC + entrada)
        except RuntimeError as e:
            print(f"[docs] IA falhou em {o['id']}: {e}", flush=True)
            res = {}
        if res is None:
            print("[docs] limite de uso atingido; encerrando por hoje", flush=True)
            break
        if isinstance(res, list):
            res = res[0] if res and isinstance(res[0], dict) else {}
        try:
            risco = max(0, min(100, int(float(res.get("risco_geral")))))
        except (TypeError, ValueError):
            risco = None
        if res:
            upsert("edital_analise", [{"oportunidade_id": o["id"], "dados": res, "risco": risco,
                                       "resumo": (res.get("resumo") or "")[:700], "fonte": fonte}], "oportunidade_id")
            feitos += 1
        requests.patch(f"{SB}/oportunidades", params={"id": f"eq.{o['id']}"}, headers=HDR, timeout=60,
                       data=json.dumps({"analise_em": datetime.now(timezone.utc).isoformat()}))
        print(f"[docs] {feitos}/{len(fila)} (fonte {fonte}, {len(texto)} caracteres, {len(entrada)} enviados)", flush=True)
        ritmo()
    return feitos


# ------------------------------------------------------------------ radar do PCA por prompt de IA
MAX_PCA_IA = int(os.getenv("MAX_PCA_IA", "150"))


def radar_pca_ia():
    if not GKEY:
        raise RuntimeError("GEMINI_API_KEY nao configurada")
    r = requests.get(f"{SB}/perfis_busca", headers=HDR, timeout=60, params={"select": "*", "ativo": "eq.true"})
    r.raise_for_status()
    perfis = [p for p in r.json() if (p.get("prompt") or "").strip() and "pca" in (p.get("fontes") or [])]
    restante, total = MAX_PCA_IA, 0
    hoje = datetime.now(timezone.utc).date().isoformat()
    for p in perfis:
        if restante <= 0:
            break
        params = {"select": "id,descricao,valor_total,data_desejada,pca_planos!inner(uf,orgao_nome)",
                  "or": f"(data_desejada.is.null,data_desejada.gte.{hoje})", "order": "valor_total.desc.nullslast", "limit": "5000"}
        if p.get("ufs"):
            params["pca_planos.uf"] = "in.(" + ",".join(p["ufs"]) + ")"
        rr = requests.get(f"{SB}/pca_itens", headers=HDR, params=params, timeout=180)
        rr.raise_for_status()
        av = requests.get(f"{SB}/avaliacoes_pca", headers=HDR, timeout=120,
                          params={"select": "pca_item_id", "perfil_id": "eq." + p["id"], "limit": "100000"})
        av.raise_for_status()
        ja = {x["pca_item_id"] for x in av.json()}
        excl = [norm(w) for w in (p.get("palavras_excluir") or []) if w]
        incl = [norm(w) for w in (p.get("palavras_incluir") or []) if w]
        fila = []
        for i in rr.json():
            if i["id"] in ja:
                continue
            v = i.get("valor_total")
            if v is not None and ((p.get("valor_min") is not None and v < p["valor_min"]) or (p.get("valor_max") is not None and v > p["valor_max"])):
                continue
            txt = norm(i.get("descricao"))
            if any(w in txt for w in excl):
                continue
            i["_pri"] = 0 if any(w in txt for w in incl) else 1
            fila.append(i)
        fila.sort(key=lambda i: i["_pri"])
        fila = fila[:restante]
        restante -= len(fila)
        minimo = p.get("score_minimo") or 60
        print(f"[radar_pca_ia] {p['nome']}: {len(fila)} itens a avaliar", flush=True)
        for n in range(0, len(fila), LOTE_RIA):
            lote = fila[n:n + LOTE_RIA]
            linhas = [f"[{i['id']}] ({(i.get('pca_planos') or {}).get('uf')}; R$ {i.get('valor_total') or 0:,.0f}) {(i.get('descricao') or '')[:400]}" for i in lote]
            res = gemini_auto(PROMPT_RIA.replace("{perfil}", p["prompt"].strip()[:1500]).replace("licitacao abaixo", "item de plano de contratacao abaixo") + "\n".join(linhas))
            if res is None:
                print("[radar_pca_ia] limite de uso atingido", flush=True)
                return total
            por = {str(x.get("id")): x for x in res if isinstance(x, dict)}
            aval, novos = [], []
            for i in lote:
                x = por.get(str(i["id"]))
                if not x:
                    continue
                try:
                    sc = max(0, min(100, int(float(x.get("score")))))
                except (TypeError, ValueError):
                    continue
                just = (x.get("justificativa") or "")[:200]
                aval.append({"perfil_id": p["id"], "pca_item_id": i["id"], "score": sc, "justificativa": just})
                if sc >= minimo:
                    novos.append({"perfil_id": p["id"], "pca_item_id": i["id"], "score": sc, "justificativa": just})
            if aval:
                upsert("avaliacoes_pca", aval, "perfil_id,pca_item_id")
            if novos:
                rp = requests.post(f"{SB}/radar", headers={**HDR, "Prefer": "resolution=ignore-duplicates,return=minimal"},
                                   data=json.dumps(novos), timeout=120)
                if rp.status_code >= 300:
                    raise RuntimeError(f"radar_pca_ia insert: {rp.status_code} {rp.text[:200]}")
                for x in novos:
                    requests.patch(f"{SB}/radar", headers={**HDR, "Prefer": "return=minimal"}, timeout=60,
                                   params={"perfil_id": "eq." + x["perfil_id"], "pca_item_id": "eq." + str(x["pca_item_id"])},
                                   data=json.dumps({"score": x["score"], "justificativa": x["justificativa"]}))
            total += len(aval)
            ritmo()
    return total


# ------------------------------------------------------------------ briefing diario
PROMPT_BRIEF = """Voce e analista de uma consultoria de licitacoes publicas (comissao sobre contratos). Escreva o briefing do dia em portugues, direto e util.
PERFIL: {perfil}
RESUMO: {n_radar} oportunidades abertas no radar, {n_novas} ainda nao analisadas, {n_7d} encerram em ate 7 dias.
Abaixo estao as melhores oportunidades (id, score, orgao/UF, valor, dias para encerrar, objeto, resumo, risco). Responda SOMENTE com JSON:
{"titulo": "frase curta", "resumo": "3 a 5 frases sobre o panorama e o que priorizar hoje", "destaques": [{"id": 0, "motivo": "uma frase"}], "alertas": ["frases curtas sobre prazos, riscos ou lacunas"]}
Escolha no maximo 5 destaques, usando apenas ids da lista.

OPORTUNIDADES:
"""


def briefing():
    if not GKEY:
        raise RuntimeError("GEMINI_API_KEY nao configurada")
    r = requests.get(f"{SB}/perfis_busca", headers=HDR, timeout=60, params={"select": "id,nome,prompt,palavras_incluir", "ativo": "eq.true"})
    r.raise_for_status()
    agora = datetime.now(timezone.utc)
    feitos = 0
    for p in r.json():
        rr = requests.get(f"{SB}/radar", headers=HDR, timeout=120, params={
            "select": "score,status,oportunidades(id,objeto,orgao_nome,uf,valor_estimado,valor_sigiloso,data_fim_proposta,ia_resumo,ia_atencao,edital_analise(risco))",
            "perfil_id": "eq." + p["id"], "oportunidade_id": "not.is.null", "status": "neq.descartado",
            "order": "score.desc", "limit": "400"})
        rr.raise_for_status()
        ab = [x for x in rr.json() if x.get("oportunidades") and (x["oportunidades"].get("data_fim_proposta") or "") >= agora.isoformat()]
        if not ab:
            continue
        n7 = sum(1 for x in ab if (x["oportunidades"]["data_fim_proposta"] or "") <= (agora + timedelta(days=7)).isoformat())
        novas = sum(1 for x in ab if x["status"] == "novo")
        linhas = []
        for x in ab[:12]:
            o = x["oportunidades"]
            d = max(0, (datetime.fromisoformat(o["data_fim_proposta"]) - agora).days)
            risco = (o.get("edital_analise") or {}).get("risco") if isinstance(o.get("edital_analise"), dict) else None
            val = "sigiloso" if o.get("valor_sigiloso") else f"R$ {o.get('valor_estimado') or 0:,.0f}"
            linhas.append(f"[{o['id']}] score {x['score']} | {o.get('orgao_nome')}/{o.get('uf')} | {val} | {d} dias | {(o.get('objeto') or '')[:220]} | {(o.get('ia_resumo') or '')[:160]} | risco {risco if risco is not None else 'n/d'}")
        perfil = (p.get("prompt") or ", ".join(p.get("palavras_incluir") or []) or p["nome"])[:600]
        texto = PROMPT_BRIEF.replace("{perfil}", perfil).replace("{n_radar}", str(len(ab))).replace("{n_novas}", str(novas)).replace("{n_7d}", str(n7)) + "\n".join(linhas)
        res = gemini_auto(texto)
        if res is None:
            print("[briefing] limite de uso atingido", flush=True)
            break
        if isinstance(res, list):
            res = res[0] if res and isinstance(res[0], dict) else {}
        if not res:
            continue
        ids = {x["oportunidades"]["id"] for x in ab}
        dest = [d for d in (res.get("destaques") or []) if isinstance(d, dict) and d.get("id") in ids][:5]
        rp = requests.post(f"{SB}/briefings", headers={**HDR, "Prefer": "return=minimal"}, timeout=60, data=json.dumps({
            "perfil_id": p["id"], "titulo": (res.get("titulo") or p["nome"])[:160], "resumo": (res.get("resumo") or "")[:1500],
            "destaques": dest, "alertas": [str(a)[:200] for a in (res.get("alertas") or [])][:6]}))
        if rp.status_code >= 300:
            raise RuntimeError(f"briefing: {rp.status_code} {rp.text[:200]}")
        feitos += 1
        ritmo()
    # briefings de perfis desativados nao interessam mais
    inat = requests.get(f"{SB}/perfis_busca", headers=HDR, timeout=60, params={"select": "id", "ativo": "eq.false"})
    if inat.ok and inat.json():
        requests.delete(f"{SB}/briefings", headers=HDR, timeout=60, params={"perfil_id": "in.(" + ",".join(str(x["id"]) for x in inat.json()) + ")"})
    requests.delete(f"{SB}/briefings", headers=HDR, timeout=60, params={"gerado_em": "lt." + (agora - timedelta(days=30)).isoformat()})
    return feitos


# ------------------------------------------------------------------ aprendizado: sugere ajuste no prompt do perfil
PROMPT_APR = """Voce ajuda a afinar o prompt de busca de oportunidades de licitacao de uma consultoria.
PROMPT ATUAL: {prompt}

Oportunidades que o usuario ACOMPANHOU (interessantes):
{pos}

Oportunidades que o usuario DESCARTOU (nao interessantes):
{neg}

Compare os dois grupos e proponha um prompt melhorado (mesmo formato: texto livre descrevendo o que o perfil procura e o que nao interessa, ate 600 caracteres). Responda SOMENTE com JSON: {"prompt": "...", "motivo": "ate 2 frases explicando o que mudou e por que"}.
Se nao houver padrao claro, repita o prompt atual e diga isso no motivo."""


def aprender():
    if not GKEY:
        raise RuntimeError("GEMINI_API_KEY nao configurada")
    r = requests.get(f"{SB}/perfis_busca", headers=HDR, timeout=60, params={"select": "*", "ativo": "eq.true"})
    r.raise_for_status()
    feitos = 0
    for p in r.json():
        if not (p.get("prompt") or "").strip():
            continue
        em = p.get("prompt_sugerido_em")
        if em and datetime.fromisoformat(em) > datetime.now(timezone.utc) - timedelta(days=7):
            continue
        rr = requests.get(f"{SB}/radar", headers=HDR, timeout=120, params={
            "select": "status,observacoes,oportunidades(objeto),pca_itens(descricao)", "perfil_id": "eq." + p["id"], "limit": "1000"})
        rr.raise_for_status()
        pos, neg = [], []
        for x in rr.json():
            txt = ((x.get("oportunidades") or {}).get("objeto") or (x.get("pca_itens") or {}).get("descricao") or "")[:200]
            if not txt:
                continue
            if x["status"] in ("analisando", "em_abordagem", "participando", "ganho"):
                pos.append(txt)
            elif x["status"] == "descartado" and x.get("observacoes") != "auto-ia":
                neg.append(txt)
        if len(pos) + len(neg) < 5:
            continue
        texto = (PROMPT_APR.replace("{prompt}", p["prompt"]).replace("{pos}", "\n".join("- " + t for t in pos[:15]) or "(nenhuma)")
                 .replace("{neg}", "\n".join("- " + t for t in neg[:15]) or "(nenhuma)"))
        res = gemini_auto(texto)
        if res is None:
            break
        if isinstance(res, list):
            res = res[0] if res and isinstance(res[0], dict) else {}
        if res.get("prompt"):
            requests.patch(f"{SB}/perfis_busca", params={"id": f"eq.{p['id']}"}, headers=HDR, timeout=60, data=json.dumps({
                "prompt_sugerido": str(res["prompt"])[:900], "prompt_sugerido_motivo": str(res.get("motivo") or "")[:400],
                "prompt_sugerido_em": datetime.now(timezone.utc).isoformat()}))
            feitos += 1
        ritmo()
    return feitos


# ------------------------------------------------------------------ estado das coletas incrementais
def estado(chave, valor=None):
    if valor is None:
        r = requests.get(f"{SB}/coleta_estado", headers=HDR, timeout=60, params={"chave": "eq." + chave, "select": "valor"})
        r.raise_for_status()
        return r.json()[0]["valor"] if r.json() else None
    upsert("coleta_estado", [{"chave": chave, "valor": str(valor), "atualizado_em": datetime.now(timezone.utc).isoformat()}], "chave")
    return valor


def janelas(chave, dias_hist, passo):
    """Datas (AAAAMMDD) a coletar: o que falta ate hoje e mais 'passo' dias de historico para tras."""
    hoje = datetime.now(timezone.utc).date()
    mx, mn = estado(chave + "_max"), estado(chave + "_min")
    mx = datetime.strptime(mx, "%Y%m%d").date() if mx else hoje - timedelta(days=2)
    mn = datetime.strptime(mn, "%Y%m%d").date() if mn else mx
    dias = []
    d = mx - timedelta(days=1)                      # 1 dia de sobreposicao para publicacoes atrasadas
    while d <= hoje:
        dias.append(d)
        d += timedelta(days=1)
    limite = hoje - timedelta(days=dias_hist)
    d = mn - timedelta(days=1)
    while d >= limite and len([x for x in dias if x < mn]) < passo:
        dias.append(d)
        d -= timedelta(days=1)
    return dias, chave


def paginas(url, params, tam=500, par=None):
    """Le todas as paginas de uma consulta do PNCP (em paralelo depois da primeira)."""
    p1 = get(url, {**params, "pagina": 1, "tamanhoPagina": tam})
    if not p1:
        return []
    dados = list(p1.get("data") or [])
    tot = p1.get("totalPaginas") or 1
    if tot > 1:
        with cf.ThreadPoolExecutor(par or WORKERS) as ex:
            for j in ex.map(lambda n: get(url, {**params, "pagina": n, "tamanhoPagina": tam}) or {}, range(2, tot + 1)):
                dados += j.get("data") or []
    return dados


# ------------------------------------------------------------------ contratos assinados (quem ganha o que)
CONTRATOS_DIAS = int(os.getenv("CONTRATOS_DIAS", "180"))
CONTRATOS_PASSO = int(os.getenv("CONTRATOS_PASSO", "10"))


def contratos():
    dias, _ = janelas("contratos", CONTRATOS_DIAS, CONTRATOS_PASSO)
    total, feitos = 0, []
    for d in sorted(set(dias), reverse=True):
        s = d.strftime("%Y%m%d")
        lista = paginas(f"{PNCP}/consulta/v1/contratos", {"dataInicial": s, "dataFinal": s})
        rows = []
        for c in lista:
            u, o = c.get("unidadeOrgao") or {}, c.get("orgaoEntidade") or {}
            rows.append({"numero_controle_pncp": c.get("numeroControlePNCP"), "compra": c.get("numeroControlePncpCompra"),
                         "orgao_cnpj": o.get("cnpj"), "orgao_nome": o.get("razaoSocial"), "uf": u.get("ufSigla"),
                         "municipio": u.get("municipioNome"), "esfera": o.get("esferaId"),
                         "tipo": (c.get("tipoContrato") or {}).get("nome"), "categoria": (c.get("categoriaProcesso") or {}).get("nome"),
                         "fornecedor_ni": c.get("niFornecedor"), "fornecedor_nome": c.get("nomeRazaoSocialFornecedor"),
                         "tipo_pessoa": c.get("tipoPessoa"), "objeto": (c.get("objetoContrato") or "")[:1500],
                         "valor_global": c.get("valorGlobal"), "valor_inicial": c.get("valorInicial"),
                         "data_assinatura": c.get("dataAssinatura"), "vigencia_fim": c.get("dataVigenciaFim"),
                         "publicado_em": ts(c.get("dataPublicacaoPncp"))})
        rows = [r for r in rows if r["numero_controle_pncp"]]
        if rows:
            total += upsert("contratos_pncp", rows, "numero_controle_pncp")
        feitos.append(d)
        print(f"[contratos] {s}: {len(rows)}", flush=True)
        mn = estado("contratos_min")
        if not mn or s < mn:
            estado("contratos_min", s)
    estado("contratos_max", datetime.now(timezone.utc).date().strftime("%Y%m%d"))
    requests.post(f"{SB}/rpc/limpar_mercado", headers=HDR, data="{}", timeout=600)
    return total


# ------------------------------------------------------------------ compras homologadas (desconto vencedor)
RESULT_MODALIDADES = os.getenv("RESULT_MODALIDADES", "4,5,6,7").split(",")
MODAL_NOME = {"4": "Concorrência eletrônica", "5": "Concorrência presencial", "6": "Pregão eletrônico", "7": "Pregão presencial", "8": "Dispensa"}


def resultados():
    dias, _ = janelas("resultados", 180, int(os.getenv("RESULTADOS_PASSO", "3")))
    total = 0
    for d in sorted(set(dias), reverse=True):
        s = d.strftime("%Y%m%d")
        rows = []
        for m in RESULT_MODALIDADES:
            # este endpoint aceita no maximo 50 por pagina (acima disso devolve HTTP 400)
            for c in paginas(f"{PNCP}/consulta/v1/contratacoes/atualizacao", {"dataInicial": s, "dataFinal": s, "codigoModalidadeContratacao": m}, 50, 1):
                # guarda o que vier: o homologado so e publicado depois da disputa, e o desconto
                # (coluna gerada) fica nulo ate os dois valores existirem na mesma compra
                if not ((c.get("valorTotalEstimado") or 0) > 0 or (c.get("valorTotalHomologado") or 0) > 0):
                    continue
                u = c.get("unidadeOrgao") or {}
                rows.append({"compra": c.get("numeroControlePNCP"), "orgao_nome": (c.get("orgaoEntidade") or {}).get("razaoSocial"),
                             "uf": u.get("ufSigla"), "municipio": u.get("municipioNome"), "modalidade": MODAL_NOME.get(m, m),
                             "srp": c.get("srp"), "objeto": (c.get("objetoCompra") or "")[:1500],
                             "valor_estimado": c.get("valorTotalEstimado"), "valor_homologado": c.get("valorTotalHomologado"),
                             "atualizado_em": ts(c.get("dataAtualizacaoGlobal") or c.get("dataAtualizacao"))})
        if rows:
            total += upsert("resultados_compras", rows, "compra")
        nh = sum(1 for r in rows if (r.get("valor_homologado") or 0) > 0 and (r.get("valor_estimado") or 0) > 0)
        print(f"[resultados] {s}: {len(rows)} compras ({nh} com estimado e homologado)", flush=True)
        mn = estado("resultados_min")
        if not mn or s < mn:
            estado("resultados_min", s)
    estado("resultados_max", datetime.now(timezone.utc).date().strftime("%Y%m%d"))
    return total


# ------------------------------------------------------------------ fornecedores: agrega contratos e completa cadastro (BrasilAPI)
MAX_ENRIQ = int(os.getenv("MAX_ENRIQ", "400"))


def fornecedores():
    r = requests.post(f"{SB}/rpc/atualizar_fornecedores", headers=HDR, data="{}", timeout=900)
    if r.status_code >= 300:
        raise RuntimeError(f"atualizar_fornecedores: {r.status_code} {r.text[:200]}")
    r = requests.get(f"{SB}/prospects", headers=HDR, timeout=120, params={
        "select": "id,cnpj", "enriquecido_em": "is.null", "cnpj": "not.is.null",
        "order": "qtd_contratos_gov.desc.nullslast", "limit": str(MAX_ENRIQ)})
    r.raise_for_status()
    feitos = 0
    for p in r.json():
        for espera in (0, 5, 20):
            time.sleep(espera)
            try:
                b = requests.get(f"https://brasilapi.com.br/api/cnpj/v1/{p['cnpj']}", headers=UA, timeout=40)
            except requests.RequestException:
                continue
            if b.status_code != 429:
                break
        dados = {"enriquecido_em": datetime.now(timezone.utc).isoformat()}
        if b.status_code == 200:
            j = b.json()
            tel = (j.get("ddd_telefone_1") or "").strip()
            dados.update({"razao_social": j.get("razao_social"), "nome_fantasia": j.get("nome_fantasia") or None,
                          "cnae_principal": str(j.get("cnae_fiscal") or "") or None, "cnae_descricao": j.get("cnae_fiscal_descricao"),
                          "cnaes_secundarios": [str(x.get("codigo")) for x in (j.get("cnaes_secundarios") or []) if x.get("codigo")][:30],
                          "uf": j.get("uf"), "municipio": j.get("municipio"), "porte": j.get("porte") or j.get("descricao_porte"),
                          "situacao_cadastral": j.get("descricao_situacao_cadastral"), "telefone": tel or None,
                          "email": (j.get("email") or "").lower() or None})
        requests.patch(f"{SB}/prospects", params={"id": f"eq.{p['id']}"}, headers=HDR, timeout=60, data=json.dumps(dados))
        feitos += 1
        time.sleep(0.6)
    return feitos


# ------------------------------------------------------------------ vigia: arquivos novos (retificacoes, esclarecimentos) nos editais do radar
MAX_VIGIA = int(os.getenv("MAX_VIGIA", "300"))
PROMPT_VIG = """Um edital de licitacao recebeu um documento novo no PNCP (titulo: {titulo}; tipo: {tipo}).
Resuma em ate 3 frases, em portugues, o que esse documento muda ou esclarece para um fornecedor (prazos, exigencias, valores, data da sessao).
Responda SOMENTE JSON: {{"resumo": "...", "impacto": "alto|medio|baixo"}}

TEXTO:
"""


def vigia():
    fila = radar_abertos("id,numero_controle_pncp,data_fim_proposta,objeto,arquivos_ids,link_pncp")[:MAX_VIGIA]
    novos = 0
    for o in fila:
        k = chave_pncp(o)
        if not k:
            continue
        try:
            arqs = get(f"{PNCP}/pncp/v1/orgaos/{k[0]}/compras/{k[1]}/{k[2]}/arquivos") or []
        except RuntimeError:
            continue
        ids = sorted({a.get("sequencialDocumento") for a in arqs if a.get("sequencialDocumento") is not None})
        antes = o.get("arquivos_ids")
        patch = {"arquivos_ids": ids, "vigia_em": datetime.now(timezone.utc).isoformat()}
        if antes is not None:
            diff = [a for a in arqs if a.get("sequencialDocumento") not in set(antes)]
            if diff:
                a = sorted(diff, key=lambda x: x.get("sequencialDocumento") or 0)[-1]
                resumo, impacto = "", ""
                if GKEY:
                    try:
                        b = baixar(a.get("url") or a.get("uri"))
                        t = extrair(a.get("titulo"), b)[0] if b else ""
                        if len(t) > 200:
                            res = gemini_auto(PROMPT_VIG.format(titulo=a.get("titulo"), tipo=a.get("tipoDocumentoNome")) + t[:20000])
                            if isinstance(res, dict):
                                resumo, impacto = res.get("resumo") or "", res.get("impacto") or ""
                    except Exception as e:  # noqa: BLE001
                        print(f"[vigia] resumo falhou {o['id']}: {e}", flush=True)
                titulos = "; ".join(f"{x.get('tipoDocumentoNome') or ''} {x.get('titulo') or ''}".strip() for x in diff)[:300]
                upsert("alertas", [{"tipo": "retificacao", "ref": f"{o['id']}:{max(ids)}",
                                    "titulo": f"Documento novo no edital: {(o.get('objeto') or '')[:120]}",
                                    "texto": (f"[{impacto}] " if impacto else "") + (resumo or titulos), "link": o.get("link_pncp")}], "tipo,ref")
                patch["analise_em"] = None          # reanalisa o edital com o documento novo
                novos += 1
        requests.patch(f"{SB}/oportunidades", params={"id": f"eq.{o['id']}"}, headers=HDR, timeout=60, data=json.dumps(patch))
    return novos


# ------------------------------------------------------------------ alertas no Telegram
TG = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
ALERTA_SCORE = int(os.getenv("ALERTA_SCORE", "65"))
ALERTA_PCA_SCORE = int(os.getenv("ALERTA_PCA_SCORE", "80"))   # previsoes do PCA nao tem "interesse", so a nota da IA (score)
PAINEL = os.getenv("PAINEL_URL", "https://sislicita.pages.dev")


def h(s):
    return (str(s or "")).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


TG_DESC = ("Radar de licitações públicas do SISLICITA. Avisa sobre oportunidades com score alto no radar, "
           "briefing diário por IA, documentos novos (retificações) nos editais acompanhados, sessões próximas "
           "dos seus processos e documentos de empresas vencendo. Envie /start para vincular este chat e /status "
           "para ver se o sistema está operando.")
TG_CMDS = [{"command": "start", "description": "Vincular este chat e ver o que o bot faz"},
           {"command": "status", "description": "Situação do sistema agora"},
           {"command": "ajuda", "description": "O que este bot avisa"}]
TG_CFG_VERSAO = "2"


def tg_api(metodo, **dados):
    r = requests.post(f"https://api.telegram.org/bot{TG}/{metodo}", json=dados, timeout=30)
    return r.json() if r.headers.get("content-type", "").startswith("application/json") else {}


def tg_chat():
    """Chat do dono: segredo TELEGRAM_CHAT_ID, ou o chat vinculado pelo /start (webhook), ou o ultimo /start via getUpdates."""
    cid = os.getenv("TELEGRAM_CHAT_ID", "").strip()
    if cid:
        if estado("telegram_chat") != cid:
            estado("telegram_chat", cid)
        return cid
    cid = estado("telegram_chat")
    if cid:
        return cid
    info = tg_api("getWebhookInfo").get("result") or {}
    if not info.get("url"):
        for u in reversed(tg_api("getUpdates").get("result") or []):
            m = u.get("message") or {}
            if m.get("chat", {}).get("id"):
                return estado("telegram_chat", m["chat"]["id"])
    return None


def tg_configurar():
    """Descricao, comandos e webhook (/api/telegram no Cloudflare) para o bot responder /start e /status na hora."""
    import secrets
    sec = estado("telegram_webhook_secret")
    if not sec:
        sec = estado("telegram_webhook_secret", secrets.token_urlsafe(32))
    url = PAINEL + "/api/telegram"
    info = tg_api("getWebhookInfo").get("result") or {}
    if info.get("url") != url or estado("telegram_cfg") != TG_CFG_VERSAO:
        r = tg_api("setWebhook", url=url, secret_token=sec, allowed_updates=["message", "edited_message"], drop_pending_updates=False)
        print(f"[alertas] webhook: {r.get('description') or r}", flush=True)
    if estado("telegram_cfg") != TG_CFG_VERSAO:
        tg_api("setMyDescription", description=TG_DESC[:512], language_code="pt")
        tg_api("setMyDescription", description=TG_DESC[:512])
        tg_api("setMyShortDescription", short_description="Alertas de licitações do SISLICITA: oportunidades, briefing, retificações e prazos.")
        tg_api("setMyCommands", commands=TG_CMDS)
        estado("telegram_cfg", TG_CFG_VERSAO)


def tg(chat, texto):
    for parte in [texto[i:i + 3900] for i in range(0, len(texto), 3900)]:
        r = requests.post(f"https://api.telegram.org/bot{TG}/sendMessage", timeout=30,
                          json={"chat_id": chat, "text": parte, "parse_mode": "HTML", "disable_web_page_preview": True})
        if r.status_code == 429:
            time.sleep(int((r.json().get("parameters") or {}).get("retry_after", 5)) + 1)
            r = requests.post(f"https://api.telegram.org/bot{TG}/sendMessage", timeout=30,
                              json={"chat_id": chat, "text": parte, "parse_mode": "HTML", "disable_web_page_preview": True})
        if r.status_code >= 300:
            raise RuntimeError(f"Telegram {r.status_code}: {r.text[:200]}")
        time.sleep(1)


def alertas():
    agora = datetime.now(timezone.utc)
    # alertas gerados aqui (sessoes proximas e documentos vencendo) tambem aparecem no painel
    pr = requests.get(f"{SB}/processos", headers=HDR, timeout=60, params={
        "select": "id,titulo,orgao,data_sessao,empresas(nome)", "status": "not.in.(ganho,perdido,desistiu)",
        "data_sessao": f"gte.{agora.isoformat()}", "and": f"(data_sessao.lte.{(agora + timedelta(days=2)).isoformat()})"}).json()
    linhas = [{"tipo": "sessao", "ref": f"{p['id']}:{p['data_sessao'][:16]}", "titulo": f"Sessão em breve: {(p.get('titulo') or '')[:120]}",
               "texto": f"{(p.get('empresas') or {}).get('nome', '')} · {p.get('orgao') or ''} · {datetime.fromisoformat(p['data_sessao']).astimezone(timezone(timedelta(hours=-3))).strftime('%d/%m %H:%M')}",
               "link": PAINEL + "/#processos"} for p in pr if isinstance(p, dict)]
    dv = requests.get(f"{SB}/empresa_docs", headers=HDR, timeout=60, params={
        "select": "id,tipo,validade,empresas(nome)", "validade": f"lte.{(agora + timedelta(days=15)).date()}"}).json()
    linhas += [{"tipo": "doc_vencendo", "ref": f"{d['id']}:{d['validade']}", "titulo": f"Documento {'vencido' if d['validade'] < str(agora.date()) else 'vencendo'}: {d['tipo']}",
                "texto": f"{(d.get('empresas') or {}).get('nome', '')} · validade {datetime.strptime(d['validade'], '%Y-%m-%d').strftime('%d/%m/%Y')}",
                "link": PAINEL + "/#empresas"} for d in dv if isinstance(d, dict) and d.get("validade")]
    if linhas:
        requests.post(f"{SB}/alertas", params={"on_conflict": "tipo,ref"}, headers={**HDR, "Prefer": "resolution=ignore-duplicates,return=minimal"},
                      data=json.dumps(linhas), timeout=60)
    if not TG:
        print("[alertas] TELEGRAM_BOT_TOKEN nao configurado; alertas ficam so no painel", flush=True)
        return len(linhas)
    chat = tg_chat()          # antes do webhook: o getUpdates so funciona sem webhook
    tg_configurar()
    if not chat:
        print("[alertas] nenhum chat encontrado: envie /start ao seu bot no Telegram", flush=True)
        return 0
    enviados = 0
    if not estado("telegram_inicio"):
        # primeira vez: marca o que ja existe como visto, para nao inundar o Telegram
        requests.patch(f"{SB}/radar", params={"notificado_em": "is.null"}, headers=HDR, timeout=120, data=json.dumps({"notificado_em": agora.isoformat()}))
        requests.patch(f"{SB}/alertas", params={"enviado_em": "is.null"}, headers=HDR, timeout=60, data=json.dumps({"enviado_em": agora.isoformat()}))
        requests.patch(f"{SB}/briefings", params={"enviado_em": "is.null"}, headers=HDR, timeout=60, data=json.dumps({"enviado_em": agora.isoformat()}))
        tg(chat, f"✅ <b>SISLICITA conectado</b>\nVocê vai receber aqui: oportunidades com interesse ≥ {ALERTA_SCORE}, briefing diário, documentos novos em editais do radar, sessões próximas e documentos vencendo.\n{PAINEL}")
        estado("telegram_inicio", agora.isoformat())
        return 1
    # 1) briefings novos
    for b in requests.get(f"{SB}/briefings", headers=HDR, timeout=60, params={"select": "id,titulo,resumo,alertas,perfis_busca(nome)", "enviado_em": "is.null", "order": "id"}).json():
        t = f"🧭 <b>Briefing · {h((b.get('perfis_busca') or {}).get('nome'))}</b>\n<b>{h(b.get('titulo'))}</b>\n{h(b.get('resumo'))}"
        if b.get("alertas"):
            t += "\n" + "\n".join("⚠️ " + h(a) for a in b["alertas"])
        tg(chat, t)
        requests.patch(f"{SB}/briefings", params={"id": f"eq.{b['id']}"}, headers=HDR, timeout=60, data=json.dumps({"enviado_em": agora.isoformat()}))
        enviados += 1
    # 2) oportunidades novas com score alto (editais e previsoes do PCA, em mensagens separadas)
    rr = requests.get(f"{SB}/radar", headers=HDR, timeout=120, params={
        "select": "id,score,interesse,justificativa,perfis_busca(nome),oportunidades(objeto,orgao_nome,uf,valor_estimado,valor_sigiloso,data_fim_proposta,link_pncp),pca_itens(descricao,valor_total,data_desejada,pca_planos(orgao_nome,uf))",
        "notificado_em": "is.null", "oportunidade_id": "not.is.null", "interesse": f"gte.{ALERTA_SCORE}", "status": "neq.descartado", "order": "interesse.desc", "limit": "40"}).json()
    rp = requests.get(f"{SB}/radar", headers=HDR, timeout=120, params={
        "select": "id,score,interesse,justificativa,perfis_busca(nome),pca_itens(descricao,valor_total,data_desejada,pca_planos(orgao_nome,uf))",
        "notificado_em": "is.null", "pca_item_id": "not.is.null", "score": f"gte.{ALERTA_PCA_SCORE}", "status": "neq.descartado", "order": "score.desc", "limit": "300"}).json()
    rr = (rr if isinstance(rr, list) else []) + (rp if isinstance(rp, list) else [])
    if rr:
        eds = [x for x in rr if x.get("oportunidades")]
        pcas = [x for x in rr if not x.get("oportunidades") and x.get("pca_itens")]
        if eds:
            partes = []
            for x in eds[:15]:
                o = x["oportunidades"]
                val = "sigiloso" if o.get("valor_sigiloso") else f"R$ {o.get('valor_estimado') or 0:,.0f}".replace(",", ".")
                fim = (o.get("data_fim_proposta") or "")[:10]
                partes.append(f"• <b>{x['interesse']}</b> · {h((o.get('objeto') or '')[:160])}\n  {h(o.get('orgao_nome'))}/{h(o.get('uf'))} · {val} · até {fim[8:10]}/{fim[5:7]}" + (f" · <a href=\"{h(o.get('link_pncp'))}\">PNCP</a>" if o.get("link_pncp") else ""))
            tg(chat, f"🎯 <b>{len(eds)} oportunidade(s) nova(s) com interesse ≥ {ALERTA_SCORE}</b>\n\n" + "\n\n".join(partes) + (f"\n\n…e mais {len(eds) - 15} no painel." if len(eds) > 15 else "") + f"\n{PAINEL}/#radar")
            enviados += 1
        # PCA: agrupado por orgao; ignora compras previstas para antes de 30 dias atras
        corte = (agora - timedelta(days=30)).date().isoformat()
        grupos = {}
        for x in pcas:
            p = x["pca_itens"]
            if p.get("data_desejada") and p["data_desejada"][:10] < corte:
                continue
            pl = p.get("pca_planos") or {}
            grupos.setdefault((pl.get("orgao_nome") or "?", pl.get("uf") or ""), []).append((x, p))
        if grupos:
            blocos = []
            for (org, uf), itens in sorted(grupos.items(), key=lambda kv: -max(i[0]["score"] or 0 for i in kv[1]))[:8]:
                linhas_i = []
                for x, p in itens[:3]:
                    d = (p.get("data_desejada") or "")[:10]
                    linhas_i.append(f"  • <b>{x['score']}</b> · {h((p.get('descricao') or '')[:110])} · R$ {p.get('valor_total') or 0:,.0f}".replace(",", ".") + (f" · prevista {d[5:7]}/{d[:4]}" if d else ""))
                mais = f"\n  …e mais {len(itens) - 3} deste órgão" if len(itens) > 3 else ""
                blocos.append(f"🏛️ <b>{h(org)}</b>{('/' + h(uf)) if uf else ''}\n" + "\n".join(linhas_i) + mais)
            total = sum(len(v) for v in grupos.values())
            tg(chat, f"📅 <b>Previsão (PCA): {total} compra(s) planejada(s) aderente(s) aos seus perfis</b>\nÓrgãos que ainda vão licitar: é a hora de abordar antes do edital.\n\n" + "\n\n".join(blocos) + (f"\n\n…e mais {len(grupos) - 8} órgão(s) no painel." if len(grupos) > 8 else "") + f"\n{PAINEL}/#pca")
            enviados += 1
        ids = ",".join(str(x["id"]) for x in rr)
        requests.patch(f"{SB}/radar", params={"id": f"in.({ids})"}, headers=HDR, timeout=60, data=json.dumps({"notificado_em": agora.isoformat()}))
    # 3) demais alertas (documentos novos, sessoes, documentos vencendo)
    ic = {"retificacao": "📄", "sessao": "⏰", "doc_vencendo": "🗂️"}
    for a in requests.get(f"{SB}/alertas", headers=HDR, timeout=60, params={"select": "*", "enviado_em": "is.null", "order": "id", "limit": "30"}).json():
        tg(chat, f"{ic.get(a['tipo'], '🔔')} <b>{h(a.get('titulo'))}</b>\n{h(a.get('texto'))}" + (f"\n{h(a.get('link'))}" if a.get("link") else ""))
        requests.patch(f"{SB}/alertas", params={"id": f"eq.{a['id']}"}, headers=HDR, timeout=60, data=json.dumps({"enviado_em": agora.isoformat()}))
        enviados += 1
    return enviados


def notificar_fim(modo, resumo, segundos):
    """Avisa no Telegram que a coleta terminou (se o bot ja estiver configurado e com chat vinculado)."""
    if not TG:
        return
    chat = tg_chat()
    if not chat:
        return
    ok = [f"✅ {h(n)}: {q} registro(s)" for n, q, erro in resumo if erro is None]
    ko = [f"❌ {h(n)}: {h(erro)}" for n, q, erro in resumo if erro is not None]
    mins = round(segundos / 60, 1)
    rotulo = "coleta completa" if modo == "tudo" else h(modo.replace(",", ", "))
    texto = f"🏁 <b>Coleta concluída</b> · {rotulo} · {mins} min\n" + ("\n".join(ok) if ok else "(nenhuma etapa concluida)")
    if ko:
        texto += "\n\n<b>Com erro:</b>\n" + "\n".join(ko)
    if AVISOS:
        texto += "\n\n<b>Avisos:</b>\n" + "\n".join(f"⚠️ {h(n)}: {h(t)}" for n, t in AVISOS)
    tg(chat, texto)


def notificar_historico(completo, limite_txt=""):
    """Avisos do historico: so quando termina ou quando para sem avancar (rodadas intermediarias ficam quietas)."""
    if not TG:
        return
    chat = tg_chat()
    if not chat:
        return
    if completo:
        tg(chat, f"📚 <b>Histórico de editais completo</b>\nOs últimos {HIST_DIAS} dias estão no banco{limite_txt}. "
                 "A coleta diária continua de onde parou, sem trabalho extra.")
    else:
        tg(chat, "⚠️ <b>Histórico de editais parou sem avançar</b>\nO PNCP não respondeu. Retomo sozinho na próxima coleta agendada.")


def fechar_execucao(modo, resumo, falhou, segundos):
    """Fim da execucao: sinaliza ao workflow se o historico deve continuar e decide quais avisos mandar."""
    hist_rodou = any(n == "historico" and e is None for n, _, e in resumo)
    pendente = hist_rodou and not HIST_RESULT["completo"] and HIST_RESULT["dias"] > 0
    if not any(n == "historico" for n, _, _ in resumo):
        # uma coleta manual pode ter ocupado o lugar da corrente do historico na fila: retoma se ainda falta
        try:
            mn = estado("historico_min")
            limite = datetime.now(timezone.utc).date() - timedelta(days=HIST_DIAS)
            pendente = bool(mn) and datetime.strptime(mn, "%Y%m%d").date() - timedelta(days=1) >= limite
        except Exception:
            pendente = False
    saida = os.getenv("GITHUB_OUTPUT")
    if saida:
        with open(saida, "a") as f:
            f.write(f"hist_pendente={'true' if pendente else 'false'}\n")
    if HIST_RESULT["completo"] and HIST_RESULT["dias"] > 0:      # terminou nesta execucao
        notificar_historico(True, f" (desde {(datetime.now(timezone.utc).date() - timedelta(days=HIST_DIAS)):%d/%m/%Y})")
    if modo == "historico":
        if pendente and not falhou:
            return                                              # rodada intermediaria: sem aviso
        if not HIST_RESULT["completo"] and HIST_RESULT["dias"] == 0 and not falhou:
            notificar_historico(False)
            return
        if HIST_RESULT["completo"] and not falhou:
            return                                              # ja avisou a conclusao acima
    notificar_fim(modo, resumo, segundos)


# a ordem importa no modo "tudo": o interesse so e calculado depois que a IA e a analise
# do edital ja rodaram, e antes do briefing/alertas, que usam a nota para escolher o que mostrar
ETAPAS = {"editais": editais, "vetores": vetores, "triagem": triagem, "pca": pca, "radar": radar, "ia": ia, "radar_ia": radar_ia, "itens": itens,
          "vigia": vigia, "docs": docs, "radar_pca_ia": radar_pca_ia, "interesse": interesse,
          "briefing": briefing, "aprender": aprender, "alertas": alertas,
          "contratos": contratos, "resultados": resultados, "fornecedores": fornecedores,
          "historico": historico, "cobertura": cobertura}
EXTRAS = {"catalogo": catalogo}

# Etapas sem as quais a coleta nao cumpriu seu papel: so elas marcam a execucao como falha.
ESSENCIAIS = {"editais", "vetores", "triagem", "radar"}
# Etapas longas ou que ja fazem a propria repeticao: repetir na hora so gastaria tempo.
SEM_REPETIR = {"historico", "ia", "radar_ia", "radar_pca_ia", "docs", "pca", "contratos", "resultados"}

if __name__ == "__main__":
    modo = sys.argv[1] if len(sys.argv) > 1 else "tudo"
    MODO_SOLO = (modo.strip() == "historico")
    etapas = list(ETAPAS) if modo == "tudo" else [m.strip() for m in modo.split(",") if m.strip()]  # aceita varias: "contratos,resultados"
    ETAPAS = {**ETAPAS, **EXTRAS}
    falhou = False
    resumo = []
    inicio = time.time()
    for nome in etapas:
        id_ = log_inicio(nome)
        FASE_ATUAL = nome
        erro = None
        for tentativa in (1, 2):   # instabilidade do PNCP/Gemini costuma passar em poucos minutos
            try:
                n = ETAPAS[nome]()
                log_fim(id_, n, "ok")
                print(f"[{nome}] ok: {n} registros")
                resumo.append((nome, n, None))
                erro = None
                break
            except Exception as e:
                erro = e
                if tentativa == 1 and nome not in SEM_REPETIR:
                    print(f"[{nome}] falhou ({str(e)[:120]}); repetindo em 2 min", file=sys.stderr)
                    time.sleep(120)
                else:
                    break
        if erro is not None:
            if nome in ESSENCIAIS:
                falhou = True
            log_fim(id_, 0, "erro", str(erro)[:500])
            print(f"[{nome}] ERRO: {erro}", file=sys.stderr)
            resumo.append((nome, 0, str(erro)[:200]))
        gravar_uso()
    for rpc in ("atualizar_dashboard", "atualizar_servico"):  # resumos do Inicio e da aba Servicos ficam em cache
        try:
            requests.post(f"{SB}/rpc/{rpc}", headers=HDR, data="{}", timeout=400).raise_for_status()
        except Exception as e:
            print(f"[{rpc}] cache nao atualizado: {e}", file=sys.stderr)
    try:
        fechar_execucao(modo, resumo, falhou, time.time() - inicio)
    except Exception as e:
        print(f"[fim] fechamento falhou: {e}", file=sys.stderr)
    sys.exit(1 if falhou else 0)
