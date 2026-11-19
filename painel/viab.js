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


  // ==================================================================================================
  // v2 — Análise de viabilidade orientada ao lance (ver docs/viabilidade.md)
  //   Q = quantidade, C = custo total da execução (R$), t = Σ percentuais sobre a mesma receita bruta,
  //   R = preço × Q, lucro = R(1 − t) − C, margem = lucro ÷ R,
  //   equilíbrio = C ÷ (1 − t) ÷ Q, lance mínimo = C ÷ (1 − t − m_min) ÷ Q, alvo = C ÷ (1 − t − m_alvo) ÷ Q,
  //   custo máximo no lance = R(1 − t − m_min), redução necessária = máx(0, C − custo máximo).
  // Pisos arredondados PARA CIMA na precisão do edital; a margem é recalculada com o valor exibido.
  // Campo vazio ≠ zero: vazio vira pendência e marca o cálculo como parcial.
  // ==================================================================================================
  const GRUPOS2 = {
    produto: { nome: 'Produto ou serviço', cats: ['Compra de mercadorias', 'Fabricação', 'Insumos', 'Mão de obra', 'Encargos', 'Benefícios', 'Substituições', 'Equipamentos', 'Subcontratação'] },
    execucao: { nome: 'Execução e entrega', cats: ['Frete', 'Seguro', 'Embalagem', 'Instalação', 'Armazenagem', 'Deslocamento', 'Assistência técnica', 'Despesas com garantia'] },
    indireta: { nome: 'Despesas indiretas', cats: ['Mobilização', 'Administração', 'Custo compartilhado entre itens', 'Garantia contratual', 'Outros'] },
  };
  const BASES2 = { unidade: 'Por unidade fornecida', pedido: 'Por pedido de compra', entrega: 'Por entrega', mes: 'Por mês de contrato',
    contrato: 'Uma vez no contrato', lote: 'Uma vez por lote', pct_receita: '% sobre a venda' };
  const CEN2 = { base: { custo: 0, frete: 0, cambio: 0, qtd: 0, atraso: 0 }, conservador: { custo: 10, frete: 20, cambio: 10, qtd: 0, atraso: 30 } };

  const pot = d => Math.pow(10, d);
  const cima = (v, d = 2) => Math.ceil(Math.round(v * pot(d) * 1e6) / 1e6) / pot(d);   // para cima, imune a 0,1+0,2
  const rd = (v, d = 2) => Math.round(v * pot(d)) / pot(d);

  // ---------------------------------------------------------------- custo direto do item (com unidade de cotação)
  function custoDireto(it, modo, aj, pend) {
    const q0 = num(it.qtd_sim) !== null ? num(it.qtd_sim) : num(it.qtd);
    const q = (q0 || 0) * (1 + (aj.qtd || 0) / 100);
    const fat = (1 + (aj.custo || 0) / 100) * (1 + Math.min(Math.max(num(it.importado_pct) || 0, 0), 100) / 100 * (aj.cambio || 0) / 100);
    const r = { q, q0: q0 || 0, econ: 0, desembolso: 0, sobra: 0, ok: true, origem: '' };
    if (q0 === null || q0 < 0) { pend.push(`Item ${it.n}: quantidade não informada.`); r.ok = false; return r; }
    if (modo === 'rapido') {
      const v = num(it.custo_total_est);
      if (v === null) { pend.push(`Item ${it.n}: informe o custo total estimado (vazio não é zero).`); r.ok = false; return r; }
      // estimativa total: varia proporcionalmente à quantidade (sem diluição de fixos)
      r.econ = r.desembolso = q0 > 0 ? v * fat * q / q0 : 0; r.origem = 'estimativa total'; return r;
    }
    const ct = it.cotacao || {};
    const pe = num(ct.preco_emb), ue = num(ct.unid_por_emb);
    if (pe !== null && ue !== null && ue > 0) {
      const unit = pe / ue * fat;
      const minE = Math.max(0, num(ct.minimo_emb) || 0);
      const emb = q > 0 ? Math.max(Math.ceil(q / ue - 1e-9), minE) : 0;
      r.desembolso = emb * pe * fat; r.sobra = emb * ue - q; r.emb = emb; r.unit = unit;
      r.econ = ct.sobra === 'estoque' ? unit * q : r.desembolso;
      r.origem = `cotação: ${pe} por embalagem de ${ue}`;
      return r;
    }
    const cu = num(it.custo_unit);
    if (cu === null) { pend.push(`Item ${it.n}: informe o custo de compra ou execução por unidade (ou a cotação do fornecedor).`); r.ok = false; return r; }
    r.unit = cu * fat; r.econ = r.desembolso = cu * fat * q; r.origem = 'custo por unidade';
    return r;
  }

  // ---------------------------------------------------------------- monta itens, custos, tributos (sem preço)
  function preparar(E, aj) {
    aj = Object.assign({ custo: 0, frete: 0, cambio: 0, qtd: 0, atraso: 0, entregas_fator: 1 }, aj || {});
    const pend = [], avisos = [], erros = [], memoria = [];
    const modo = E.modo_custo === 'rapido' ? 'rapido' : 'detalhado';
    const op = E.operacao || {};
    const ent0 = num(op.entregas) !== null && Number(op.entregas) >= 1 ? Math.round(Number(op.entregas)) : 1;
    const entregas = Math.max(1, Math.round(ent0 * (aj.entregas_fator || 1)));
    const meses = num(op.meses);
    const itens = (E.itens || []).map(it => {
      const d = custoDireto(it, modo, aj, pend);
      return { n: it.n, descricao: it.descricao || '', unidade: it.unidade || '', lote: it.lote || '', q: d.q, q0: d.q0,
        ref: num(it.ref), teto: num(it.teto), historico: num(it.historico), base_desc: num(it.base_desc),
        direto: d.econ, desembolso: d.desembolso, sobra: d.sobra, emb: d.emb, origem: d.origem, okCusto: d.ok,
        ind: 0, comprometido: 0, linhas: [], ev: [] };   // ev: {quando, valor} para o fluxo de caixa
    });
    if (!itens.length) pend.push('Selecione ao menos um item ou lote para disputar.');
    const porN = Object.fromEntries(itens.map(i => [i.n, i]));
    itens.forEach(i => { if (i.desembolso) i.ev.push({ quando: 'compra', valor: i.desembolso, rot: 'Compra/execução do item ' + i.n }); });

    let t = 0; const tNomes = [];
    const retencoes = [];
    // linhas de custo (só na composição detalhada)
    if (modo === 'detalhado') {
      const vistos = {};
      (E.custos || []).forEach(l => {
        const v = num(l.valor); const rot = `${l.categoria || 'Custo'}${l.descricao ? ' – ' + l.descricao : ''}`;
        if (v === null) { pend.push(`${rot}: valor não informado.`); return; }
        if (v < 0) { erros.push(`${rot}: valor negativo.`); return; }
        const alvo = itensDoAlvo(l.alvo, itens);
        if (!alvo.length) { avisos.push(`${rot}: não se aplica a nenhum item selecionado.`); return; }
        const ch = (l.categoria || '') + '|' + (l.base || '') + '|' + alvo.slice().sort().join(',');
        if (vistos[ch] && l.categoria !== 'Outros') avisos.push(`${l.categoria}: mais de uma linha igual sobre os mesmos itens; confira se não há dupla contagem.`);
        vistos[ch] = true;
        const fator = l.categoria === 'Frete' ? 1 + aj.frete / 100 : 1;
        const comp = l.comprometido === undefined ? ['contrato', 'lote'].includes(l.base) : !!l.comprometido;
        if (l.base === 'pct_receita') {
          if (v >= 100) { erros.push(`${rot}: ${v}% é inválido.`); return; }
          t += v / 100; tNomes.push(`${rot} ${v}%`); return;
        }
        let total = 0, quando = 'inicio', multip = '';
        const alocar = (ns, valor, crit) => { const r = rateio(crit || l.rateio, ns, porN); ns.forEach(n => {
          const x = valor * (r[n] || 0); porN[n].ind += x; porN[n].linhas.push(rot); if (comp) porN[n].comprometido += x;
          porN[n].ev.push({ quando, valor: x, rot }); }); };
        if (l.base === 'unidade') {
          quando = 'entrega';
          alvo.forEach(n => { const x = v * fator * porN[n].q; porN[n].ind += x; porN[n].linhas.push(rot); porN[n].ev.push({ quando, valor: x, rot }); if (comp) porN[n].comprometido += x; });
          return;
        }
        if (l.base === 'pedido' || l.base === 'entrega') { total = v * fator * entregas; quando = l.base === 'pedido' ? 'compra' : 'entrega'; multip = `× ${entregas} ${l.base === 'pedido' ? 'pedido(s)' : 'entrega(s)'}`; }
        else if (l.base === 'mes') {
          if (meses === null) { pend.push(`${rot}: informe a duração do contrato em meses.`); return; }
          total = v * fator * meses; quando = 'mensal'; multip = `× ${meses} mês(es)`;
        } else if (l.base === 'lote') {
          const lotes = {}; alvo.forEach(n => { (lotes[porN[n].lote || '(sem lote)'] = lotes[porN[n].lote || '(sem lote)'] || []).push(n); });
          Object.values(lotes).forEach(ns => alocar(ns, v * fator)); quando = 'inicio';
          memoria.push(`${rot}: ${brl2(v * fator)} por lote, rateado ${RATEIO_TXT[l.rateio || 'valor']}.`); return;
        } else { total = v * fator; quando = 'inicio'; }
        alocar(alvo, total);
        memoria.push(`${rot}: ${brl2(v * fator)} ${BASES2[l.base] ? BASES2[l.base].toLowerCase() : ''} ${multip} = ${brl2(total)}${alvo.length > 1 ? `, rateado ${RATEIO_TXT[l.rateio || 'valor']} e contado uma vez` : ''}.`);
      });
    } else if ((E.custos || []).length) {
      avisos.push('Estimativa rápida em uso: as linhas da composição detalhada ficam guardadas, mas não entram no cálculo.');
    }

    // tributos e taxas
    (E.tributos || []).forEach(x => {
      const v = num(x.valor); const rot = x.nome || 'Tributo';
      if (v === null) { pend.push(`${rot}: alíquota ou valor não informado.`); return; }
      if (v < 0) { erros.push(`${rot}: valor negativo.`); return; }
      const tipo = x.tipo || 'pct', base = x.base || 'receita';
      if (x.natureza === 'retencao') {
        if (tipo !== 'pct') { erros.push(`${rot}: retenção deve ser percentual sobre o valor faturado.`); return; }
        retencoes.push({ rot, pct: v / 100, dias: num(x.compensa_dias) }); return;
      }
      if (tipo === 'pct' && base === 'receita') {
        if (v >= 100) { erros.push(`${rot}: ${v}% é inválido.`); return; }
        t += v / 100; tNomes.push(`${rot} ${v}%`); return;
      }
      if (tipo === 'pct' && base === 'custo') {
        itens.forEach(i => { const z = i.direto * v / 100; i.ind += z; i.ev.push({ quando: 'compra', valor: z, rot }); });
        memoria.push(`${rot}: ${v}% sobre o custo de compra.`); return;
      }
      if (tipo === 'unit') { itens.forEach(i => { const z = v * i.q; i.ind += z; i.ev.push({ quando: 'receb', valor: z, rot }); }); memoria.push(`${rot}: ${brl2(v)} por unidade.`); return; }
      // fixo: rateado pelo valor
      const r = rateio('valor', itens.map(i => i.n), porN);
      itens.forEach(i => { const z = v * (r[i.n] || 0); i.ind += z; i.ev.push({ quando: 'receb', valor: z, rot }); });
      memoria.push(`${rot}: ${brl2(v)} fixo, rateado pelo valor.`);
    });
    if (!(E.tributos || []).length && !(E.pend_extra || []).length) pend.push('Informe os tributos e taxas sobre a venda (pode ser 0 se de fato não houver).');

    // financiamento: só juros e tarifas entram no custo econômico
    const fin = op.financiamento || {};
    const finJT = (num(fin.juros) || 0) + (num(fin.tarifas) || 0);
    if (num(fin.valor) > 0 && finJT > 0) {
      const r = rateio('valor', itens.map(i => i.n), porN);
      itens.forEach(i => { i.ind += finJT * (r[i.n] || 0); });
      memoria.push(`Financiamento: juros e tarifas de ${brl2(finJT)} entram no custo; liberação e amortização só no caixa.`);
    }
    const mMin = num(E.margem_min), mAlvo = num(E.margem_alvo);
    if (mMin === null) pend.push('Informe a margem mínima aceitável (sobre a venda).');
    if (mAlvo === null) pend.push('Informe a margem-alvo (sobre a venda).');
    if (mMin !== null && mAlvo !== null && mAlvo < mMin) avisos.push('A margem-alvo está abaixo da margem mínima.');
    if (t >= 1) erros.push(`Percentuais sobre a venda somam ${rd(t * 100, 2)}%: a fórmula não se aplica.`);
    if (mMin !== null && 1 - t - mMin / 100 <= 0) erros.push('Margem mínima + percentuais sobre a venda ≥ 100%.');
    if (mAlvo !== null && 1 - t - mAlvo / 100 <= 0) erros.push('Margem-alvo + percentuais sobre a venda ≥ 100%.');
    itens.forEach(i => { i.custo = i.direto + i.ind; });
    return { itens, porN, t, tNomes, retencoes, mMin: mMin === null ? null : mMin / 100, mAlvo: mAlvo === null ? null : mAlvo / 100,
      pend, avisos, erros, memoria, modo, entregas, meses, aj, op };
  }
  const RATEIO_TXT = { valor: 'pelo valor estimado', quantidade: 'pela quantidade', igual: 'igualmente' };
  const brl2 = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ---------------------------------------------------------------- unidades de disputa
  function unidades(E, itens) {
    const j = E.julgamento || 'item';
    const u = [];
    if (j === 'item') itens.forEach(i => u.push({ id: 'i' + i.n, nome: 'Item ' + i.n, tipo: 'item', itens: [i.n] }));
    else {
      const g = {};
      itens.forEach(i => { const k = i.lote || (j === 'desconto' ? 'Global' : 'Item ' + i.n); (g[k] = g[k] || []).push(i.n); });
      Object.entries(g).forEach(([k, ns]) => u.push({ id: 'l' + k, nome: /^Item |^Global$/.test(k) ? k : 'Lote ' + k, tipo: j === 'desconto' ? 'desconto' : (ns.length > 1 || !/^Item /.test(k) ? 'lote' : 'item'), itens: ns }));
    }
    if (u.length > 1) u.unshift({ id: 'todos', nome: 'Todos os selecionados', tipo: j === 'desconto' ? 'desconto' : 'consolidado', itens: itens.map(i => i.n) });
    return u;
  }

  // ---------------------------------------------------------------- fluxo de caixa de uma unidade
  // Dia 0 = assinatura/empenho. Pedido k em k × intervalo; pagamento ao fornecedor = pedido + prazo do fornecedor;
  // entrega = pedido + prazo de entrega; recebimento = entrega + faturamento + prazo do órgão + atraso.
  // Tributos devidos são recolhidos no recebimento + dias informados; retenções saem do recebimento e voltam na compensação.
  function fluxo(prep, ns, R, extraCusto) {
    const op = prep.op, aj = prep.aj;
    const falta = [];
    if (vazio(op.prazo_fornecedor)) falta.push('prazo para pagar o fornecedor');
    if (vazio(op.prazo_entrega)) falta.push('prazo de entrega');
    if (vazio(op.prazo_recebimento)) falta.push('prazo de pagamento do órgão');
    if (falta.length) return { ok: false, falta };
    const N = prep.entregas;
    const inter = num(op.intervalo) !== null ? Number(op.intervalo) : (prep.meses ? prep.meses * 30 / Math.max(1, N) : 30);
    const Pf = Number(op.prazo_fornecedor), Pe = Number(op.prazo_entrega), Pr = Number(op.prazo_recebimento);
    const Pfat = num(op.prazo_faturamento) || 0, At = Math.max(0, (num(op.atraso) || 0) + (aj.atraso || 0));
    const Dt = num(op.dias_tributo) || 0;
    const ev = [];
    const add = (d, v, rot, tipo) => { if (Math.abs(v) > 1e-9) ev.push({ d: Math.max(0, d), v, rot, tipo: tipo || 'op' }); };
    const its = ns.map(n => prep.porN[n]);
    its.forEach(i => i.ev.forEach(e => {
      if (e.quando === 'inicio') add(0, -e.valor, e.rot);
      else if (e.quando === 'mensal') { const m = Math.max(1, Math.round(prep.meses || 1)); for (let k = 1; k <= m; k++) add(k * 30, -e.valor / m, e.rot); }
      else if (N > 0) for (let k = 0; k < N; k++) {
        const ped = k * inter;
        const d = e.quando === 'compra' ? ped + Pf : e.quando === 'entrega' ? ped + Pe : ped + Pe + Pfat + Pr + At;
        add(d, -e.valor / N, e.rot);
      }
    }));
    if (extraCusto) add(0, -extraCusto, 'Custo financeiro do capital de giro');
    if (N > 0 && R > 0) for (let k = 0; k < N; k++) {
      const ped = k * inter, rec = ped + Pe + Pfat + Pr + At, parc = R / N;
      add(rec, parc, 'Recebimento ' + (k + 1) + '/' + N);
      add(rec + Dt, -parc * prep.t, 'Tributos e percentuais sobre a venda');
      prep.retencoes.forEach(x => { add(rec, -parc * x.pct, 'Retenção: ' + x.rot); if (x.dias !== null) add(rec + x.dias, parc * x.pct, 'Compensação: ' + x.rot); });
    }
    const cau = op.caucao || {};
    if (num(cau.valor) > 0) { add(num(cau.dia) || 0, -Number(cau.valor), 'Caução (saída)'); if (num(cau.devolucao) !== null) add(Number(cau.devolucao), Number(cau.valor), 'Caução (devolução)'); }
    const fin = op.financiamento || {};
    if (num(fin.valor) > 0) {
      add(num(fin.dia) || 0, Number(fin.valor), 'Financiamento (liberação)', 'fin');
      if (num(fin.quitacao) !== null) add(Number(fin.quitacao), -(Number(fin.valor) + (num(fin.juros) || 0) + (num(fin.tarifas) || 0)), 'Financiamento (amortização, juros e tarifas)', 'fin');
    }
    ev.sort((a, b) => a.d - b.d || b.v - a.v);
    const caixa = num(op.caixa), cred = num(op.credito) || 0, credDia = num(op.credito_dia) || 0;
    let so = 0, sf = 0, min = 0, diaMin = 0, maxFalta = 0, diaFalta = null, area = 0, ult = 0;
    const serie = [];
    ev.forEach(e => {
      if (so < 0) area += -so * (e.d - ult); ult = e.d;
      if (e.tipo === 'fin') sf += e.v; else so += e.v;
      if (so < min - 1e-9) { min = so; diaMin = e.d; }
      const disp = (caixa || 0) + (e.d >= credDia ? cred : 0) + sf;
      const f = -(so + disp);
      if (f > maxFalta + 1e-9) { maxFalta = f; diaFalta = e.d; }
      serie.push({ dia: Math.round(e.d), evento: e.rot, valor: rd(e.v), saldo: rd(so), disponivel: rd(so + disp) });
    });
    const taxa = num(op.taxa_mensal);
    return { ok: true, capital: rd(-min) + 0, dia: Math.round(diaMin), falta: caixa === null ? null : rd(maxFalta), dia_falta: diaFalta === null ? null : Math.round(diaFalta),
      caixa_informado: caixa !== null, custo_giro: taxa === null ? null : rd(area * taxa / 100 / 30), serie };
  }

  // ---------------------------------------------------------------- resultado de uma unidade de disputa
  function resultadoUnidade(prep, u, lanceIn, E) {
    const prec = num(E.precisao) !== null ? Math.max(0, Math.min(4, Number(E.precisao))) : 2;
    const its = u.itens.map(n => prep.porN[n]).filter(Boolean);
    const Q = its.reduce((a, i) => a + i.q, 0);
    const C0 = its.reduce((a, i) => a + i.custo, 0);
    const t = prep.t, mMin = prep.mMin, mAlvo = prep.mAlvo;
    const unit = u.tipo === 'item';
    const ok = its.length && its.every(i => i.okCusto) && !prep.erros.length;
    const out = { id: u.id, nome: u.nome, tipo: u.tipo, itens: u.itens, Q: rd(Q, 4), C: rd(C0), t, unit, unidade: unit ? its[0].unidade : '', parcial: !ok || prep.pend.length > 0, aproximacao: false };
    if (!its.length || Q <= 0) return Object.assign(out, { vazio: true });
    // custo financeiro do giro no custo (opcional): depende do lance → recalcula em cada preço
    const op = prep.op;
    const incluirGiro = op.incluir_custo_giro && num(op.taxa_mensal) !== null;
    const custoEm = R => { if (!incluirGiro) return C0; const f = fluxo(prep, u.itens, R); return f.ok && f.custo_giro !== null ? C0 + f.custo_giro : C0; };
    const piso = m => {
      const den = 1 - t - m; if (den <= 0) return null;
      let R = C0 / den;
      if (incluirGiro) { for (let k = 0; k < 30; k++) { const R2 = custoEm(R) / den; if (Math.abs(R2 - R) < 0.005) { R = R2; break; } R = R2; } out.aproximacao = true; }
      return unit ? cima(R / Q, prec) : cima(R, 2);
    };
    const tot = p => unit ? rd(p * Q) : p;
    out.equilibrio = piso(0);
    out.minimo = mMin === null ? null : piso(mMin);
    out.alvo = mAlvo === null ? null : piso(mAlvo);
    ['equilibrio', 'minimo', 'alvo'].forEach(k => { if (out[k] != null) out[k + '_total'] = tot(out[k]); });
    if (out.minimo_total != null) { const Cm = custoEm(out.minimo_total); out.margem_no_minimo = (out.minimo_total * (1 - t) - Cm) / out.minimo_total; }
    // referências do edital e histórico (totais só quando todos os itens têm o dado)
    const soma = k => its.every(i => i[k] != null && i[k] > 0) ? rd(its.reduce((a, i) => a + i[k] * i.q, 0)) : null;
    out.ref_total = soma('ref'); out.teto_total = soma('teto'); out.hist_total = soma('historico');
    if (unit) { out.ref = its[0].ref; out.teto = its[0].teto; out.historico = its[0].historico; }
    // base para maior desconto
    if (u.tipo === 'desconto') {
      out.base_desc = its.every(i => (i.base_desc ?? i.ref) > 0) ? rd(its.reduce((a, i) => a + (i.base_desc ?? i.ref) * i.q, 0)) : null;
      if (out.base_desc && out.minimo_total != null) out.desconto_max = Math.max(0, Math.floor((1 - out.minimo_total / out.base_desc) * 1e4) / 1e4);
      if (out.base_desc && out.equilibrio_total != null) out.desconto_equilibrio = Math.floor((1 - out.equilibrio_total / out.base_desc) * 1e4) / 1e4;
    }
    // lance simulado
    let R = null, lanceUnit = null, lanceDesc = null;
    const L = lanceIn || {};
    if (u.tipo === 'desconto') {
      const d = num(L.desconto);
      if (d !== null && out.base_desc) { lanceDesc = d / 100; R = rd(out.base_desc * (1 - lanceDesc)); }
      else if (out.alvo_total != null && out.base_desc) { R = out.alvo_total; lanceDesc = 1 - R / out.base_desc; out.lance_padrao = true; }
    } else if (unit) {
      lanceUnit = num(L.valor) !== null ? Number(L.valor) : out.alvo;
      if (num(L.valor) === null) out.lance_padrao = true;
      if (lanceUnit != null) R = rd(lanceUnit * Q);
    } else {
      // lote/consolidado: valor global ou composição manual por item
      const man = L.itens && its.every(i => num(L.itens[i.n]) !== null);
      if (man) { R = rd(its.reduce((a, i) => a + Number(L.itens[i.n]) * i.q, 0)); out.composicao_manual = true; }
      else if (num(L.valor) !== null) R = Number(L.valor);
      else if (out.alvo_total != null) { R = out.alvo_total; out.lance_padrao = true; }
    }
    if (R != null && R > 0) {
      const C = custoEm(R);
      const lucro = rd(R * (1 - t) - C);
      const custoMax = mMin === null ? null : rd(R * (1 - t - mMin));
      out.lance = { R, unit: lanceUnit, desconto: lanceDesc, lucro, margem: lucro / R, custo: rd(C),
        custo_max: custoMax, reducao: custoMax === null ? null : rd(Math.max(0, C - custoMax)),
        folga: out.minimo_total == null ? null : rd(R - out.minimo_total),
        folga_unit: unit && out.minimo != null ? rd(lanceUnit - out.minimo, prec) : null,
        abaixo_equilibrio: out.equilibrio_total != null && R < out.equilibrio_total };
      out.lance.folga_pct = out.lance.folga === null ? null : out.lance.folga / R;
      if (u.tipo === 'desconto' && out.desconto_max != null) out.lance.folga_desc = out.desconto_max - lanceDesc;
      // composição dos unitários do lote (proporcional ao valor estimado, ou manual)
      if (!unit) {
        const w = its.map(i => (i.ref > 0 ? i.ref : (i.custo / Math.max(i.q, 1e-9))) * i.q), sw = w.reduce((a, b) => a + b, 0) || 1;
        out.composicao = its.map((i, k) => {
          const p = out.composicao_manual ? Number(L.itens[i.n]) : (i.q > 0 ? rd(R * w[k] / sw / i.q, prec) : null);
          return { n: i.n, q: i.q, preco: p, teto: i.teto, acima_teto: i.teto != null && p != null && p > i.teto + 1e-9, custo: rd(i.custo) };
        });
        out.composicao_total = rd(out.composicao.reduce((a, c) => a + (c.preco || 0) * c.q, 0));
      }
    }
    // compatibilidade com o teto confirmado
    if (out.teto_total != null && mMin !== null) {
      const Cmax = rd(out.teto_total * (1 - t - mMin));
      out.teto_reducao = rd(Math.max(0, custoEm(out.teto_total) - Cmax));
      out.teto_ok = out.minimo_total != null && out.minimo_total <= out.teto_total + 1e-9;
    }
    // se precisasse chegar ao preço histórico
    if (out.hist_total != null) {
      const Rh = out.hist_total, Ch = custoEm(Rh), lh = rd(Rh * (1 - t) - Ch);
      out.hist = { R: Rh, lucro: lh, margem: lh / Rh, reducao: mMin === null ? null : rd(Math.max(0, Ch - Rh * (1 - t - mMin))) };
    }
    // caixa no lance simulado
    out.caixa = R != null && R > 0 ? fluxo(prep, u.itens, R) : { ok: false, falta: ['lance para simular'] };
    return out;
  }

  // ---------------------------------------------------------------- frases do resumo (determinísticas)
  const fR = v => brl2(v);
  const fP = (v, d = 2) => (v * 100).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }) + '%';
  function frases(r, mMin) {
    const f = {};
    const L = r.lance;
    if (L) {
      const quanto = r.unit ? `A ${fR(L.unit)} por ${r.unidade || 'unidade'}` : r.tipo === 'desconto' ? `Com desconto de ${fP(L.desconto)} (${fR(L.R)})` : `A ${fR(L.R)} no total`;
      f.margem = L.lucro >= 0 ? `${quanto}, você lucra ${fR(L.lucro)}, com margem de ${fP(L.margem)}.${mMin != null ? ` Sua margem mínima é de ${fP(mMin, 0)}.` : ''}`
        : `${quanto}, você tem prejuízo de ${fR(-L.lucro)} (margem de ${fP(L.margem)}).`;
      if (L.folga != null) {
        if (L.folga > 0) f.limite = r.tipo === 'desconto' ? `Você ainda pode aumentar o desconto em ${fP(L.folga_desc)} (até ${fP(r.desconto_max)}) sem ficar abaixo da margem mínima.`
          : `Você ainda pode baixar ${r.unit ? fR(L.folga_unit) + ' por ' + (r.unidade || 'unidade') + ' (' + fR(L.folga) + ' no total)' : fR(L.folga)}, ou ${fP(L.folga_pct)} do lance, sem ficar abaixo da margem mínima. Seu limite é ${r.unit ? fR(r.minimo) + ' por ' + (r.unidade || 'unidade') : fR(r.minimo_total)}.`;
        else if (L.abaixo_equilibrio) f.limite = `Este lance está abaixo do preço de equilíbrio: prejuízo de ${fR(-L.lucro)}. Não baixe mais; o limite pela margem mínima é ${r.unit ? fR(r.minimo) + ' por ' + (r.unidade || 'unidade') : fR(r.minimo_total)}.`;
        else f.limite = `Este lance já está abaixo do seu limite (${r.unit ? fR(r.minimo) + ' por ' + (r.unidade || 'unidade') : fR(r.minimo_total)}). Para manter a margem mínima neste preço, reduza o custo em ${fR(L.reducao)}.`;
      }
    }
    if (r.caixa && r.caixa.ok) {
      if (r.caixa.falta == null) f.caixa = `Para executar este cenário você precisa de ${fR(r.caixa.capital)} de capital de giro (pico no dia ${r.caixa.dia}). Informe o caixa disponível para ver se falta dinheiro.`;
      else if (r.caixa.falta > 0) f.caixa = `Para executar este cenário até o primeiro recebimento, faltam ${fR(r.caixa.falta)} (capital de giro necessário: ${fR(r.caixa.capital)}, pico no dia ${r.caixa.dia_falta}).`;
      else f.caixa = `O caixa e o crédito informados cobrem o capital de giro necessário de ${fR(r.caixa.capital)}.`;
    } else if (r.caixa && r.caixa.falta) f.caixa = `Capital de giro pendente: informe ${r.caixa.falta.join(', ')}.`;
    if (r.teto_total != null && mMin != null) {
      f.edital = r.teto_reducao > 0 ? `Para ofertar dentro do teto e manter a margem mínima de ${fP(mMin, 0)}, você precisa reduzir o custo ${r.unit ? 'do item' : 'do lote'} em ${fR(r.teto_reducao)}.`
        : `Seu lance mínimo (${r.unit ? fR(r.minimo) : fR(r.minimo_total)}) cabe no teto confirmado (${r.unit ? fR(r.teto) : fR(r.teto_total)}).`;
    } else if (r.ref_total != null && r.minimo_total != null) {
      f.edital = r.minimo_total > r.ref_total ? `Seu lance mínimo fica ${fR(r.minimo_total - r.ref_total)} acima do valor estimado do órgão; confirme no edital se o estimado é o teto de aceitabilidade.`
        : `Seu lance mínimo fica abaixo do valor estimado do órgão. O teto de aceitabilidade ainda não foi confirmado no edital.`;
    }
    if (r.hist) f.historico = `Se precisasse chegar ao preço histórico (${fR(r.hist.R)}), seu ${r.hist.lucro >= 0 ? 'lucro seria ' + fR(r.hist.lucro) : 'prejuízo seria ' + fR(-r.hist.lucro)} (margem ${fP(r.hist.margem)})${r.hist.reducao > 0 ? `; para manter a margem mínima seria preciso reduzir o custo em ${fR(r.hist.reducao)}` : ''}.`;
    return f;
  }

  // ---------------------------------------------------------------- análise completa
  function analisar(E, opcoes) {
    const o = opcoes || {};
    const prep = preparar(E, o.ajuste);
    const us = unidades(E, prep.itens);
    const lances = E.lances || {};
    const res = us.map(u => { const r = resultadoUnidade(prep, u, lances[u.id], E); r.frases = frases(r, prep.mMin); return r; });
    const avisos = [...prep.avisos];
    res.forEach(r => {
      if (r.composicao) r.composicao.filter(c => c.acima_teto).forEach(c => avisos.push(`${r.nome}: item ${c.n} ficaria acima do teto unitário confirmado (${brl2(c.teto)}). Ajuste a composição.`));
      if (r.aproximacao) avisos.push(`${r.nome}: custo financeiro do giro incluído no custo; pisos calculados por aproximação sucessiva (o custo depende do lance).`);
      if (r.lance && r.lance_padrao) {} // lance padrão = preço-alvo
      if (r.minimo != null && r.teto != null && r.minimo > r.teto) avisos.push(`${r.nome}: lance mínimo acima do teto confirmado.`);
    });
    prep.itens.filter(i => i.sobra > 0).forEach(i => avisos.push(`Item ${i.n}: a compra por embalagem deixa sobra de ${rd(i.sobra, 2)} unidade(s); ${E.itens.find(x => x.n === i.n).cotacao.sobra === 'estoque' ? 'a sobra fica em estoque (desembolso no caixa, fora do custo)' : 'o custo da sobra entra no custo do item'}.`));
    const pend = [...new Set([...(E.pend_extra || []), ...prep.pend])];
    return { unidades: res, pendencias: pend, avisos: [...new Set(avisos)], erros: [...new Set(prep.erros)], memoria: prep.memoria, t: prep.t,
      tNomes: prep.tNomes, mMin: prep.mMin, mAlvo: prep.mAlvo, itens: prep.itens.map(i => ({ n: i.n, q: i.q, direto: rd(i.direto), indireto: rd(i.ind), custo: rd(i.custo), desembolso: rd(i.desembolso), sobra: i.sobra, emb: i.emb, origem: i.origem })),
      parcial: pend.length > 0 || prep.erros.length > 0, modo: prep.modo };
  }

  // cenários: o preço simulado fica fixo por unidade (unitário ou proporcional à quantidade)
  function cenarios2(E, uid, defs) {
    const base = analisar(E); const ub = base.unidades.find(x => x.id === uid) || base.unidades[0];
    if (!ub || !ub.lance) return null;
    const precoUnit = ub.lance.R / ub.Q;
    const roda = aj => {
      const r = analisar(Object.assign({}, E, { lances: {} }), { ajuste: aj });
      const u = r.unidades.find(x => x.id === ub.id); if (!u || u.vazio) return { vazio: true, comprometido: comprometidos(E, aj) };
      const E2 = Object.assign({}, E, { lances: { [ub.id]: u.tipo === 'desconto' ? { desconto: ub.lance.desconto * 100 } : u.unit ? { valor: ub.lance.unit } : { valor: rd(precoUnit * u.Q) } } });
      const r2 = analisar(E2, { ajuste: aj }).unidades.find(x => x.id === ub.id);
      return { minimo: r2.minimo, minimo_total: r2.minimo_total, lucro: r2.lance && r2.lance.lucro, margem: r2.lance && r2.lance.margem, R: r2.lance && r2.lance.R,
        capital: r2.caixa.ok ? r2.caixa.capital : null, falta: r2.caixa.ok ? r2.caixa.falta : null, Q: r2.Q };
    };
    const out = {};
    Object.entries(defs || E.cenarios || CEN2).forEach(([k, aj]) => { out[k] = roda(aj); });
    if (E.srp) {
      const S = E.srp_cfg || {};
      const prov = num(S.provavel_pct) !== null ? Number(S.provavel_pct) : null;
      out.srp_maxima = roda({ qtd: 0 });
      if (prov !== null) { out.srp_provavel = roda({ qtd: prov - 100 }); out.srp_menores = roda({ qtd: prov - 100, entregas_fator: Math.max(1, num(S.fator_pedidos) || 2) }); }
      const c = comprometidos(E, {});
      out.srp_sem_pedidos = { vazio: true, comprometido: c.custo, caixa: -c.caixa, linhas: c.linhas };
    }
    return out;
  }
  // custos que a empresa assume mesmo sem nenhum pedido (marcados como comprometidos) + caução
  function comprometidos(E) {
    const linhas = [];
    let custo = 0;
    if (E.modo_custo !== 'rapido') (E.custos || []).forEach(l => {
      const comp = l.comprometido === undefined ? ['contrato', 'lote'].includes(l.base) : !!l.comprometido;
      const v = num(l.valor); if (!comp || v === null || l.base === 'pct_receita' || l.base === 'unidade' || l.base === 'pedido' || l.base === 'entrega') return;
      const tot = l.base === 'mes' ? v * (num((E.operacao || {}).meses) || 0) : v;
      custo += tot; linhas.push(`${l.categoria}${l.descricao ? ' – ' + l.descricao : ''}: ${brl2(tot)}`);
    });
    (E.tributos || []).forEach(x => { if (x.tipo === 'fixo' && num(x.valor)) { custo += Number(x.valor); linhas.push(`${x.nome}: ${brl2(x.valor)}`); } });
    const cau = num(((E.operacao || {}).caucao || {}).valor) || 0;
    if (cau) linhas.push(`Caução (recuperável): ${brl2(cau)}`);
    return { custo: rd(custo), caixa: rd(custo + cau), linhas };
  }


  // ==================================================================================================
  // Tributação automática a partir do perfil da empresa (regime pelo CNPJ, anexo pelo CNAE, faixa escolhida)
  // Simples: alíquota efetiva = (RBT12 × alíquota nominal − parcela a deduzir) ÷ RBT12 (LC 123/2006, redação LC 155/2016).
  // Só com a faixa (sem o valor exato), usa o teto da faixa: é a alíquota mais alta possível naquela faixa (conservador).
  // ==================================================================================================
  const FAIXAS = [180000, 360000, 720000, 1800000, 3600000, 4800000];
  const SIMPLES = {
    I: [[.04, 0], [.073, 5940], [.095, 13860], [.107, 22500], [.143, 87300], [.19, 378000]],
    II: [[.045, 0], [.078, 5940], [.10, 13860], [.112, 22500], [.147, 85500], [.30, 720000]],
    III: [[.06, 0], [.112, 9360], [.135, 17640], [.16, 35640], [.21, 125640], [.33, 648000]],
    IV: [[.045, 0], [.09, 8100], [.102, 12420], [.14, 39780], [.22, 183780], [.33, 828000]],
    V: [[.155, 0], [.18, 4500], [.195, 9900], [.205, 17100], [.23, 62100], [.305, 540000]],
  };
  const ANEXO_TXT = { I: 'Anexo I · comércio', II: 'Anexo II · indústria', III: 'Anexo III · serviços', IV: 'Anexo IV · serviços (INSS patronal fora do DAS)', V: 'Anexo V · serviços (Fator R)' };
  const FAIXA_TXT = ['até R$ 180 mil', 'de R$ 180 mil a R$ 360 mil', 'de R$ 360 mil a R$ 720 mil', 'de R$ 720 mil a R$ 1,8 milhão', 'de R$ 1,8 milhão a R$ 3,6 milhões', 'de R$ 3,6 milhões a R$ 4,8 milhões'];
  function faixaDe(rbt12) { for (let k = 0; k < FAIXAS.length; k++) if (rbt12 <= FAIXAS[k]) return k + 1; return null; }
  function aliqSimples(anexo, rbt12) {
    const f = faixaDe(rbt12); const T = SIMPLES[anexo]; if (!f || !T || !(rbt12 > 0)) return null;
    const [al, pd] = T[f - 1]; return (rbt12 * al - pd) / rbt12;
  }
  function faixaSimples(anexo, f) {
    const T = SIMPLES[anexo]; if (!T || !(f >= 1 && f <= 6)) return null;
    const lo = f === 1 ? 1 : FAIXAS[f - 2] + 0.01, hi = FAIXAS[f - 1];
    return { min: f === 1 ? T[0][0] : aliqSimples(anexo, lo), max: aliqSimples(anexo, hi), nominal: T[f - 1][0], deduzir: T[f - 1][1] };
  }
  // anexo provável pelo CNAE (divisão/classe); devolve o motivo para o usuário conferir
  function anexoPorCnae(cnae) {
    const c = String(cnae || '').replace(/\D/g, ''); if (c.length < 4) return null;
    const d = Number(c.slice(0, 2)), c4 = c.slice(0, 4);
    if (d >= 45 && d <= 47) return { anexo: 'I', motivo: 'CNAE de comércio (revenda de mercadorias).' };
    if (d >= 5 && d <= 33) return { anexo: 'II', motivo: 'CNAE de indústria (fabricação ou extração).' };
    if (d >= 41 && d <= 43) return { anexo: 'IV', motivo: 'Construção civil e obras: Anexo IV (INSS patronal pago à parte).' };
    if (['8011', '8012', '8020', '8121', '8122', '8129', '6911'].includes(c4)) return { anexo: 'IV', motivo: 'Vigilância, limpeza ou advocacia: Anexo IV.' };
    if (d === 62 || d === 63 && c4 !== '6311' || ['7111', '7112', '7119', '7020', '7311', '7319', '7410', '7490', '8630', '8640', '8650', '8660'].includes(c4)) return { anexo: 'V', motivo: 'Serviço técnico/intelectual: Anexo V, ou Anexo III se a folha de pagamento for ≥ 28% da receita (Fator R).', fator_r: true };
    if (d >= 49) return { anexo: 'III', motivo: 'Prestação de serviços em geral: Anexo III.' };
    return null;
  }
  const ATIV = { I: 'comercio', II: 'industria', III: 'servico', IV: 'servico', V: 'servico' };
  // gera as linhas de tributos da análise a partir do perfil da empresa
  function tributacao(T, ctx) {
    T = T || {}; ctx = ctx || {};
    const out = { tributos: [], pend: [], notas: [], resumo: '' };
    const reg = T.regime;
    const lin = (nome, v, extra) => out.tributos.push(Object.assign({ nome, tipo: 'pct', base: 'receita', valor: v, natureza: 'devido', status: 'estimado', auto: true }, extra || {}));
    if (!reg) { out.pend.push('Escolha o regime tributário em Minha empresa › Dados (o CNPJ costuma trazer).'); out.resumo = 'Regime tributário não definido'; return out; }
    if (reg === 'mei') {
      lin('MEI: DAS fixo mensal (não varia com a venda)', 0);
      out.resumo = 'MEI · DAS fixo, sem tributo proporcional à venda';
      out.notas.push('MEI tem limite de faturamento anual: confira se o contrato cabe nele.'); return out;
    }
    if (reg === 'simples') {
      let an = T.anexo; if (!an) { out.pend.push('Escolha o anexo do Simples em Minha empresa › Dados.'); out.resumo = 'Simples Nacional · anexo não definido'; return out; }
      if (an === 'V' && T.fator_r) an = 'III';
      const rb = num(T.rbt12), f = rb ? faixaDe(rb) : num(T.faixa);
      if (!f) { out.pend.push('Escolha a faixa de faturamento dos últimos 12 meses em Minha empresa › Dados.'); out.resumo = `Simples Nacional · ${ANEXO_TXT[an]} · faixa não definida`; return out; }
      const fx = faixaSimples(an, f), al = rb ? aliqSimples(an, rb) : fx.max;
      lin(`Simples Nacional (DAS) · ${ANEXO_TXT[an]} · faixa ${f}`, rd(al * 100, 2), { origem: rb ? 'faturamento informado' : 'teto da faixa' });
      out.aliquota = al; out.faixa = fx;
      out.resumo = `Simples Nacional · ${ANEXO_TXT[an]}${T.fator_r && T.anexo === 'V' ? ' (Fator R)' : ''} · faixa ${f} (${FAIXA_TXT[f - 1]}) · alíquota efetiva ${(al * 100).toFixed(2).replace('.', ',')}%`;
      if (!rb && f > 1) out.notas.push(`Na faixa ${f} a alíquota efetiva vai de ${(fx.min * 100).toFixed(2).replace('.', ',')}% a ${(fx.max * 100).toFixed(2).replace('.', ',')}%; usamos o teto (conservador). Informe o faturamento exato para refinar.`);
      if (an === 'IV') out.notas.push('No Anexo IV o INSS patronal (20%) é pago fora do DAS: inclua na mão de obra.');
      if (f >= 6) out.notas.push('Acima de R$ 3,6 milhões, ICMS e ISS são recolhidos fora do DAS: confira com seu contador.');
      out.notas.push('Optante do Simples não sofre retenção de IR, CSLL, PIS e Cofins pelo órgão.');
      return out;
    }
    const at = T.atividade || ATIV[T.anexo] || null;
    if (!at) { out.pend.push('Informe se a empresa vende mercadorias, fabrica ou presta serviços (Minha empresa › Dados).'); out.resumo = 'Atividade não definida'; return out; }
    const serv = at === 'servico';
    if (reg === 'presumido') {
      lin('PIS (cumulativo)', 0.65); lin('Cofins (cumulativa)', 3);
      lin(serv ? 'IRPJ (32% presumido × 15%)' : 'IRPJ (8% presumido × 15%)', serv ? 4.8 : 1.2);
      lin(serv ? 'CSLL (32% presumido × 9%)' : 'CSLL (12% presumido × 9%)', serv ? 2.88 : 1.08);
      out.notas.push('Adicional de IRPJ (10% sobre a parcela do lucro presumido acima de R$ 60 mil por trimestre) não incluído.');
    } else if (reg === 'real') {
      lin('PIS (não cumulativo, sem créditos)', 1.65); lin('Cofins (não cumulativa, sem créditos)', 7.6);
      out.notas.push('No Lucro Real, os créditos de PIS/Cofins sobre compras reduzem esse percentual, e IRPJ/CSLL incidem sobre o lucro: a margem mostrada é antes desses dois.');
    }
    if (serv) { const v = num(T.iss); if (v === null) out.pend.push('Escolha a alíquota de ISS em Minha empresa › Dados.'); else lin('ISS', v); }
    else { const v = num(T.icms); if (v === null) out.pend.push('Escolha o ICMS efetivo em Minha empresa › Dados.'); else lin('ICMS efetivo', v); }
    if (ctx.esfera === 'F') {
      out.tributos.push({ nome: serv ? 'Retenção federal (IR 4,8% + CSLL, PIS e Cofins 4,65%)' : 'Retenção federal (IR 1,2% + CSLL, PIS e Cofins 4,65%)', tipo: 'pct', base: 'receita',
        valor: serv ? 9.45 : 5.85, natureza: 'retencao', compensa_dias: 30, status: 'estimado', auto: true });
      out.notas.push('Órgão federal: o pagamento sofre retenção na fonte (IN RFB 1.234/2012), compensada na apuração seguinte; afeta só o caixa.');
    }
    out.resumo = `${reg === 'presumido' ? 'Lucro Presumido' : 'Lucro Real'} · ${at === 'comercio' ? 'comércio' : at === 'industria' ? 'indústria' : 'serviços'} · ${rd(out.tributos.filter(x => x.natureza !== 'retencao').reduce((a, x) => a + (x.valor || 0), 0), 2).toString().replace('.', ',')}% sobre a venda`;
    return out;
  }
  return { tributacao, anexoPorCnae, aliqSimples, faixaSimples, FAIXA_TXT, ANEXO_TXT, analisar, cenarios2, fluxo, comprometidos, GRUPOS2, BASES2, CEN2, cima, calcular, cenarios, sensibilidade, recomendacao, capitalDeGiro, CATEGORIAS, BASES, CENARIOS_PADRAO, _t: { teto2, c2, rateio } };
});
