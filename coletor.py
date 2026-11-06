"""SISLICITA - coletor do PNCP para o Supabase.

Uso: python coletor.py [editais|pca|radar|tudo]
Variaveis: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (obrigatorias).
Opcionais: MODALIDADES, WORKERS, ANOS_PCA, MAX_PLANOS, PCA_PAGINA.
"""
import concurrent.futures as cf
import json
import os
import re
import sys
import time
import unicodedata
from datetime import datetime, timezone

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
            if r.status_code in (204, 400, 404):
                return None
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


def coletar_edital(modalidade, uf):
    rows, pagina = [], 1
    while True:
        try:
            j = get(f"{PNCP}/consulta/v1/contratacoes/proposta",
                    {"dataFinal": "20271231", "codigoModalidadeContratacao": modalidade, "uf": uf,
                     "pagina": pagina, "tamanhoPagina": 50})
        except RuntimeError as e:
            print(f"[editais] AVISO modalidade={modalidade} uf={uf} pag={pagina}: {e}", file=sys.stderr)
            break
        if not j or not j.get("data"):
            break
        rows += [parse_edital(c) for c in j["data"]]
        if pagina >= (j.get("totalPaginas") or 1):
            break
        pagina += 1
    return rows


def editais():
    tarefas = [(m, u) for m in MODALIDADES for u in UFS]
    total = 0
    with cf.ThreadPoolExecutor(WORKERS) as ex:
        for rows in ex.map(lambda t: coletar_edital(*t), tarefas):
            if rows:
                total += upsert("oportunidades", rows, "numero_controle_pncp")
    return total


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
                        "poder": it.get("poder_nome"), "uf": it.get("uf"),
                        "valor_total": it.get("valor_global"),
                        "data_atualizacao": ts(it.get("data_atualizacao_pncp")),
                    })
            except RuntimeError as e:
                print(f"[pca] AVISO ano={ano} esfera={esfera}: lista parcial ({len(rows)} planos): {e}",
                      file=sys.stderr)
            if rows:
                total += upsert("pca_planos", rows, "orgao_cnpj,ano")
    return total


PCA_VALOR_MIN = float(os.getenv("PCA_VALOR_MIN", "100000"))


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
PAUSA_IA = float(os.getenv("PAUSA_IA", "7"))

PROMPT_IA = """Voce analisa objetos de licitacoes publicas brasileiras para uma consultoria que assessora empresas fornecedoras.
Para CADA item abaixo devolva um objeto JSON com:
- id: o mesmo id recebido
- tipo: "M" (fornecimento de material/bem), "S" (servico comum) ou "O" (obra, engenharia ou outro)
- categoria: area em 1 a 3 palavras (ex.: alimentos, informatica, limpeza, saude, veiculos)
- termo_catalogo: nome generico e curto do principal item ou servico, como aparece em catalogos de compras (ex.: CARNE BOVINA, CADEIRA ESCRITORIO, SERVICO DE LIMPEZA); vazio se nao der para identificar
- resumo: no maximo 2 frases simples dizendo o que o orgao quer comprar, sem inventar nada que nao esteja no texto
- atencao: ponto de atencao para um fornecedor que seja visivel no texto (ex.: registro de precos, credenciamento, exige amostra, lote unico) ou vazio
Responda SOMENTE com um array JSON, sem texto extra.

ITENS:
"""


def gemini(prompt, modelo):
    url = f"{GEM}/models/{modelo}:generateContent"
    corpo = {"contents": [{"parts": [{"text": prompt}]}],
             "generationConfig": {"temperature": 0.1, "responseMimeType": "application/json"}}
    for espera in (0, 30, 60, 120):
        time.sleep(espera)
        r = requests.post(url, headers={"x-goog-api-key": GKEY, "Content-Type": "application/json"},
                          data=json.dumps(corpo), timeout=120)
        if r.status_code == 429 or r.status_code >= 500:
            print(f"[ia] HTTP {r.status_code}, aguardando...", flush=True)
            continue
        if r.status_code >= 300:
            raise RuntimeError(f"gemini {r.status_code}: {r.text[:300]}")
        j = r.json()
        try:
            return json.loads(j["candidates"][0]["content"]["parts"][0]["text"])
        except Exception:
            raise RuntimeError("gemini: resposta fora do formato: " + json.dumps(j)[:300])
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


