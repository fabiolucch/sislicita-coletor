-- (itens acima de R$ 1 bi são erros de digitação dos órgãos no PNCP e ficam fora dos rankings)
-- PCA: busca por UF/termo/período no servidor (o filtro embutido do PostgREST estourava o tempo em 250 mil itens).
create index if not exists pca_itens_plano_valor on public.pca_itens (plano_id, valor_total desc nulls last);
create index if not exists pca_planos_uf_ano on public.pca_planos (uf, ano);

create or replace function public.pca_itens_buscar(p_uf text default null, p_termo text default null, p_de date default null, p_ate date default null, p_limite int default 100)
returns table(id bigint, descricao text, valor_total numeric, quantidade numeric, unidade_medida text, data_desejada date, nome_unidade text, orgao_cnpj text, orgao_nome text, uf text, ano int)
language plpgsql stable set statement_timeout = '25s' as $$
declare tq tsquery := case when nullif(trim(p_termo), '') is null then null else websearch_to_tsquery('portuguese', p_termo) end;
begin
  if p_uf is not null and p_uf <> '' then
    return query select x.id, x.descricao, x.valor_total, x.quantidade, x.unidade_medida, x.data_desejada::date, x.nome_unidade, p.orgao_cnpj, p.orgao_nome, p.uf, p.ano
      from public.pca_planos p
      cross join lateral (select i.* from public.pca_itens i where i.plano_id = p.id
          and (tq is null or i.descricao_tsv @@ tq) and (p_de is null or i.data_desejada >= p_de) and (p_ate is null or i.data_desejada <= p_ate) and (i.valor_total is null or i.valor_total < 1e9)
          order by i.valor_total desc nulls last limit p_limite) x
      where p.uf = p_uf order by x.valor_total desc nulls last limit p_limite;
  else
    return query select i.id, i.descricao, i.valor_total, i.quantidade, i.unidade_medida, i.data_desejada::date, i.nome_unidade, p.orgao_cnpj, p.orgao_nome, p.uf, p.ano
      from public.pca_itens i join public.pca_planos p on p.id = i.plano_id
      where (tq is null or i.descricao_tsv @@ tq) and (p_de is null or i.data_desejada >= p_de) and (p_ate is null or i.data_desejada <= p_ate) and (i.valor_total is null or i.valor_total < 1e9)
      order by i.valor_total desc nulls last limit p_limite;
  end if;
end $$;

-- Quem vai comprar: ranking de órgãos por valor planejado para o termo/UF/período.
create or replace function public.pca_orgaos(p_uf text default null, p_termo text default null, p_de date default null, p_ate date default null, p_limite int default 60)
returns table(orgao_cnpj text, orgao_nome text, uf text, n_itens bigint, valor numeric, proxima date, exemplo text)
language sql stable set statement_timeout = '25s' as $$
  with tq as (select case when nullif(trim(p_termo), '') is null then null else websearch_to_tsquery('portuguese', p_termo) end q)
  select p.orgao_cnpj, p.orgao_nome, p.uf, count(*), sum(i.valor_total), min(i.data_desejada)::date, (array_agg(i.descricao order by i.valor_total desc nulls last))[1]
  from public.pca_planos p join public.pca_itens i on i.plano_id = p.id, tq
  where (p_uf is null or p_uf = '' or p.uf = p_uf) and (tq.q is null or i.descricao_tsv @@ tq.q)
    and (p_de is null or i.data_desejada >= p_de) and (p_ate is null or i.data_desejada <= p_ate) and (i.valor_total is null or i.valor_total < 1e9)
  group by p.orgao_cnpj, p.orgao_nome, p.uf order by sum(i.valor_total) desc nulls last limit p_limite;
$$;

-- Quando vão comprar: distribuição por mês.
create or replace function public.pca_meses(p_uf text default null, p_termo text default null)
returns table(mes date, n_itens bigint, valor numeric)
language sql stable set statement_timeout = '25s' as $$
  with tq as (select case when nullif(trim(p_termo), '') is null then null else websearch_to_tsquery('portuguese', p_termo) end q)
  select date_trunc('month', i.data_desejada)::date, count(*), sum(i.valor_total)
  from public.pca_planos p join public.pca_itens i on i.plano_id = p.id, tq
  where (p_uf is null or p_uf = '' or p.uf = p_uf) and (tq.q is null or i.descricao_tsv @@ tq.q) and i.data_desejada >= date_trunc('month', now()) and i.data_desejada < date_trunc('month', now()) + interval '12 months' and (i.valor_total is null or i.valor_total < 1e9)
  group by 1 order by 1;
$$;
grant execute on function public.pca_itens_buscar(text,text,date,date,int), public.pca_orgaos(text,text,date,date,int), public.pca_meses(text,text) to authenticated;
select 'ok16';
