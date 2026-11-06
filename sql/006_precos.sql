-- Preço de referência x preço realmente praticado, para dimensionar a margem.
-- Fontes: contratos_pncp      (contratos assinados: quanto a empresa vencedora recebeu)
--         resultados_compras  (estimado x homologado da MESMA compra: o desconto real da disputa)
--
-- Cuidado embutido: contratos inteiros têm tamanhos muito diferentes (de R$ 100 a R$ 2 mi para o
-- mesmo objeto). Quando o edital tem valor de referência, as estatísticas usam só contratos de
-- porte parecido (1/4 a 4x a referência); sem isso o "menor preço" não quer dizer nada.

create or replace function public.precos_referencia(q text, p_uf text default null, p_estimado numeric default null)
returns jsonb language sql stable set search_path = public as $fn$
  with todos as (
    select valor_global v from contratos_pncp
    where objeto_tsv @@ websearch_to_tsquery('portuguese', q)
      and (p_uf is null or uf = p_uf) and valor_global > 0
  ), c as (                                              -- só o que dá para comparar
    select v from todos
    where coalesce(p_estimado,0) <= 0
       or v between p_estimado * 0.25 and p_estimado * 4
  ), h as (                                              -- desconto real da disputa
    select desconto d from resultados_compras
    where objeto_tsv @@ websearch_to_tsquery('portuguese', q)
      and (p_uf is null or uf = p_uf) and desconto is not null
  ), s as (
    select (select count(*) from c) n,
           (select min(v) from c) mn,
           (select percentile_cont(0.5) within group (order by v) from c) med,
           (select max(v) from c) mx,
           (select count(*) from todos) nt, (select min(v) from todos) mnt,
           (select percentile_cont(0.5) within group (order by v) from todos) medt,
           (select max(v) from todos) mxt,
           (select count(*) from h) nh,
           (select percentile_cont(0.5) within group (order by d) from h) desc_h
  )
  select jsonb_build_object(
    'n', n, 'min', mn, 'mediana', med, 'max', mx,
    'n_total', nt, 'min_todos', mnt, 'mediana_todos', medt, 'max_todos', mxt,
    'nh', nh, 'desconto_disputa', desc_h, 'estimado', p_estimado,
    'comparavel', coalesce(p_estimado,0) > 0 and n > 0,
    -- desconto implícito nos contratos de porte parecido (indicação grosseira, usada quando
    -- ainda não há compras homologadas comparáveis)
    'desconto_contratos', case when coalesce(p_estimado,0) > 0 and med > 0 then 1 - med / p_estimado end,
    -- preço provável de fechamento e a folga que sobra em relação à referência
    'fechamento_provavel', case when coalesce(p_estimado,0) > 0 and desc_h is not null then p_estimado * (1 - desc_h)
                                when coalesce(p_estimado,0) > 0 and med > 0 then med end,
    'margem', case when coalesce(p_estimado,0) > 0 and desc_h is not null then p_estimado * desc_h
                   when coalesce(p_estimado,0) > 0 and med > 0 then p_estimado - med end)
  from s;
$fn$;

-- Quem ganhou e por quanto. Com p_estimado, só contratos de porte comparável.
create or replace function public.vencedores_parecidos(q text, p_uf text default null, p_limite int default 12,
                                                       p_ordem text default 'data', p_estimado numeric default null)
returns table (data date, orgao text, uf text, fornecedor text, cnpj text, objeto text, valor numeric, compra text)
language sql stable set search_path = public as $fn$
  select data_assinatura, orgao_nome, uf, fornecedor_nome, fornecedor_ni, left(objeto, 200), valor_global, compra
  from contratos_pncp
  where objeto_tsv @@ websearch_to_tsquery('portuguese', q) and (p_uf is null or uf = p_uf) and valor_global > 0
    and (coalesce(p_estimado,0) <= 0 or valor_global between p_estimado * 0.25 and p_estimado * 4)
  order by case when p_ordem = 'valor' then valor_global end asc nulls last,
           case when p_ordem = 'valor' then null else data_assinatura end desc nulls last
  limit p_limite;
$fn$;

grant execute on function public.precos_referencia(text, text, numeric) to authenticated;
grant execute on function public.vencedores_parecidos(text, text, int, text, numeric) to authenticated;

select 'ok6_precos';
