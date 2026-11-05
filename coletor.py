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


def perfis_pca():
    r = requests.get(f"{SB}/perfis_busca", params={"ativo": "eq.true"}, headers=HDR, timeout=60)
    r.raise_for_status()
    return [p for p in r.json() if "pca" in (p["fontes"] or [])]


def casa(texto, perfis):
    t = norm(texto)
    return any(
        any(norm(w) in t for w in p["palavras_incluir"])
        and not any(norm(w) in t for w in p["palavras_excluir"])
        for p in perfis
    )


def processar_plano(plano, perfis):
    cnpj, ano = plano["orgao_cnpj"], plano["ano"]
    base = f"{PNCP}/pncp/v1/orgaos/{cnpj}/pca/{ano}"
    sequenciais, pagina = set(), 1
    while True:
        un = get(f"{base}/consolidado/unidades", {"pagina": pagina, "tamanhoPagina": 100}) or []
        sequenciais |= {u["sequencialPca"] for u in un}
        if len(un) < 100:
            break
        pagina += 1
    itens = []
    for seq in sorted(sequenciais):
        pagina = 1
        while True:
            lote = get(f"{base}/{seq}/itens", {"pagina": pagina, "tamanhoPagina": PCA_PAGINA}) or []
            for it in lote:
                texto = " ".join(str(it.get(k) or "") for k in
                                 ("descricao", "grupoContratacaoNome", "classificacaoSuperiorNome"))
                if casa(texto, perfis):
                    itens.append({
                        "plano_id": plano["id"], "sequencial_pca": seq, "numero_item": it.get("numeroItem"),
                        "descricao": it.get("descricao"), "categoria": it.get("categoriaItemPcaNome"),
                        "unidade_medida": it.get("unidadeFornecimento"), "quantidade": it.get("quantidade"),
                        "valor_unitario": it.get("valorUnitario"), "valor_total": it.get("valorTotal"),
                        "data_desejada": it.get("dataDesejada"), "codigo_unidade": it.get("codigoUnidade"),
                        "nome_unidade": it.get("nomeUnidade"),
                        "classificacao_codigo": it.get("classificacaoSuperiorCodigo"),
                        "classificacao_nome": it.get("classificacaoSuperiorNome"),
                        "grupo_contratacao": it.get("grupoContratacaoNome"),
                    })
            if len(lote) < PCA_PAGINA:
                break
            pagina += 1
    return plano, itens


def processar_seguro(plano, perfis):
    try:
        return processar_plano(plano, perfis)
    except RuntimeError as e:
        print(f"[pca] AVISO plano {plano['orgao_cnpj']}/{plano['ano']}: {e}", file=sys.stderr)
        return plano, None


def pca():
    perfis = perfis_pca()
    if not perfis:
        print("nenhum perfil ativo com fonte 'pca'")
        return 0
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
        for plano, itens in ex.map(lambda p: processar_seguro(p, perfis), pendentes):
            if itens is None:
                continue  # falhou: fica pendente para a proxima coleta
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
    return 0


ETAPAS = {"editais": editais, "pca": pca, "radar": radar}

if __name__ == "__main__":
    modo = sys.argv[1] if len(sys.argv) > 1 else "tudo"
    etapas = list(ETAPAS) if modo == "tudo" else [modo]
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
