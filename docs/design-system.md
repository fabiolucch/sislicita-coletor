# EditalVector — Design System

Fonte única: **`painel/ds.css`** (carregado por último). As páginas não definem cores, alturas, raios nem tipografia próprios; mudar um token ou componente ali muda o site inteiro. `app.css`, `theme.css` e `ev.css` guardam só layout e componentes específicos de cada tela.

## Tokens (`:root`)
| Grupo | Tokens |
|---|---|
| Superfícies | `--bg #f1f2f4` · `--card #fff` · `--raise #f4f5f7` · `--sf2 #e9ebee` |
| Bordas | `--bd #d5d8dd` · `--line #e3e5e9` · `--campo-bd #b9bec6` |
| Texto | `--tx #23262b` · `--tx2 #383c43` · `--mut #5d646e` · `--ph #7d848e` |
| Marca | `--primary #ea580c` · `--primary-hover #c2410c` · `--pri #f97316` (detalhes) · `--pri3 #c2410c` (texto de destaque) |
| Semânticas | `--ok #15803d` · `--warn #b45309` · `--bad #b91c1c` · `--info #1d4ed8` |
| Foco / desabilitado | `--focus #2563eb` · `--disabled-bg` · `--disabled-tx` |
| Menu lateral | `--nav-bg #2b2e34` · `--nav-active #3a3f46` · `--nav-tx` · `--nav-mut` |
| Espaçamento | `--sp-1…8` = 4, 8, 12, 16, 20, 24, 32, 48 px |
| Raios | `--r-sm 6` · `--r-md 8` · `--r-lg 12` · `--r-pill 999` |
| Alturas | `--h-sm 32` · `--h-md 40` · `--h-lg 44` (no celular, ≤640 px: 36 / 44 / 48) |
| Tipografia | título 26 · seção 18 · subtítulo 16 · texto 14 · secundário 13 · legenda 12 · indicador 24 |
| Sombras | `--sh-1`, `--sh-2`, `--sh` |

## Componentes
- **Botão** (`button`, `.gh`): padrão 40 px, laranja `--primary`, texto branco. Tamanhos `.sm` 32 e `.lg`/`.cta` 44. Variantes: primário (padrão), `.sec` (contorno branco), `.ghost`, `.bad` (destrutivo), `.lnk`, `.icon`. Estados: hover, active, `:focus-visible`, `:disabled`, `[aria-busy=true]`. Uma ação primária por área.
- **Campos** (`input`, `select`, `textarea`): 40 px, borda `--campo-bd`, foco azul `--focus`. Labels 13 px/600. Grade de formulário: `.ev-form` (colunas automáticas, espaço 12/16 px).
- **Card** (`.card`, `.kp`, `.bar`): fundo `--card`, borda `--bd`, raio 12, padding 16/20.
- **Selo** (`.chip`, `.tag`, `.aib-t`): 24 px, raio 6; cores semânticas escuras sobre fundo claro.
- **Abas** (`.ev-tabs`, `.ev-sub`): trilho cinza, aba ativa branca com sublinhado laranja, contador `.n`.
- **Menu lateral**: escuro, item ativo em laranja; barra superior no celular.
- **Tabela**: cabeçalho 12 px em caixa alta, células compactas, rolagem horizontal interna.
- **Filtros**: principais sempre visíveis; avançados dentro de `details.bar-av` ("Mais filtros").
- **Card de licitação** (`.lc`): **cores preservadas**; botões da linha todos em 32 px.

## Regras
- Nada de `!important` nos componentes; "html body" sobe a especificidade para vencer o reset de botões do Tailwind. Exceções justificadas: tema escuro do menu (`aside`, `#mtop`), botões da landing e `prefers-reduced-motion`.
- Texto quebra linha; tabelas rolam dentro do próprio bloco; nada gera rolagem lateral da página.
- Acessibilidade: contraste AA, foco visível, áreas de toque de 44 px no celular, movimento reduzido respeitado.
- Para criar uma tela nova, use só tokens e variantes acima; não declare cor, altura ou raio.

## Verificação
Larguras: 375, 768, 1024, 1440 e 1920 px. Em todas, sem rolagem horizontal; campos com altura única; botões em 32/40/44 (36/44/48 no celular).
