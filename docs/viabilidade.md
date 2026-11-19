# Análise de viabilidade (v2) e fluxo do usuário

## Fluxo do menu
1. **Minha empresa** — dados e linha de fornecimento; documentos de habilitação.
2. **Radar** — licitações abertas (na linha, pelos perfis, ranking dos perfis, pesquisa ampla), compras previstas (PCA), perfis de busca.
3. **Triagem e análise** — *Triagem*: o que o Radar trouxe e ainda não foi decidido (Descartar / Tenho interesse / Analisar viabilidade). *Minhas licitações*: A analisar → Em análise → Vou participar → Proposta enviada → Resultado (ganha/perdida) · Descartadas.
4. **Ferramentas** — pesquisa de preços, concorrência.  **Conta** — equipe, cadastros e plano.

Modo consultoria (mensagens de abordagem, prospecção de fornecedores, contatos de concorrentes, status “Em abordagem”) fica desligado pela constante `MODO_CONSULTORIA=false` em `painel/index.html`; o código foi preservado.

Banco (`sql/043_fluxo_usuario.sql`): novas situações `proposta_enviada`, `ganha`, `perdida`; RPC `triar_oportunidade`; `oportunidades_linha(..., p_so_novas)`.

## Preenchimento automático (o usuário só escolhe os itens e informa o custo)
- **Etapas da análise:** 1 · Itens e custo → 2 · Premissas → 3 · Cenários e caixa → 4 · Documentos → 5 · Decisão. Tudo que não é custo vem preenchido e é escolhido em listas (sem campo aberto), com a origem indicada: PNCP, IA · edital, Minha empresa, Padrão, Compras.gov.br.
- **Perfil tributário da empresa** (Minha empresa › Dados › Tributação e metas padrão; coluna `pessoas_juridicas.tributacao`, SQL 044):
  - regime detectado pelo CNPJ (BrasilAPI: `opcao_pelo_simples`, `opcao_pelo_mei`); se não for Simples/MEI, o usuário escolhe Presumido ou Real;
  - anexo do Simples sugerido pelo CNAE principal (`anexoPorCnae`) ou pela IA (`/api/ia` ação `anexo_simples`), com Fator R para o Anexo V;
  - faixa de faturamento dos últimos 12 meses (6 faixas oficiais); alíquota efetiva = (RBT12 × alíquota nominal − parcela a deduzir) ÷ RBT12, usando o teto da faixa (conservador);
  - Presumido: PIS 0,65% + Cofins 3% + IRPJ e CSLL presumidos (comércio/indústria 1,2% + 1,08%; serviços 4,8% + 2,88%) + ICMS/ISS escolhido; Real: PIS 1,65% + Cofins 7,6% (sem créditos) + ICMS/ISS;
  - órgão federal e empresa fora do Simples: retenção na fonte (bens 5,85%, serviços 9,45%) entra só no caixa;
  - margens, prazo dos fornecedores, caixa e crédito padrão.
- **Prazos:** lidos do edital pela IA; se não encontrados, padrão de 30 dias (marcado como Padrão).
- **Preço histórico:** mediana das compras públicas dos últimos 12 meses na mesma unidade (`/api/preco`, Compras.gov.br), quando há ao menos 3 compras.

## Motor (`painel/viab.js`, função `analisar`)
Símbolos: `Q` quantidade, `C` custo total da execução, `t` soma dos percentuais sobre a mesma receita bruta, `m_min`, `m_alvo`.

| Resultado | Fórmula |
|---|---|
| Receita | `R = preço × Q` (lote: Σ preço × quantidade) |
| Lucro | `R(1 − t) − C` |
| Margem | `lucro ÷ R` |
| Equilíbrio | `C ÷ (1 − t) ÷ Q` |
| Lance mínimo | `C ÷ (1 − t − m_min) ÷ Q` |
| Preço-alvo | `C ÷ (1 − t − m_alvo) ÷ Q` |
| Custo máximo no lance | `R(1 − t − m_min)` |
| Redução necessária | `máx(0, C − custo máximo)` |
| Desconto máximo | `1 − lance mínimo ÷ base do desconto` |

- Pisos arredondados para cima na precisão do edital (2 a 4 casas); a margem é recalculada com o valor exibido.
- Campo vazio ≠ zero: vazio vira pendência e o cálculo fica **parcial**; sem prazos, o capital de giro fica **pendente** e o resto continua.
- Custo: *estimativa rápida* (total por item) ou *composição detalhada* (custo por unidade ou cotação por embalagem com compra mínima e tratamento da sobra + despesas por unidade, pedido, entrega, mês, contrato ou lote, com rateio e contadas uma vez).
- Tributos: percentual sobre a venda (entra em `t`), sobre o custo, por unidade ou fixo (entram em `C`); retenção compensável só no caixa.
- Financiamento: só juros e tarifas entram em `C`; liberação e amortização só no caixa. Caução: saída e devolução no caixa.
- Caixa: dia 0 = assinatura/empenho; pedido k em k × intervalo; pagamento ao fornecedor, entrega, faturamento, recebimento (+ atraso), tributos e retenções nas datas. Capital de giro = maior déficit do saldo operacional; falta = maior déficit depois de caixa, crédito (a partir do dia informado) e financiamento.
- Custo do giro no custo (opcional): o custo depende do lance → pisos por aproximação sucessiva, sinalizada.
- Cenários: base e conservador (custo, frete, câmbio, quantidade, atraso) com o lance fixo por unidade; em registro de preços: quantidade máxima, provável, pedidos menores e nenhum pedido (custos comprometidos + caução).
- Os valores vêm só de regras determinísticas; a IA apenas lê o edital para pré-preencher premissas, com origem indicada.

## Verificação
`node --test test/viab.test.js test/viab2.test.js` — inclui o exemplo de referência (100 un., C = 90.000, t = 12%, m_min = 10%, m_alvo = 15%): equilíbrio 1.022,73; mínimo 1.153,85; alvo 1.232,88; lance 1.200 → lucro 15.600 (13%); lance 1.050 → lucro 2.400 (2,29%) e redução 8.100; capital de giro 90.000 e falta 30.000 com caixa de 60.000. Também: tributação automática (Simples pela fórmula oficial, Fator R, Presumido, retenção federal), lote com custo compartilhado, maior desconto, registro de preços sem pedidos, prazo ausente, cotação por embalagem, financiamento e retenção. Isolamento entre empresas conferido no banco (usuário de outra organização não lê, não salva e não decide a análise).
