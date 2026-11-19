// node --test test/viab2.test.js — validação do motor v2 (exemplo da especificação e casos de borda)
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../painel/viab.js');

// 100 unidades, custo total R$ 90.000, tributos 12% sobre a venda, margem mínima 10%, alvo 15%
const ex = (o = {}) => Object.assign({
  julgamento: 'item', modo_custo: 'rapido',
  itens: [{ n: 1, qtd: 100, unidade: 'UN', custo_total_est: 90000, ref: 1300 }],
  tributos: [{ nome: 'Tributos e taxas', tipo: 'pct', base: 'receita', valor: 12, natureza: 'devido' }],
  margem_min: 10, margem_alvo: 15,
  operacao: { prazo_fornecedor: 0, prazo_entrega: 30, prazo_recebimento: 30, caixa: 60000, credito: 0 },
}, o);
const u1 = (E, lance) => V.analisar(Object.assign(E, lance ? { lances: { i1: { valor: lance } } } : {})).unidades[0];

test('exemplo: equilíbrio, lance mínimo e preço-alvo', () => {
  const r = u1(ex());
  assert.equal(r.equilibrio, 1022.73);
  assert.equal(r.minimo, 1153.85);
  assert.equal(r.alvo, 1232.88);
  assert.ok(r.margem_no_minimo >= 0.10);             // margem recalculada com o piso arredondado
  assert.equal(r.parcial, false);
});

test('exemplo: lance de R$ 1.200,00 → lucro 15.600 e margem 13%', () => {
  const r = u1(ex(), 1200);
  assert.equal(r.lance.lucro, 15600);
  assert.ok(Math.abs(r.lance.margem - 0.13) < 1e-12);
});

test('exemplo: lance de R$ 1.050,00 → lucro 2.400, margem 2,29% e redução de custo de 8.100', () => {
  const r = u1(ex(), 1050);
  assert.equal(r.lance.lucro, 2400);
  assert.equal(Math.round(r.lance.margem * 10000) / 100, 2.29);
  assert.equal(r.lance.custo_max, 81900);
  assert.equal(r.lance.reducao, 8100);
  assert.ok(r.frases.margem.includes('R$ 2.400,00') && r.frases.margem.includes('2,29%') && r.frases.margem.includes('10%'));
});

test('exemplo: teto confirmado de R$ 1.050,00 → reduzir o custo do item em 8.100', () => {
  const E = ex(); E.itens[0].teto = 1050;
  const r = u1(E);
  assert.equal(r.teto_reducao, 8100);
  assert.equal(r.teto_ok, false);
  assert.ok(r.frases.edital.includes('R$ 8.100,00'));
});

test('exemplo: capital de giro de 90.000 e falta de 30.000 com caixa de 60.000 sem crédito', () => {
  const r = u1(ex(), 1200);
  assert.equal(r.caixa.ok, true);
  assert.equal(r.caixa.capital, 90000);
  assert.equal(r.caixa.falta, 30000);
  assert.ok(r.frases.caixa.includes('faltam R$ 30.000,00'));
});

test('lance abaixo do equilíbrio mostra prejuízo; limite de lance em reais e %', () => {
  const r = u1(ex(), 1000);
  assert.equal(r.lance.abaixo_equilibrio, true);
  assert.ok(r.lance.lucro < 0 && r.frases.limite.includes('prejuízo'));
  const r2 = u1(ex(), 1200);
  assert.equal(r2.lance.folga_unit, 46.15);                     // 1200 − 1153,85
  assert.equal(r2.lance.folga, 4615);
});

test('prazo de pagamento ausente: análise econômica disponível e capital de giro pendente', () => {
  const E = ex(); E.operacao.prazo_recebimento = '';
  const r = u1(E, 1200);
  assert.equal(r.lance.lucro, 15600);
  assert.equal(r.caixa.ok, false);
  assert.ok(r.caixa.falta.includes('prazo de pagamento do órgão'));
  assert.ok(r.frases.caixa.startsWith('Capital de giro pendente'));
});

test('vazio não é zero; zero informado é aceito', () => {
  const E = ex(); E.itens[0].custo_total_est = '';
  const a = V.analisar(E);
  assert.equal(a.parcial, true);
  assert.ok(a.pendencias.some(p => p.includes('custo total estimado')));
  const Z = ex(); Z.tributos[0].valor = 0;
  const z = V.analisar(Z);
  assert.equal(z.parcial, false);
  assert.equal(z.unidades[0].equilibrio, 900);
});

test('unidade de cotação: caixa com 12, compra mínima e sobra explícita', () => {
  const E = ex({ modo_custo: 'detalhado' });
  E.itens = [{ n: 1, qtd: 100, cotacao: { preco_emb: 120, unid_por_emb: 12, minimo_emb: 0, sobra: 'custo' } }];
  let a = V.analisar(E);
  assert.equal(a.itens[0].emb, 9);                 // 9 caixas = 108 unidades
  assert.equal(a.itens[0].desembolso, 1080);
  assert.equal(a.itens[0].custo, 1080);            // sobra entra no custo
  assert.ok(a.avisos.some(x => x.includes('sobra de 8')));
  E.itens[0].cotacao.sobra = 'estoque';
  a = V.analisar(E);
  assert.equal(a.itens[0].custo, 1000);            // 10 por unidade × 100
  assert.equal(a.itens[0].desembolso, 1080);       // o caixa continua pagando 9 caixas
  E.itens[0].cotacao.minimo_emb = 20;
  assert.equal(V.analisar(E).itens[0].desembolso, 2400);
});

