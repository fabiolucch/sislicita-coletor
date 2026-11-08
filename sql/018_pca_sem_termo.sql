-- Sem termo de busca, o ranking e o gráfico usam pca_demanda (já agregada por órgão/categoria/mês), bem menor que pca_itens.
create or replace function public.pca_orgaos(p_uf text default null, p_termo text default null, p_de date default null, p_ate date default null, p_limite int default 60)
returns table(orgao_cnpj text, orgao_nome text, uf text, n_itens bigint, valor numeric, proxima date, exemplo text)
language plpgsql stable set statement_timeout = '25s' as $$
declare tq tsquery := case when nullif(trim(p_termo), '') is null then null else websearch_to_tsquery('portuguese', p_termo) end;
begin
  if tq is null then
    return query
      select p.orgao_cnpj, p.orgao_nome, p.uf, sum(d.n_itens)::bigint, sum(d.valor_total), min(d.mes)::date,
             (array_agg(coalesce(d.classificacao_nome, d.grupo_contratacao, d.categoria) order by d.valor_total desc nulls last))[1]
      from public.pca_demanda d join public.pca_planos p on p.id = d.plano_id
      where (p_uf is null or p_uf = '' or p.uf = p_uf) and (d.mes is null or d.mes > '1901-01-01')
        and (p_de is null or d.mes >= p_de) and (p_ate is null or d.mes <= p_ate) and (d.valor_total is null or d.valor_total < 1e9)
      group by p.orgao_cnpj, p.orgao_nome, p.uf order by sum(d.valor_total) desc nulls last limit p_limite;
  else
    return query
      select p.orgao_cnpj, p.orgao_nome, p.uf, count(*), sum(i.valor_total), min(i.data_desejada)::date, (array_agg(i.descricao order by i.valor_total desc nulls last))[1]
      from public.pca_planos p join public.pca_itens i on i.plano_id = p.id
      where (p_uf is null or p_uf = '' or p.uf = p_uf) and i.descricao_tsv @@ tq
        and (p_de is null or i.data_desejada >= p_de) and (p_ate is null or i.data_desejada <= p_ate) and (i.valor_total is null or i.valor_total < 1e9)
      group by p.orgao_cnpj, p.orgao_nome, p.uf order by sum(i.valor_total) desc nulls last limit p_limite;
  end if;
end $$;

create or replace function public.pca_meses(p_uf text default null, p_termo text default null)
returns table(mes date, n_itens bigint, valor numeric)
language plpgsql stable set statement_timeout = '25s' as $$
declare tq tsquery := case when nullif(trim(p_termo), '') is null then null else websearch_to_tsquery('portuguese', p_termo) end;
begin
  if tq is null then
    return query
      select date_trunc('month', d.mes)::date, sum(d.n_itens)::bigint, sum(d.valor_total)
      from public.pca_demanda d join public.pca_planos p on p.id = d.plano_id
      where (p_uf is null or p_uf = '' or p.uf = p_uf) and d.mes >= date_trunc('month', now()) and d.mes < date_trunc('month', now()) + interval '12 months' and (d.valor_total is null or d.valor_total < 1e9)
      group by 1 order by 1;
  else
    return query
      select date_trunc('month', i.data_desejada)::date, count(*), sum(i.valor_total)
      from public.pca_planos p join public.pca_itens i on i.plano_id = p.id
      where (p_uf is null or p_uf = '' or p.uf = p_uf) and i.descricao_tsv @@ tq and i.data_desejada >= date_trunc('month', now()) and i.data_desejada < date_trunc('month', now()) + interval '12 months' and (i.valor_total is null or i.valor_total < 1e9)
      group by 1 order by 1;
  end if;
end $$;
select 'ok18';
