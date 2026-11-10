# EditalVector - radar e coletor do PNCP

Coleta editais abertos e itens do PCA no PNCP e grava no Supabase (projeto EditalVector).

- `coletor.py editais`: editais com propostas abertas (modalidades 4,5,6,7,8,12) por UF.
- `coletor.py pca`: planos do PCA (2026 e 2027) e itens que casam com os perfis de busca ativos.
- `coletor.py radar`: cruza oportunidades e itens do PCA com os perfis (funcao `atualizar_radar`).
- `coletor.py tudo`: as tres etapas.

Segredos do repositorio (Settings > Secrets and variables > Actions): `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`.
O workflow roda 2x ao dia e pode ser disparado manualmente na aba Actions.

SQL: `sql/002_pca_radar.sql` (ajustes do PCA e funcao do radar). O schema inicial esta no projeto do Claude.
