-- 041: resumo_linha() levava ~34 s porque contava 630 mil editais a cada abertura de tela (abertas, itens, última coleta).
-- Os números globais passam a vir de uma tabela de 1 linha atualizada pelo coletor (mesmo padrão de dashboard_cache).
create table if not exists public.resumo_global (id int primary key default 1 check (id = 1), dados jsonb not null default '{}', atualizado_em timestamptz not null default now());
alter table public.resumo_global enable row level security;
revoke all on public.resumo_global from anon, authenticated;

create or replace function public.atualizar_resumo_global() returns void
language plpgsql security definer set search_path = public set statement_timeout = '180s' as $$
begin
  if not public._servico_ou_admin() then raise exception 'sem permissão'; end if;
  insert into resumo_global (id, dados, atualizado_em) values (1, jsonb_build_object(
    'abertas', (select count(*) from oportunidades where data_fim_proposta > now()),
    'abertas_com_itens', (select count(*) from oportunidades where data_fim_proposta > now() and itens_em is not null),
    'itens_com_codigo', (select count(*) from oportunidade_itens i join oportunidades op on op.id = i.oportunidade_id where op.data_fim_proposta > now() and i.cat_codigo is not null),
    'ultima_coleta', (select max(coletado_em) from oportunidades)), now())
  on conflict (id) do update set dados = excluded.dados, atualizado_em = excluded.atualizado_em;
end $$;
revoke all on function public.atualizar_resumo_global() from public, anon, authenticated;

create or replace function public.resumo_linha() returns jsonb
language sql stable security definer set search_path = public as $$
  with o as (select public.org_atual() id), g as (select coalesce((select dados from resumo_global where id = 1), '{}'::jsonb) d)
  select case when not public.pode_ler_org((select id from o)) then null else jsonb_build_object(
    'linhas_incluir', (select count(*) from linhas_fornecimento where organizacao_id = (select id from o) and modo = 'incluir'),
    'linhas_excluir', (select count(*) from linhas_fornecimento where organizacao_id = (select id from o) and modo = 'excluir'),
    'lic_confirmadas', (select count(*) from correspondencias c join oportunidades op on op.id = c.ref_id
                         where c.organizacao_id = (select id from o) and c.fonte = 'licitacao' and c.confianca = 'confirmada' and op.data_fim_proposta > now()),
    'lic_revisar', (select count(*) from correspondencias c join oportunidades op on op.id = c.ref_id
                     where c.organizacao_id = (select id from o) and c.fonte = 'licitacao' and c.confianca = 'revisar' and op.data_fim_proposta > now()),
    'pca_confirmadas', (select count(*) from correspondencias where organizacao_id = (select id from o) and fonte = 'pca' and confianca = 'confirmada'),
    'pca_revisar', (select count(*) from correspondencias where organizacao_id = (select id from o) and fonte = 'pca' and confianca = 'revisar'),
    'calculado_em', (select max(calculado_em) from correspondencias where organizacao_id = (select id from o)),
    'perfil_linha', (select jsonb_build_object('id', id, 'triado_em', triado_em, 'tem_vetor', emb is not null, 'ufs', ufs,
                       'modalidades', modalidades, 'valor_min', valor_min, 'valor_max', valor_max, 'dias', dias_min_abertura)
                     from perfis_busca where organizacao_id = (select id from o) and origem = 'linha'),
    'abertas', (select d->'abertas' from g), 'abertas_com_itens', (select d->'abertas_com_itens' from g),
    'itens_com_codigo', (select d->'itens_com_codigo' from g), 'ultima_coleta', (select d->'ultima_coleta' from g),
    'catalogo_em', (select max(concluido_em) from cat_sync where status = 'ok')) end;
$$;
