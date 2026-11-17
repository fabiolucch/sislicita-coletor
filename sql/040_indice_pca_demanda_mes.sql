-- 040: pca_meses/pca_orgaos faziam leitura sequencial de toda a pca_demanda (~96 MB) a cada busca.
create index if not exists pca_demanda_mes_cobertura on public.pca_demanda (mes) include (plano_id, n_itens, valor_total);
analyze public.pca_demanda;
