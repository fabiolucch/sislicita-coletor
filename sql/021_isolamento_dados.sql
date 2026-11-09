-- 021: isolamento por organização (passo 2). Editais, PCA, catálogo e preços continuam base compartilhada.
-- Tudo que pertence ao cliente (perfis, radar, empresas, processos, comissões, favoritos, alertas, briefings, triagem)
-- passa a ser visível/alterável só por quem tem vínculo ativo com a organização dona (e, para leitura, pela plataforma).

-- A. funções auxiliares
create or replace function public.meus_perfis() returns setof uuid language sql stable security definer set search_path = public as $$
  select id from perfis_busca where public.pode_ler_org(organizacao_id);
$$;
create or replace function public.perfis_editaveis() returns setof uuid language sql stable security definer set search_path = public as $$
  select id from perfis_busca where public.pode_editar_org(organizacao_id);
$$;
-- chamada de serviço (coletor/SQL editor) ou administrador da plataforma
create or replace function public._servico_ou_admin() returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(auth.role(), '') = 'service_role' or session_user in ('postgres', 'supabase_admin') or public.eh_admin_plataforma();
$$;
create or replace function public._perfil_ok(p uuid) returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(coalesce(auth.role(), '') = 'service_role' or session_user in ('postgres', 'supabase_admin')
    or public.pode_editar_org((select organizacao_id from perfis_busca where id = p)), false);
$$;
grant execute on function public.meus_perfis(), public.perfis_editaveis(), public._servico_ou_admin(), public._perfil_ok(uuid) to authenticated, service_role;

-- B. coluna organizacao_id (default = organização ativa de quem grava) + migração dos dados atuais
do $b$
declare t text; o uuid := (select id from organizacoes where tipo = 'plataforma' order by criado_em limit 1);
begin
  if o is null then raise exception 'rode antes a 020 (organizacao principal nao existe)'; end if;
  foreach t in array array['perfis_busca','empresas','processos','contratos_comissao','favoritos','alertas'] loop
    execute format('alter table public.%I add column if not exists organizacao_id uuid references public.organizacoes(id) on delete cascade', t);
    execute format('update public.%I set organizacao_id = %L where organizacao_id is null', t, o);
    execute format('alter table public.%I alter column organizacao_id set default public.org_atual()', t);
    if t <> 'alertas' then execute format('alter table public.%I alter column organizacao_id set not null', t); end if;
    execute format('create index if not exists %I on public.%I (organizacao_id)', t || '_org', t);
  end loop;
end $b$;

-- favoritos: a chave passa a ser (organização, edital)
do $f$
declare c text;
begin
  select conname into c from pg_constraint where conrelid = 'public.favoritos'::regclass and contype = 'p';
  if c is not null and not exists (select 1 from pg_constraint k join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey) where k.conrelid = 'public.favoritos'::regclass and k.contype = 'p' and a.attname = 'organizacao_id') then
    execute format('alter table public.favoritos drop constraint %I', c);
    alter table public.favoritos add primary key (organizacao_id, oportunidade_id);
  end if;
end $f$;

-- C. políticas RLS (as antigas "todos os autenticados" são removidas)
do $p$
declare t text; pol record;
begin
  foreach t in array array['perfis_busca','radar','matches','avaliacoes_ia','avaliacoes_pca','briefings','funil_diario','triagem','triagem_pca','empresas','empresa_docs','processos','contratos_comissao','favoritos','alertas'] loop
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', pol.policyname, t);
    end loop;
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $p$;

-- tabelas com perfil_id: dono é a organização do perfil
do $p$
declare t text;
begin
  foreach t in array array['radar','avaliacoes_ia','avaliacoes_pca','briefings','funil_diario','triagem','triagem_pca'] loop
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = t and column_name = 'perfil_id') then
      raise exception 'tabela % sem perfil_id', t;
    end if;
    execute format('create policy %I on public.%I for select to authenticated using (perfil_id in (select public.meus_perfis()))', t || '_ler', t);
    execute format('create policy %I on public.%I for all to authenticated using (perfil_id in (select public.perfis_editaveis())) with check (perfil_id in (select public.perfis_editaveis()))', t || '_esc', t);
  end loop;
end $p$;

-- tabelas com organizacao_id
do $p$
declare t text;
begin
  foreach t in array array['perfis_busca','empresas','contratos_comissao','favoritos'] loop
    execute format('create policy %I on public.%I for select to authenticated using (public.pode_ler_org(organizacao_id))', t || '_ler', t);
    execute format('create policy %I on public.%I for all to authenticated using (public.pode_editar_org(organizacao_id)) with check (public.pode_editar_org(organizacao_id))', t || '_esc', t);
  end loop;
