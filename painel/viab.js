/* EditalVector — calculadora de viabilidade (pura, sem DOM; testada em test/viab.test.js).
 *
 * Convenções
 * - Valores monetários em reais, calculados em centavos inteiros onde há arredondamento (preços unitários),
 *   e os totais saem do preço unitário arredondado × quantidade (unitário e total sempre batem).
 * - Campo não preenchido (null/undefined/'') NÃO é zero: vira pendência. Zero explícito é aceito.
 * - Percentuais em % (ex.: 8.5 = 8,5%).
 * - Margem é sobre a RECEITA (lucro ÷ receita). Markup é sobre o CUSTO ((preço − custo) ÷ custo). São diferentes.
 * - Fórmula de preço (quando as premissas são compatíveis):
 *     preço = custo unitário considerado ÷ (1 − Σ percentuais sobre a receita − margem)
 *   "Custo considerado" = custo direto do item + custos por unidade + rateio dos custos fixos/por lote.
 *   Percentuais sobre a receita = tributos e demais itens informados como % do faturamento (base = preço de venda).
 *   Se o denominador for ≤ 0 a fórmula não se aplica (erro explícito).
 */
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.VIAB = fabrica();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const vazio = v => v === null || v === undefined || v === '' || (typeof v === 'number' && !isFinite(v));
  const num = v => (vazio(v) ? null : Number(v));
  const c2 = v => Math.round(v * 100) / 100;                    // arredondamento monetário comum
  const teto2 = v => Math.ceil(Math.round(v * 1e6) / 1e4) / 100; // arredonda PARA CIMA em centavos (protege a margem)

  const CATEGORIAS = ['Aquisição de mercadorias', 'Execução de serviços', 'Mão de obra e encargos', 'Frete', 'Seguro',
    'Embalagem', 'Armazenamento', 'Instalação', 'Treinamento', 'Assistência e garantia', 'Viagens e deslocamentos',
    'Garantia contratual', 'Despesas administrativas', 'Tributos', 'Custos financeiros', 'Contingências', 'Outros'];
  const BASES = { fixo: 'Valor fixo (rateado)', unidade: 'Por unidade', lote: 'Por lote', pct_receita: '% sobre a receita' };

  // ------------------------------------------------------------------ alvo de uma linha de custo
  function itensDoAlvo(alvo, itens) {
    if (!alvo || alvo.tipo === 'todos' || !alvo.tipo) return itens.map(i => i.n);
    if (alvo.tipo === 'lote') return itens.filter(i => (i.lote || '') === (alvo.ref || '')).map(i => i.n);
    if (alvo.tipo === 'item') return itens.filter(i => String(i.n) === String(alvo.ref)).map(i => i.n);
    return [];
  }

  // pesos de rateio entre itens; devolve frações que somam 1
  function rateio(criterio, alvoItens, itensPorN) {
    const lst = alvoItens.map(n => itensPorN[n]).filter(Boolean);
    if (!lst.length) return {};
    let w;
    if (criterio === 'quantidade') w = lst.map(i => i.q);
    else if (criterio === 'igual') w = lst.map(() => 1);
    else w = lst.map(i => (i.ref > 0 ? i.ref * i.q : i.c * i.q));     // 'valor' (padrão): valor de referência; sem referência, custo
    const s = w.reduce((a, b) => a + b, 0);
    const out = {};
    lst.forEach((i, k) => { out[i.n] = s > 0 ? w[k] / s : 1 / lst.length; });
    return out;
  }

  // ------------------------------------------------------------------ cálculo principal
  /**
   * @param {object} entrada
   *   itens: [{n, descricao, qtd, ref (valor unitário de referência), custo (custo direto unitário), lote, importado_pct}]
   *   custos: [{id, categoria, descricao, base:'fixo'|'unidade'|'lote'|'pct_receita', valor, status, alvo:{tipo,ref}, rateio}]
   *   pct_receita: [{nome, pct, status}]   (tributos etc.)
   *   margem_min, margem_desejada (% sobre a receita), preco_proposto: {n: preço unitário} (opcional)
   *   giro: {prazo_fornecedor, prazo_entrega, prazo_recebimento, atraso, taxa_mensal, parcelas}
   * @param {object} [ajuste] variações de cenário: {custo, frete, qtd, cambio (em %), entrega, receb, atraso (em dias)}
   */
  function calcular(entrada, ajuste) {
    const aj = Object.assign({ custo: 0, frete: 0, qtd: 0, cambio: 0, entrega: 0, receb: 0, atraso: 0 }, ajuste || {});
    const pend = [], avisos = [], erros = [];
    const E = entrada || {};
    const itensIn = (E.itens || []);
    if (!itensIn.length) pend.push('Selecione ao menos um item ou lote para avaliar.');

    const itens = itensIn.map(i => {
      const q0 = num(i.qtd);
      const c0 = num(i.custo);
      const imp = Math.min(Math.max(num(i.importado_pct) || 0, 0), 100) / 100;
      if (q0 === null || q0 <= 0) pend.push(`Item ${i.n}: quantidade não informada.`);
      if (c0 === null) pend.push(`Item ${i.n}: custo direto não informado (vazio não é zero).`);
      const cBase = c0 === null ? 0 : c0;
      // custo direto com variação de custo e câmbio (só sobre a parcela importada)
      const c = cBase * (1 + aj.custo / 100) * (1 + imp * aj.cambio / 100);
      const q = (q0 || 0) * (1 + aj.qtd / 100);
      return { n: i.n, descricao: i.descricao || '', q, ref: num(i.ref) || 0, refInformada: !vazio(i.ref) && Number(i.ref) > 0,
        c, cOk: c0 !== null && q0 !== null && q0 > 0, lote: i.lote || '', adic: 0, fixo: 0, pct: 0, linhas: [] };
    });
    const porN = Object.fromEntries(itens.map(i => [i.n, i]));

    // percentuais sobre a receita (aplicam a todos os itens)
    let pctGlobal = 0;
    (E.pct_receita || []).forEach(p => {
      const v = num(p.pct);
      if (v === null) { pend.push(`${p.nome || 'Percentual sobre a receita'}: percentual não informado.`); return; }
      if (v < 0 || v >= 100) { erros.push(`${p.nome || 'Percentual'}: ${v}% é inválido (use de 0 a 99,99).`); return; }
      pctGlobal += v;
    });
    if (!(E.pct_receita || []).length) pend.push('Informe os tributos sobre a receita do seu regime (pode ser 0 se de fato não houver).');

    // linhas de custo
    const vistos = {};
    (E.custos || []).forEach(l => {
      const v = num(l.valor);
      const alvo = itensDoAlvo(l.alvo, itens);
      const rotulo = `${l.categoria || 'Custo'}${l.descricao ? ' – ' + l.descricao : ''}`;
      if (v === null) { pend.push(`${rotulo}: valor não informado.`); return; }
      if (v < 0) { erros.push(`${rotulo}: valor negativo.`); return; }
      if (!alvo.length) { avisos.push(`${rotulo}: não se aplica a nenhum item selecionado.`); return; }
      // dupla contagem: mesma categoria e base sobre os mesmos itens
      const chave = (l.categoria || '') + '|' + (l.base || '') + '|' + alvo.slice().sort().join(',');
      if (vistos[chave] && l.categoria !== 'Outros') avisos.push(`${l.categoria}: há mais de uma linha igual sobre os mesmos itens; confira se não há dupla contagem.`);
      vistos[chave] = true;
      let fator = 1;
      if (l.categoria === 'Frete') fator = 1 + aj.frete / 100;
      if (l.categoria === 'Aquisição de mercadorias') fator = 1 + aj.custo / 100;
      if (l.base === 'pct_receita') {
        if (v >= 100) { erros.push(`${rotulo}: ${v}% é inválido.`); return; }
        alvo.forEach(n => { porN[n].pct += v; });
      } else if (l.base === 'unidade') {
        alvo.forEach(n => { porN[n].adic += v * fator; porN[n].linhas.push(rotulo); });
      } else if (l.base === 'lote') {
        // valor fixo para CADA lote alcançado, rateado entre os itens daquele lote
        const lotes = {};
        alvo.forEach(n => { (lotes[porN[n].lote || '(sem lote)'] = lotes[porN[n].lote || '(sem lote)'] || []).push(n); });
        Object.values(lotes).forEach(ns => {
          const r = rateio(l.rateio, ns, porN);
          ns.forEach(n => { porN[n].fixo += v * fator * (r[n] || 0); porN[n].linhas.push(rotulo); });
        });
      } else { // fixo
        const r = rateio(l.rateio, alvo, porN);
        alvo.forEach(n => { porN[n].fixo += v * fator * (r[n] || 0); porN[n].linhas.push(rotulo); });
      }
    });

    const mMin = num(E.margem_min), mDes = num(E.margem_desejada);
    if (mMin === null) pend.push('Informe a margem mínima aceitável (sobre a receita).');
    if (mDes === null) pend.push('Informe a margem desejada (sobre a receita).');
    if (mMin !== null && mDes !== null && mDes < mMin) avisos.push('A margem desejada está abaixo da mínima.');

    // por item
    const linhas = itens.map(i => {
      const P = (pctGlobal + i.pct) / 100;
      const cu = i.q > 0 ? i.c + i.adic + i.fixo / i.q : null;      // custo unitário considerado
      const den = m => 1 - P - (m || 0) / 100;
      const out = { n: i.n, descricao: i.descricao, qtd: c2(i.q), ref: i.ref, custo_unit: cu === null ? null : c2(cu),
        pct_receita: c2(P * 100), linhas_custo: [...new Set(i.linhas)] };
      if (cu === null) return Object.assign(out, { ok: false });
      if (den(0) <= 0) { erros.push(`Item ${i.n}: percentuais sobre a receita somam ${c2(P * 100)}%; a fórmula não se aplica.`); return Object.assign(out, { ok: false }); }
      out.preco_equilibrio = teto2(cu / den(0));
      if (mMin !== null) {
        if (den(mMin) <= 0) erros.push(`Item ${i.n}: margem mínima + percentuais ≥ 100%.`);
        else out.preco_min = teto2(cu / den(mMin));
      }
      if (mDes !== null) {
        if (den(mDes) <= 0) erros.push(`Item ${i.n}: margem desejada + percentuais ≥ 100%.`);
        else out.preco_sugerido = teto2(cu / den(mDes));
      }
      const prop = E.preco_proposto && !vazio(E.preco_proposto[i.n]) ? Number(E.preco_proposto[i.n]) : out.preco_sugerido;
      out.preco = prop === undefined ? null : c2(prop);
      if (out.preco !== null && out.preco !== undefined) {
        const receita = c2(out.preco * i.q);
        const custo = c2(cu * i.q);
        const pctValor = c2(receita * P);
        out.receita = receita; out.custo_total = custo; out.pct_valor = pctValor;
        out.lucro = c2(receita - custo - pctValor);
        out.margem = receita > 0 ? out.lucro / receita * 100 : null;
        out.markup = cu > 0 ? (out.preco - cu) / cu * 100 : null;
      }
      if (i.refInformada && out.preco_min !== undefined) {
        out.desconto_max = (1 - out.preco_min / i.ref) * 100;          // negativo = mínimo acima da referência
        if (out.desconto_max < 0) avisos.push(`Item ${i.n}: o preço mínimo (${out.preco_min}) supera o valor de referência (${i.ref}).`);
      }
      out.ok = i.cOk;
      return out;
    });

    const soma = k => c2(linhas.reduce((a, l) => a + (l[k] || 0), 0));
    const tot = {
      receita: soma('receita'), custo: soma('custo_total'), pct_valor: soma('pct_valor'), lucro: soma('lucro'),
      referencia: c2(itens.reduce((a, i) => a + i.ref * i.q, 0)),
      minimo: c2(linhas.reduce((a, l) => a + (l.preco_min || 0) * (l.qtd || 0), 0)),
    };
    tot.margem = tot.receita > 0 ? tot.lucro / tot.receita * 100 : null;
    tot.markup = tot.custo > 0 ? (tot.receita - tot.custo) / tot.custo * 100 : null;   // markup sobre o custo

    const giro = capitalDeGiro(E.giro || {}, tot, aj, pend);
    const incompleta = pend.length > 0 || erros.length > 0;
    return { itens: linhas, total: tot, giro, pendencias: [...new Set(pend)], avisos: [...new Set(avisos)], erros: [...new Set(erros)], incompleta };
  }

  // ------------------------------------------------------------------ capital de giro
  // Linha do tempo em dias. Em cada parcela: o custo é pago ao fornecedor (dia de início da parcela + prazo do fornecedor),
  // a entrega acontece ao fim da parcela, o órgão paga após o prazo de recebimento + atraso, e os percentuais sobre a
  // receita (tributos) são recolhidos no recebimento. Necessidade de caixa = maior saldo negativo acumulado.
  // Custo financeiro = saldo negativo × tempo × taxa (separado da necessidade).
  function capitalDeGiro(g, tot, aj, pend) {
    const req = ['prazo_entrega', 'prazo_recebimento'];
    const falta = req.filter(k => vazio(g[k]));
    if (falta.length) { pend.push('Capital de giro: informe prazo de entrega e prazo de recebimento do órgão.'); return { ok: false }; }
    const E = Math.max(0, Number(g.prazo_entrega) + aj.entrega);
    const Rb = Math.max(0, Number(g.prazo_recebimento) + aj.receb);
    const At = Math.max(0, (num(g.atraso) || 0) + aj.atraso);
    const Fp = Math.max(0, num(g.prazo_fornecedor) || 0);
    const n = Math.max(1, Math.round(num(g.parcelas) || 1));
    const ev = [];
    for (let k = 0; k < n; k++) {
      const ini = E * k / n, fim = E * (k + 1) / n;
      ev.push({ d: ini + Fp, v: -tot.custo / n, o: 'custo' });
      ev.push({ d: fim + Rb + At, v: (tot.receita - tot.pct_valor) / n, o: 'recebimento líquido' });
    }
    ev.sort((a, b) => a.d - b.d || b.v - a.v);   // no mesmo dia, o recebimento entra antes do pagamento
    let saldo = 0, minimo = 0, area = 0, ultimo = 0;
    const serie = [];
    ev.forEach(e => {
      if (saldo < 0) area += -saldo * (e.d - ultimo);
      saldo += e.v; ultimo = e.d;
      minimo = Math.min(minimo, saldo);
      serie.push({ dia: Math.round(e.d), saldo: c2(saldo), evento: e.o });
    });
    const taxa = num(g.taxa_mensal);
    const custoFin = taxa === null ? null : c2(area * taxa / 100 / 30);
    if (taxa === null) pend.push('Capital de giro: taxa de custo do dinheiro não informada (o custo financeiro fica em aberto).');
    const diasExpo = ev.length ? Math.round(ev[ev.length - 1].d - ev[0].d) : 0;
    return { ok: true, necessidade: c2(-minimo) + 0, custo_financeiro: custoFin, dias_exposicao: diasExpo, serie };
  }

  // ------------------------------------------------------------------ cenários e sensibilidade
  const CENARIOS_PADRAO = {
    conservador: { custo: 10, frete: 20, qtd: -20, cambio: 10, entrega: 15, receb: 30, atraso: 30 },
    base: { custo: 0, frete: 0, qtd: 0, cambio: 0, entrega: 0, receb: 0, atraso: 0 },
    otimista: { custo: -5, frete: -10, qtd: 0, cambio: -5, entrega: 0, receb: 0, atraso: 0 },
  };

  function cenarios(entrada, defs) {
    const d = defs || CENARIOS_PADRAO, out = {};
    Object.keys(d).forEach(k => {
      // nos cenários o PREÇO fica fixo (o da proposta base): mede o efeito das premissas sobre o resultado
      const base = calcular(entrada);
      const precos = Object.fromEntries(base.itens.filter(i => i.preco != null).map(i => [i.n, i.preco]));
      const r = calcular(Object.assign({}, entrada, { preco_proposto: precos }), d[k]);
      out[k] = { lucro: r.total.lucro, margem: r.total.margem, receita: r.total.receita, custo: r.total.custo,
        giro: r.giro.ok ? r.giro.necessidade : null, custo_financeiro: r.giro.ok ? r.giro.custo_financeiro : null };
    });
    return out;
  }

  function sensibilidade(entrada) {
    const base = calcular(entrada);
    if (base.total.receita <= 0) return [];
    const precos = Object.fromEntries(base.itens.filter(i => i.preco != null).map(i => [i.n, i.preco]));
    const E2 = Object.assign({}, entrada, { preco_proposto: precos });
    const b = calcular(E2);
    const testes = [
      ['Custo de aquisição +10%', { custo: 10 }], ['Frete +10%', { frete: 10 }], ['Quantidade −10%', { qtd: -10 }],
      ['Câmbio +10% (parcela importada)', { cambio: 10 }], ['Recebimento +15 dias', { receb: 15 }],
      ['Atraso de pagamento +30 dias', { atraso: 30 }], ['Entrega +15 dias', { entrega: 15 }],
    ];
    return testes.map(([nome, a]) => {
      const r = calcular(E2, a);
      return { premissa: nome, d_lucro: c2(r.total.lucro - b.total.lucro),
        d_giro: r.giro.ok && b.giro.ok ? c2(r.giro.necessidade - b.giro.necessidade) : null };
    }).sort((x, y) => Math.abs(y.d_lucro) - Math.abs(x.d_lucro) || Math.abs(y.d_giro || 0) - Math.abs(x.d_giro || 0));
  }

  // recomendação explicada (sem probabilidade de vitória); a decisão é do usuário
  function recomendacao(r, cen, docsPend) {
    if (r.erros.length) return { tipo: 'erro', texto: 'Premissas inconsistentes: ' + r.erros[0] };
    if (r.incompleta) return { tipo: 'incompleta', texto: `Análise incompleta: faltam ${r.pendencias.length} informação(ões) essencial(is). Ex.: ${r.pendencias[0]}` };
    const t = [];
    const acima = r.itens.filter(i => i.desconto_max !== undefined && i.desconto_max < 0).length;
    if (acima) t.push(`${acima} item(ns) com preço mínimo acima do valor de referência`);
    if (cen && cen.conservador && cen.conservador.lucro < 0) t.push('prejuízo no cenário conservador');
    if (docsPend) t.push(`${docsPend} pendência(s) documental(is) a resolver antes da sessão`);
    const m = r.total.margem;
    const base = `Com as premissas informadas, a margem estimada é ${m == null ? '—' : m.toFixed(1).replace('.', ',')}% e a necessidade de caixa ${r.giro.ok ? 'R$ ' + r.giro.necessidade.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : 'não calculada'}.`;
    if (!t.length) return { tipo: 'favoravel', texto: base + ' Não há alerta crítico nas premissas; confirme os valores estimados antes de decidir.' };
    return { tipo: 'atencao', texto: base + ' Pontos de atenção: ' + t.join('; ') + '.' };
  }

  return { calcular, cenarios, sensibilidade, recomendacao, capitalDeGiro, CATEGORIAS, BASES, CENARIOS_PADRAO, _t: { teto2, c2, rateio } };
});
