// node --test test/viab.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../painel/viab.js');

const base = () => ({
  itens: [{ n: 1, qtd: 100, ref: 50, custo: 30, lote: 'A' }, { n: 2, qtd: 50, ref: 100, custo: 60, lote: 'A' }],
  pct_receita: [{ nome: 'Tributos', pct: 10 }],
  custos: [],
  margem_min: 10, margem_desejada: 20,
  giro: { prazo_entrega: 30, prazo_recebimento: 30, atraso: 0, prazo_fornecedor: 0, taxa_mensal: 2, parcelas: 1 },
});

test('fórmula: preço = custo ÷ (1 − tributos − margem), arredondado para cima', () => {
  const r = V.calcular(base());
  const i1 = r.itens[0];
  assert.equal(i1.custo_unit, 30);
  assert.equal(i1.preco_equilibrio, 33.34);        // 30/0.9 = 33.333.. → 33.34
  assert.equal(i1.preco_min, 37.5);                // 30/0.8
  assert.equal(i1.preco_sugerido, 42.86);          // 30/0.7 = 42.857.. → 42.86
  assert.equal(r.incompleta, false);
});

test('totais = unitário arredondado × quantidade; margem sobre receita ≠ markup sobre custo', () => {
  const r = V.calcular(base());
  const i1 = r.itens[0];
  assert.equal(i1.receita, 4286);                  // 42.86 × 100
  assert.equal(i1.custo_total, 3000);
  assert.equal(i1.pct_valor, 428.6);
  assert.equal(i1.lucro, 857.4);
  assert.ok(Math.abs(i1.margem - 20.005) < 0.01);  // ≈ 20% (arredondamento para cima garante ≥ margem)
  assert.ok(Math.abs(i1.markup - 42.866) < 0.01);  // (42.86−30)/30
  assert.ok(i1.margem >= 20);
  const t = r.total;
  assert.equal(t.receita, +(4286 + 85.72 * 50).toFixed(2));
});

test('vazio não é zero: custo e tributos ausentes geram pendência e análise incompleta', () => {
  const e = base(); e.itens[1].custo = ''; e.pct_receita = [{ nome: 'Tributos', pct: null }];
  const r = V.calcular(e);
  assert.equal(r.incompleta, true);
  assert.ok(r.pendencias.some(p => p.includes('Item 2') && p.includes('custo')));
  assert.ok(r.pendencias.some(p => p.includes('Tributos')));
  const z = base(); z.pct_receita = [{ nome: 'Tributos', pct: 0 }];
  assert.equal(V.calcular(z).incompleta, false);   // zero explícito é aceito
});

test('percentuais inválidos: soma ≥ 100% bloqueia a fórmula', () => {
  const e = base(); e.pct_receita = [{ nome: 'Tributos', pct: 85 }]; e.margem_min = 20;
  const r = V.calcular(e);
  assert.ok(r.erros.length > 0);
  assert.equal(r.incompleta, true);
  const e2 = base(); e2.pct_receita = [{ nome: 'X', pct: 120 }];
  assert.ok(V.calcular(e2).erros.some(x => x.includes('inválido')));
});

test('rateio de custo fixo por valor, quantidade e igual; sem dupla contagem silenciosa', () => {
  const e = base();
  e.custos = [{ categoria: 'Frete', base: 'fixo', valor: 1000, alvo: { tipo: 'todos' }, rateio: 'quantidade' }];
  let r = V.calcular(e);
  // quantidade 100 e 50 → 2/3 e 1/3 → 666,67/100 = 6,6667 e 333,33/50 = 6,6667 por unidade
  assert.equal(r.itens[0].custo_unit, 36.67);
  assert.equal(r.itens[1].custo_unit, 66.67);
  e.custos[0].rateio = 'valor';                     // ref 5000 e 5000 → metade cada
  r = V.calcular(e);
  assert.equal(r.itens[0].custo_unit, 35);
  assert.equal(r.itens[1].custo_unit, 70);
  // o total rateado bate com o valor fixo
  assert.ok(Math.abs((r.itens[0].custo_unit - 30) * 100 + (r.itens[1].custo_unit - 60) * 50 - 1000) < 0.01);
  e.custos.push({ categoria: 'Frete', base: 'fixo', valor: 1000, alvo: { tipo: 'todos' }, rateio: 'valor' });
  assert.ok(V.calcular(e).avisos.some(a => a.includes('dupla contagem')));
});

test('custo por lote e por unidade, alvo por item', () => {
  const e = base();
  e.itens.push({ n: 3, qtd: 10, ref: 10, custo: 5, lote: 'B' });
  e.custos = [{ categoria: 'Instalação', base: 'lote', valor: 100, alvo: { tipo: 'todos' }, rateio: 'igual' },
              { categoria: 'Embalagem', base: 'unidade', valor: 1, alvo: { tipo: 'item', ref: 3 } }];
  const r = V.calcular(e);
  // lote A: 100 rateado igual entre itens 1 e 2 → 50/100 = 0,5 e 50/50 = 1; lote B: 100/10 = 10 + 1 de embalagem
  assert.equal(r.itens[0].custo_unit, 30.5);
  assert.equal(r.itens[1].custo_unit, 61);
  assert.equal(r.itens[2].custo_unit, 16);
});

test('desconto máximo e preço mínimo acima da referência', () => {
  const e = base(); e.itens[0].custo = 45;
  const r = V.calcular(e);
  assert.equal(r.itens[0].preco_min, 56.25);
  assert.ok(r.itens[0].desconto_max < 0);
  assert.ok(r.avisos.some(a => a.includes('supera o valor de referência')));
  assert.ok(Math.abs(r.itens[1].desconto_max - 25) < 1e-9);   // 1 − 75/100
});

test('capital de giro: necessidade de caixa separada do custo financeiro', () => {
  const r = V.calcular(base());
  // custo total 3000 + 3000 = 6000 pago no dia 0; recebe no dia 60
  assert.equal(r.giro.necessidade, 6000);
  assert.equal(r.giro.custo_financeiro, 240);      // 6000 × 60 dias × 2%/30
  const e = base(); e.giro.prazo_fornecedor = 60;   // fornecedor recebe no mesmo dia do órgão: sem necessidade
  const r2 = V.calcular(e);
  assert.equal(r2.giro.necessidade, 0);
  const e3 = base(); e3.giro.taxa_mensal = '';
  const r3 = V.calcular(e3);
  assert.equal(r3.giro.custo_financeiro, null);
  assert.ok(r3.pendencias.some(p => p.includes('taxa')));
});

test('cenários mantêm o preço e pioram no conservador; sensibilidade ordenada', () => {
  const c = V.cenarios(base());
  assert.ok(c.conservador.lucro < c.base.lucro);
  assert.ok(c.otimista.lucro > c.base.lucro);
  assert.ok(c.conservador.custo_financeiro > c.base.custo_financeiro);   // prazos maiores custam mais, mesmo com menos quantidade
  const s = V.sensibilidade(base());
  assert.ok(s.length >= 5);
  assert.ok(Math.abs(s[0].d_lucro) >= Math.abs(s[s.length - 1].d_lucro));
});

test('recomendação: incompleta quando faltar o essencial; nunca dá probabilidade', () => {
  const e = base(); e.itens = [];
  const r = V.calcular(e);
  const rec = V.recomendacao(r, null, 0);
  assert.equal(rec.tipo, 'incompleta');
  const ok = V.recomendacao(V.calcular(base()), V.cenarios(base()), 0);
  assert.ok(!/%\s*de chance|probabilidade/i.test(ok.texto));
});