end $p$;
create policy alertas_ler on public.alertas for select to authenticated using (public.pode_ler_org(organizacao_id));
create policy processos_ler on public.processos for select to authenticated using (public.pode_ler_org(organizacao_id));
create policy processos_esc on public.processos for all to authenticated
  using (public.pode_editar_org(organizacao_id))
  with check (public.pode_editar_org(organizacao_id) and empresa_id in (select id from public.empresas));
create policy matches_ler on public.matches for select to authenticated using (radar_id in (select id from public.radar));
create policy matches_esc on public.matches for all to authenticated
  using (radar_id in (select id from public.radar where perfil_id in (select public.perfis_editaveis())))
  with check (radar_id in (select id from public.radar where perfil_id in (select public.perfis_editaveis())));
create policy empresa_docs_ler on public.empresa_docs for select to authenticated using (empresa_id in (select id from public.empresas));
create policy empresa_docs_esc on public.empresa_docs for all to authenticated
  using (empresa_id in (select id from public.empresas where public.pode_editar_org(organizacao_id)))
  with check (empresa_id in (select id from public.empresas where public.pode_editar_org(organizacao_id)));
grant select, insert, delete on public.favoritos to authenticated;

-- resumo do Início: o cache global só aparece para a organização da plataforma
drop policy if exists dashboard_cache_sel on public.dashboard_cache;
create policy dashboard_cache_sel on public.dashboard_cache for select to authenticated
  using (public.eh_admin_plataforma() or exists (select 1 from public.organizacoes o where o.tipo = 'plataforma' and o.id in (select public.minhas_orgs())));

create or replace function public.dashboard_resumo() returns jsonb
language sql stable security definer set search_path = public set statement_timeout = '15s' as $$
  select (case when public.eh_admin_plataforma() or exists (select 1 from organizacoes o where o.tipo = 'plataforma' and o.id in (select public.minhas_orgs()))
               then coalesce((select dados from dashboard_cache where id = 1), '{}'::jsonb) else '{}'::jsonb end)
    || jsonb_build_object(
      'cache_em', (select atualizado_em from dashboard_cache where id = 1),
      'proc', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (select status, count(*) n from processos where public.pode_ler_org(organizacao_id) group by status) x),
      'sessoes7', (select count(*) from processos where public.pode_ler_org(organizacao_id) and data_sessao between now() and now() + interval '7 days' and status not in ('ganho','perdido','desistiu')),
      'ultima', (select jsonb_build_object('fonte', fonte, 'status', status, 'em', iniciado_em) from coletas_log order by iniciado_em desc limit 1));
$$;

-- D. funções de perfil só para quem edita a organização dona do perfil
do $p$
declare f record; d text; novo text;
begin
  for f in select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('compor_perfil','triar_perfil','triar_pca','radar_v2') loop
    d := pg_get_functiondef(f.oid);
    continue when d like '%_perfil_ok%';
    if d ~ 'if not _autorizado\(\) then raise exception ''nao autenticado''; end if;' then
      novo := regexp_replace(d, 'if not _autorizado\(\) then raise exception ''nao autenticado''; end if;', 'if not public._perfil_ok(p_id) then raise exception ''sem permissao neste perfil''; end if;');
    else
      novo := regexp_replace(d, '\mbegin\M', E'begin\n  if not public._perfil_ok(p_id) then raise exception ''sem permissao neste perfil''; end if;', 'i');
    end if;
    if novo = d then raise exception 'nao consegui proteger %', f.proname; end if;
    execute novo;
  end loop;
  -- relatório do serviço: só plataforma
  for f in select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'servico_resumo' loop
    d := pg_get_functiondef(f.oid);
    continue when d like '%_servico_ou_admin%';
    novo := regexp_replace(d, '\mbegin\M', E'begin\n  if not public._servico_ou_admin() then raise exception ''restrito a plataforma''; end if;', 'i');
    if novo = d then raise exception 'nao consegui proteger servico_resumo'; end if;
    execute novo;
  end loop;
  -- rotinas de manutenção global: só serviço
  for f in select p.oid, p.proname, pg_get_function_identity_arguments(p.oid) as args from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('calcular_interesse','triar_todos','limpar_antigos','limpar_mercado') loop
    execute format('revoke execute on function public.%I(%s) from public, anon, authenticated', f.proname, f.args);
    execute format('grant execute on function public.%I(%s) to service_role', f.proname, f.args);
  end loop;
end $p$;

-- E. papel legado (telas Serviço/Usuários): administrador = administrador da plataforma
create or replace function public.meu_papel() returns text language sql stable security definer set search_path = public as $$
  select case when public.eh_admin_plataforma() then 'admin'
              when public.papel_na_org(public.org_atual()) = 'leitor' then 'leitor'
              when public.papel_na_org(public.org_atual()) is not null then 'editor'
              else 'leitor' end;
$$;
