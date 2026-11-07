-- SISLICITA - aba Servicos: uso do Gemini e metricas do banco.
-- Rode uma vez no SQL editor do Supabase.

create table if not exists public.ia_uso (
  id bigserial primary key,
  em timestamptz not null default now(),
  fase text,
  modelo text,
  chamadas int not null default 0,      -- requisicoes feitas (inclui as que falharam)
  ok int not null default 0,
  limite int not null default 0,        -- respostas 429 (limite de uso)
  falhas int not null default 0,        -- timeouts, erros 5xx e outros
  tokens_in bigint not null default 0,
  tokens_out bigint not null default 0
);
create index if not exists ia_uso_em_idx on public.ia_uso (em desc);
alter table public.ia_uso enable row level security;
drop policy if exists ia_uso_ler on public.ia_uso;
create policy ia_uso_ler on public.ia_uso for select to authenticated using (true);

create index if not exists oportunidades_pub_idx on public.oportunidades (data_publicacao);

create or replace function public.servico_resumo() returns jsonb
language plpgsql security definer set search_path = public set statement_timeout = '30s'
as $$
declare r jsonb;
begin
  if auth.uid() is null then raise exception 'nao autenticado'; end if;
  select jsonb_build_object(
    'banco_bytes', pg_database_size(current_database()),
    'tabelas', (select coalesce(jsonb_agg(t order by t.bytes desc), '[]'::jsonb) from (
        select c.relname as nome, pg_total_relation_size(c.oid) as bytes, greatest(c.reltuples, 0)::bigint as linhas
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' order by 2 desc limit 12) t),
    'editais_total', (select count(*) from oportunidades),
    'editais_abertos', (select count(*) from oportunidades where data_fim_proposta > now()),
    'editais_sem_ia', (select count(*) from oportunidades where data_fim_proposta > now() and ia_processado_em is null),
    'pub_min', (select min(data_publicacao) from oportunidades),
    'pub_max', (select max(data_publicacao) from oportunidades),
    'radar_total', (select count(*) from radar),
    'radar_sem_edital', (select count(*) from radar r2 where not exists (select 1 from edital_textos e where e.oportunidade_id = r2.oportunidade_id)),
    'por_dia', (select coalesce(jsonb_agg(jsonb_build_object('dia', d.dia, 'n', d.n) order by d.dia), '[]'::jsonb) from (
        select data_publicacao as dia, count(*) as n from oportunidades
        where data_publicacao >= current_date - 44 group by 1) d),
    'ia_por_dia', (select coalesce(jsonb_agg(jsonb_build_object('dia', d.dia, 'modelo', d.modelo, 'chamadas', d.chamadas, 'ok', d.ok, 'limite', d.limite, 'falhas', d.falhas, 'tin', d.tin, 'tout', d.tout) order by d.dia), '[]'::jsonb) from (
        select (em at time zone 'America/Sao_Paulo')::date as dia, modelo, sum(chamadas) as chamadas, sum(ok) as ok, sum(limite) as limite, sum(falhas) as falhas, sum(tokens_in) as tin, sum(tokens_out) as tout
        from ia_uso where em > now() - interval '14 days' group by 1, 2) d),
    'ia_por_fase', (select coalesce(jsonb_agg(jsonb_build_object('fase', d.fase, 'chamadas', d.chamadas, 'limite', d.limite, 'falhas', d.falhas) order by d.chamadas desc), '[]'::jsonb) from (
        select fase, sum(chamadas) as chamadas, sum(limite) as limite, sum(falhas) as falhas from ia_uso where em > now() - interval '24 hours' group by 1) d)
  ) into r;
  return r;
end $$;
grant execute on function public.servico_resumo() to authenticated;
