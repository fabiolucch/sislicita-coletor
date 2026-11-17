# Teste do estágio cnae_catalogo do coletor com respostas simuladas (sem rede). Uso: python3 test/test_cnae_catalogo.py
import os, sys, json
os.environ.setdefault("SUPABASE_URL", "https://x.supabase.co"); os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "k")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import coletor

def falso_get(url, params=None, tentativas=7):
    if "1_consultarFornecedor" in url:
        return {"resultado": [{"cnpj": "11"}, {"cnpj": "22"}, {"cnpj": "33"}, {"cnpj": None}], "totalPaginas": 1}
    if "2_consultarARPItem" in url:
        base = {"11": [("Material", 4548, None), ("Material", 4550, None)], "22": [("Material", 3267, None), ("Serviço", None, 10006)], "33": []}[params["niFornecedor"]]
        return {"resultado": [{"tipoItem": t, "codigoPdm": p, "codigoItem": i, "itemExcluido": False} for t, p, i in base] + [{"tipoItem": "Material", "codigoPdm": 999, "itemExcluido": True}], "totalPaginas": 1}
coletor.get = falso_get
assert sorted(coletor.itens_arp_do_fornecedor("11")) == [("M", "4548"), ("M", "4550")]
assert coletor.itens_arp_do_fornecedor("22") == [("M", "3267"), ("S", "10006")] or sorted(coletor.itens_arp_do_fornecedor("22")) == [("M", "3267"), ("S", "10006")]
assert coletor.itens_arp_do_fornecedor("33") == []
chamadas = []
class R:  # resposta simulada do Supabase
    def __init__(s, j=None, t="1"): s._j, s.text = j, t
    def raise_for_status(s): pass
    def json(s): return s._j
coletor.requests.get = lambda url, **k: R([{"cnae": "4634601", "tentativas": 0}])
coletor.requests.post = lambda url, **k: (chamadas.append((url, json.loads(k["data"]))), R())[1]
coletor.requests.patch = lambda *a, **k: R()
assert coletor.cnae_catalogo() == 1
url, corpo = chamadas[0]
assert url.endswith("/rpc/registrar_cnae_catalogo") and corpo["p_cnae"] == "4634601"
assert corpo["p_amostra"] == 2, corpo          # só fornecedores com atas entram na amostra (33 não tem)
assert {(i["f"], i["t"], i["c"]) for i in corpo["p_itens"]} == {("11", "M", "4548"), ("11", "M", "4550"), ("22", "M", "3267"), ("22", "S", "10006")}
print("OK")