test('lote com custo compartilhado: contado uma vez no lote e rateado entre itens', () => {
  const E = ex({ modo_custo: 'detalhado', julgamento: 'lote' });
  E.itens = [{ n: 1, qtd: 100, custo_unit: 30, ref: 50, lote: 'A' }, { n: 2, qtd: 50, custo_unit: 60, ref: 100, lote: 'A' }];
  E.custos = [{ categoria: 'Mobilização', base: 'contrato', valor: 1000, alvo: { tipo: 'todos' }, rateio: 'valor' }];
  const a = V.analisar(E);
  const L = a.unidades.find(u => u.id === 'lA');
  assert.equal(L.C, 3000 + 3000 + 1000);
  assert.equal(L.minimo_total, V.cima(7000 / 0.78));
  assert.ok(L.lance && L.composicao.length === 2);
  assert.ok(Math.abs(L.composicao_total - L.lance.R) < 1);   // composição proporcional bate com o global
  // composição manual com teto por item
  E.itens[0].teto = 40; E.lances = { lA: { itens: { 1: 45, 2: 110 } } };
  const b = V.analisar(E).unidades.find(u => u.id === 'lA');
  assert.equal(b.lance.R, 45 * 100 + 110 * 50);
  assert.ok(b.composicao[0].acima_teto);
});

test('julgamento por maior desconto: desconto máximo que preserva a margem mínima', () => {
  const E = ex({ julgamento: 'desconto' });
  E.itens[0].base_desc = 1500;                     // base prevista no edital: 150.000
  const r = V.analisar(Object.assign(E, { lances: { lGlobal: { desconto: 20 } } })).unidades[0];
  assert.equal(r.tipo, 'desconto');
  assert.equal(r.base_desc, 150000);
  assert.equal(r.desconto_max, Math.floor((1 - V.cima(90000 / 0.78) / 150000) * 1e4) / 1e4);   // ≈ 23,07%
  assert.equal(r.lance.R, 120000);
  assert.equal(r.lance.lucro, 15600);
});

test('registro de preços: sem pedidos mostra custos comprometidos; quantidade menor dilui pior os fixos', () => {
  const E = ex({ modo_custo: 'detalhado', srp: true, srp_cfg: { provavel_pct: 50, fator_pedidos: 2 } });
  E.itens = [{ n: 1, qtd: 100, custo_unit: 800 }];
  E.custos = [{ categoria: 'Mobilização', base: 'contrato', valor: 5000, alvo: { tipo: 'todos' } },
              { categoria: 'Frete', base: 'entrega', valor: 300, alvo: { tipo: 'todos' } }];
  E.operacao.entregas = 2;
  E.lances = { i1: { valor: 1100 } };
  const c = V.cenarios2(E, 'i1');
  assert.equal(c.srp_sem_pedidos.comprometido, 5000);
  assert.ok(c.srp_provavel.minimo > c.srp_maxima.minimo);      // fixo diluído em menos unidades
  assert.ok(c.srp_menores.minimo > c.srp_provavel.minimo);     // mais entregas = mais frete
  assert.ok(c.conservador.lucro < c.base.lucro);
});

test('financiamento: só juros e tarifas entram no custo; liberação ajuda o caixa', () => {
  const E = ex(); E.operacao.financiamento = { valor: 40000, dia: 0, quitacao: 60, juros: 800, tarifas: 200 };
  const r = u1(E, 1200);
  assert.equal(r.C, 91000);
  assert.equal(r.caixa.falta, 0);                   // 60.000 de caixa + 40.000 liberados cobrem os 90.000
});

test('retenção compensável reduz o recebimento imediato, não o lucro', () => {
  const E = ex(); E.tributos.push({ nome: 'Retenção de IR', tipo: 'pct', base: 'receita', valor: 1.2, natureza: 'retencao', compensa_dias: 30 });
  const r = u1(E, 1200);
  assert.equal(r.lance.lucro, 15600);
  assert.ok(r.caixa.serie.some(s => s.evento.startsWith('Retenção')));
});

test('tributação automática: Simples pela fórmula oficial, faixa pelo teto e retenção só fora do Simples', () => {
  assert.equal(Math.round(V.aliqSimples('I', 500000) * 1e5) / 1e3, 6.728);        // (500.000 × 9,5% − 13.860) ÷ 500.000
  const s = V.tributacao({ regime: 'simples', anexo: 'I', faixa: 3 }, { esfera: 'F' });
  assert.equal(s.tributos.length, 1);
  assert.equal(s.tributos[0].valor, 7.58);                                          // teto da faixa 3 (conservador)
  assert.ok(!s.tributos.some(x => x.natureza === 'retencao'));
  const v = V.tributacao({ regime: 'simples', anexo: 'V', fator_r: true, faixa: 1 });
  assert.equal(v.tributos[0].valor, 6);                                             // Fator R: Anexo V vai ao III
  const p = V.tributacao({ regime: 'presumido', atividade: 'servico', iss: 5 }, { esfera: 'F' });
  assert.equal(p.tributos.filter(x => x.natureza !== 'retencao').reduce((a, x) => a + x.valor, 0), 16.33);
  assert.equal(p.tributos.find(x => x.natureza === 'retencao').valor, 9.45);
  const m = V.tributacao({ regime: 'presumido', atividade: 'comercio' });
  assert.ok(m.pend.some(x => x.includes('ICMS')));                                  // sem ICMS escolhido: pendência, não zero
  assert.equal(V.tributacao({}).pend.length, 1);
  assert.equal(V.anexoPorCnae('4691500').anexo, 'I');
  assert.equal(V.anexoPorCnae('6201501').anexo, 'V');
  // a pendência do perfil chega ao cálculo como parcial
  const E = ex(); E.tributos = []; E.pend_extra = m.pend;
  assert.equal(V.analisar(E).parcial, true);
});
