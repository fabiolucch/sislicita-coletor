-- pca_planos.uf nunca foi preenchido (a busca de PCA do PNCP não devolve UF). Preenche pelo CNPJ do órgão,
-- usando a UF mais frequente dos editais já coletados do mesmo órgão. O que sobrar é resolvido pelo coletor (BrasilAPI).
create index if not exists oportunidades_orgao_cnpj on public.oportunidades (orgao_cnpj);

create or replace function public.preencher_uf_pca() returns int
language plpgsql security definer set search_path = public set statement_timeout = '10min' as $$
declare n int;
begin
  with m as (
    select orgao_cnpj, mode() within group (order by uf) uf
    from public.oportunidades
    where uf is not null and orgao_cnpj in (select orgao_cnpj from public.pca_planos where uf is null)
    group by orgao_cnpj)
  update public.pca_planos p set uf = m.uf from m where p.orgao_cnpj = m.orgao_cnpj and p.uf is null;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.preencher_uf_pca() from public, anon, authenticated;
grant execute on function public.preencher_uf_pca() to service_role;
select public.preencher_uf_pca() as planos_atualizados;
