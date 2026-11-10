-- 023: Início de organizações cliente: dados públicos (editais, PCA) + números do radar/perfis da própria organização.
-- Antes (021) o cache global só era usado pela plataforma e o cliente via tudo zerado.
create or replace function public.dashboard_resumo() returns jsonb
language sql stable security definer set search_path = public set statement_timeout = '15s' as $$
  with c as (select coalesce((select dados from dashboard_cache where id = 1), '{}'::jsonb) d),
  plat as (select public.eh_admin_plataforma() or exists (select 1 from organizacoes o where o.tipo = 'plataforma' and o.id in (select public.minhas_orgs())) p)
  select (select case when (select p from plat) then c.d else c.d - 'radar' - 'radar_novo' - 'ia_pend' - 'por_perfil' end from c)
    || case when (select p from plat) then '{}'::jsonb else jsonb_build_object(
      'radar', (select count(distinct r.oportunidade_id) from radar r join oportunidades o on o.id = r.oportunidade_id
                where r.perfil_id in (select public.meus_perfis()) and o.data_fim_proposta >= now() and r.status <> 'descartado'),
      'radar_novo', (select count(distinct r.oportunidade_id) from radar r join oportunidades o on o.id = r.oportunidade_id
                where r.perfil_id in (select public.meus_perfis()) and o.data_fim_proposta >= now() and r.status = 'novo'),
      'ia_pend', (select count(distinct o.id) from radar r join oportunidades o on o.id = r.oportunidade_id
                where r.perfil_id in (select public.meus_perfis()) and o.ia_processado_em is null and o.data_fim_proposta >= now()),
      'por_perfil', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
                select p.id, p.nome, count(o.id) n, round(avg(r.score)) media from perfis_busca p
                left join radar r on r.perfil_id = p.id and r.status <> 'descartado' and r.oportunidade_id is not null
                left join oportunidades o on o.id = r.oportunidade_id and o.data_fim_proposta >= now()
                where p.ativo and p.id in (select public.meus_perfis()) group by p.id, p.nome order by n desc) x)
    ) end
    || jsonb_build_object(
      'cache_em', (select atualizado_em from dashboard_cache where id = 1),
      'proc', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (select status, count(*) n from processos where public.pode_ler_org(organizacao_id) group by status) x),
      'sessoes7', (select count(*) from processos where public.pode_ler_org(organizacao_id) and data_sessao between now() and now() + interval '7 days' and status not in ('ganho','perdido','desistiu')),
      'ultima', (select jsonb_build_object('fonte', fonte, 'status', status, 'em', iniciado_em) from coletas_log order by iniciado_em desc limit 1));
$$;
grant execute on function public.dashboard_resumo() to authenticated, service_role;
