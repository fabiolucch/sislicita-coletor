-- Historico do orgao para um objeto + leitura da concorrencia (usado no painel de Detalhes).
create or replace function public.historico_orgao(q text, p_orgao text, p_uf text default null)
returns jsonb language sql stable set search_path = public as $$
  with tq as (select websearch_to_tsquery('portuguese', q) t),
  -- o que este orgao ja comprou parecido
  co as (
    select data_assinatura, valor_global, fornecedor_nome, fornecedor_ni, objeto
    from contratos_pncp, tq
    where objeto_tsv @@ tq.t and p_orgao is not null and orgao_nome = p_orgao
  ),
  ro as (
    select atualizado_em::date d, valor_estimado, valor_homologado, desconto, modalidade
    from resultados_compras, tq
    where objeto_tsv @@ tq.t and p_orgao is not null and orgao_nome = p_orgao
  ),
  -- concorrencia no setor (todos os orgaos, opcionalmente so a UF)
  cs as (
    select fornecedor_ni, fornecedor_nome, valor_global
    from contratos_pncp, tq
    where objeto_tsv @@ tq.t and (p_uf is null or uf = p_uf)
  ),
  ag as (
    select fornecedor_ni, max(fornecedor_nome) nome, count(*) n, sum(coalesce(valor_global,0)) v
    from cs where fornecedor_ni is not null group by fornecedor_ni
  )
  select jsonb_build_object(
    'orgao', jsonb_build_object(
      'contratos', (select count(*) from co),
      'valor_total', (select sum(coalesce(valor_global,0)) from co),
      'valor_tipico', (select percentile_cont(0.5) within group (order by valor_global) from co where valor_global > 0),
      'primeiro', (select min(data_assinatura) from co),
      'ultimo', (select max(data_assinatura) from co),
      'meses', (select coalesce(jsonb_agg(x order by x.n desc), '[]') from (
          select to_char(data_assinatura,'MM') mes, count(*) n from co where data_assinatura is not null group by 1 limit 4) x),
      'fornecedores', (select coalesce(jsonb_agg(x order by x.n desc), '[]') from (
          select max(fornecedor_nome) nome, fornecedor_ni cnpj, count(*) n, sum(coalesce(valor_global,0)) v
          from co where fornecedor_ni is not null group by fornecedor_ni order by count(*) desc limit 5) x),
      'homologadas', (select count(*) from ro),
      'desconto_mediano', (select percentile_cont(0.5) within group (order by desconto) from ro where desconto between -0.2 and 0.9)
    ),
    'setor', jsonb_build_object(
      'contratos', (select count(*) from cs),
      'fornecedores', (select count(*) from ag),
      'top', (select coalesce(jsonb_agg(x order by x.n desc), '[]') from (
          select nome, fornecedor_ni cnpj, n, v from ag order by n desc limit 5) x),
      'share_lider', (select case when (select count(*) from cs) > 0
          then round((select max(n) from ag)::numeric / (select count(*) from cs), 3) end)
    ));
$$;
grant execute on function public.historico_orgao(text, text, text) to authenticated;