def casar_catalogo(tipo, termo):
    palavras = [w for w in re.sub(r"[^A-Z0-9 ]", " ", norm(termo or "").upper()).split() if len(w) > 2]
    for n in (len(palavras), 2):
        usa = palavras[:n]
        if not usa:
            return None
        filtros = [("nome_busca", "ilike.*" + w + "*") for w in usa]
        r = requests.get(f"{SB}/catalogo", headers=HDR, timeout=60,
                         params=[("select", "codigo,nome"), ("tipo", "eq." + tipo), ("limit", "30")] + filtros)
        if r.status_code < 300 and r.json():
            return sorted(r.json(), key=lambda x: len(x["nome"]))[0]
    return None


def ia():
    global GMODEL
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
        try:
            res = gemini(texto, GMODEL)
        except RuntimeError as e:
            if " 404" in str(e) and i == 0:
                GMODEL = escolher_modelo()
                print(f"[ia] modelo padrao indisponivel; usando {GMODEL}", flush=True)
                res = gemini(texto, GMODEL)
            else:
                raise
        if res is None:
            print("[ia] limite de uso atingido; encerrando por hoje", flush=True)
            break
        por_id = {str(x.get("id")): x for x in res if isinstance(x, dict)}
        for o in lote:
            x = por_id.get(str(o["id"]))
            if not x:
                continue
            tipo = x.get("tipo") if x.get("tipo") in ("M", "S", "O") else "O"
            cat = casar_catalogo(tipo, x.get("termo_catalogo")) if tipo in ("M", "S") else None
            patch = {"ia_categoria": (x.get("categoria") or "")[:60], "ia_resumo": (x.get("resumo") or "")[:600],
                     "ia_tipo": tipo, "ia_termo": (x.get("termo_catalogo") or "")[:120],
                     "ia_atencao": (x.get("atencao") or "")[:300],
                     "ia_catalogo_codigo": cat["codigo"] if cat else None, "ia_catalogo_nome": cat["nome"] if cat else None,
                     "ia_processado_em": agora}
            rr = requests.patch(f"{SB}/oportunidades", headers={**HDR, "Prefer": "return=minimal"},
                                params={"id": "eq." + str(o["id"])}, data=json.dumps(patch), timeout=60)
            if rr.status_code >= 300:
                raise RuntimeError(f"ia patch: {rr.status_code} {rr.text[:200]}")
            feitos += 1
        print(f"[ia] {feitos}/{len(fila)} (modelo {GMODEL})", flush=True)
        time.sleep(PAUSA_IA)
    return feitos


ETAPAS = {"editais": editais, "pca": pca, "radar": radar}
EXTRAS = {"catalogo": catalogo, "ia": ia}

if __name__ == "__main__":
    modo = sys.argv[1] if len(sys.argv) > 1 else "tudo"
    etapas = list(ETAPAS) if modo == "tudo" else [modo]
    ETAPAS = {**ETAPAS, **EXTRAS}
    falhou = False
    for nome in etapas:
        id_ = log_inicio(nome)
        try:
            n = ETAPAS[nome]()
            log_fim(id_, n, "ok")
            print(f"[{nome}] ok: {n} registros")
        except Exception as e:  # registra e segue para a proxima etapa
            falhou = True
            log_fim(id_, 0, "erro", str(e)[:500])
            print(f"[{nome}] ERRO: {e}", file=sys.stderr)
    sys.exit(1 if falhou else 0)
