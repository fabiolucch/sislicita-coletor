-- Preço de referência x preço realmente praticado, para dimensionar a margem.
-- Fontes: contratos_pncp (contratos assinados: quanto a empresa vencedora realmente recebeu)
--         resultados_compras (valor estimado x homologado da mesma compra: o desconto da disputa)

create or replace function public.precos_referencia(q text, p_uf text default null, p_estimado numeric default null)
returns jsonb language sql stable set search_path = public as $$
  with c as (
    select valor_global v from contratos_pncp
    where objeto_tsv @@ websearch_to_tsquery('portuguese', q)
      and (p_uf is null or uf = p_uf) and valor_global > 0
  ), h as (
    select valor_estimado e, valor_homologado hm, desconto d from resultados_compras
    where objeto_tsv @@ websearch_to_tsquery('portuguese', q)
      and (p_uf is null or uf = p_uf) and desconto is not null
  ), m as (select percentile_cont(0.5) within group (order by v) med from c)
  select jsonb_build_object(
    'n',                (select count(*) from c),
    'min',              (select min(v) from c),
    'p25',              (select percentile_cont(0.25) within group (order by v) from c),
    'mediana',          (select med from m),
    'p75',              (select percentile_cont(0.75) within group (order by v) from c),
    'max',              (select max(v) from c),
    'nh',               (select count(*) from h),
    'desconto_mediano', (select percentile_cont(0.5) within group (order by d) from h),
    'estimado',         p_estimado,
    -- quanto costuma sobrar entre o valor de referência do edital e o que de fato se contrata
    'margem_mediana',   case when coalesce(p_estimado,0) > 0 then p_estimado - (select med from m) end,
    'margem_minima',    case when coalesce(p_estimado,0) > 0 then p_estimado - (select max(v) from c) end,
    'margem_maxima',    case when coalesce(p_estimado,0) > 0 then p_estimado - (select min(v) from c) end);
$$;

-- Quem ganhou e por quanto, do mais barato ao mais caro (p_ordem='valor') ou do mais recente (padrão).
create or replace function public.vencedores_parecidos(q text, p_uf text default null, p_limite int default 12, p_ordem text default 'data')
returns table (data date, orgao text, uf text, fornecedor text, cnpj text, objeto text, valor numeric, compra text)
language sql stable set search_path = public as $$
  select data_assinatura, orgao_nome, uf, fornecedor_nome, fornecedor_ni, left(objeto, 200), valor_global, compra
  from contratos_pncp
  where objeto_tsv @@ websearch_to_tsquery('portuguese', q) and (p_uf is null or uf = p_uf) and valor_global > 0
  order by case when p_ordem = 'valor' then valor_global end asc nulls last,
           case when p_ordem = 'valor' then null else data_assinatura end desc nulls last
  limit p_limite;
$$;

grant execute on function public.precos_referencia(text, text, numeric) to authenticated;
grant execute on function public.vencedores_parecidos(text, text, int, text) to authenticated;

select 'ok6_precos';
