-- SISLICITA - Inicio rapido: o resumo pesado passa a ser calculado em segundo plano (coletor) e lido de cache.
create table if not exists public.dashboard_cache (
  id int primary key default 1 check (id = 1),
  dados jsonb not null default '{}'::jsonb,
  atualizado_em timestamptz not null default now()
);
alter table public.dashboard_cache enable row level security;
drop policy if exists dashboard_cache_sel on public.dashboard_cache;
create policy dashboard_cache_sel on public.dashboard_cache for select to authenticated using (true);

do $$
begin
  if to_regprocedure('public.dashboard_calcular()') is null then
    alter function public.dashboard_resumo() rename to dashboard_calcular;
  end if;
end $$;
alter function public.dashboard_calcular() set statement_timeout = '5min';
revoke all on function public.dashboard_calcular() from public, anon, authenticated;

create or replace function public.atualizar_dashboard() returns void
language plpgsql security definer set search_path = public, extensions set statement_timeout = '5min' as $$
begin
  insert into public.dashboard_cache(id, dados, atualizado_em) values (1, public.dashboard_calcular(), now())
  on conflict (id) do update set dados = excluded.dados, atualizado_em = excluded.atualizado_em;
end $$;
revoke all on function public.atualizar_dashboard() from public, anon, authenticated;
grant execute on function public.atualizar_dashboard() to service_role;

create or replace function public.dashboard_resumo() returns jsonb
language sql stable security definer set search_path = public set statement_timeout = '15s' as $$
  select coalesce((select dados from public.dashboard_cache where id = 1), '{}'::jsonb)
    || jsonb_build_object(
      'cache_em', (select atualizado_em from public.dashboard_cache where id = 1),
      'proc', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (select status, count(*) n from processos group by status) x),
      'sessoes7', (select count(*) from processos where data_sessao between now() and now() + interval '7 days' and status not in ('ganho','perdido','desistiu')),
      'ultima', (select jsonb_build_object('fonte', fonte, 'status', status, 'em', iniciado_em) from coletas_log order by iniciado_em desc limit 1));
$$;
grant execute on function public.dashboard_resumo() to authenticated, service_role;
