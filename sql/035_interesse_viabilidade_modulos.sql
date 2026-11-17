-- 035: licitações de interesse e análise de viabilidade; leitura direcionada pela linha; desligamento reversível de
-- assessoria, disputa e acompanhamento de processos (dados e históricos preservados; nada é apagado).

-- ------------------------------------------------------------------ licitações de interesse (uma por empresa e oportunidade)
create table if not exists public.licitacoes_interesse (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null default public.org_atual() references public.organizacoes(id) on delete cascade,
  oportunidade_id bigint not null references public.oportunidades(id),
  status text not null default 'a_analisar' check (status in ('a_analisar', 'em_analise', 'viavel', 'inviavel', 'arquivada')),
  itens_sel int[] not null default '{}',          -- números dos itens avaliados
  lotes jsonb not null default '[]'::jsonb,       -- agrupamentos informados pelo usuário (a API do PNCP não traz lote)
  premissas jsonb not null default '{}'::jsonb,   -- custos, tributos, margem, prazos, cenários (o que o usuário informou)
  resultado jsonb,                                -- saída da calculadora no momento em que foi salva
  snapshot jsonb,                                 -- dados oficiais quando a análise foi salva (para detectar mudanças)
  snapshot_em timestamptz,
  analisado_em timestamptz,
  decisao_obs text, decisao_por uuid, decisao_em timestamptz,
  criado_por uuid default auth.uid(),
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (organizacao_id, oportunidade_id)
);
create index if not exists li_org on public.licitacoes_interesse (organizacao_id, status);
alter table public.licitacoes_interesse enable row level security;
drop policy if exists li_ler on public.licitacoes_interesse;
create policy li_ler on public.licitacoes_interesse for select to authenticated using (public.pode_ler_org(organizacao_id));
grant select on public.licitacoes_interesse to authenticated;

-- retrato dos dados oficiais que importam para a análise
create or replace function public._snap_oportunidade(p_id bigint) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'valor_estimado', o.valor_estimado, 'data_fim_proposta', o.data_fim_proposta, 'situacao', o.situacao,
    'objeto_md5', md5(coalesce(o.objeto, '')), 'atualizado_em', o.atualizado_em,
    'itens', (select count(*) from oportunidade_itens i where i.oportunidade_id = o.id),
    'itens_md5', (select md5(coalesce(string_agg(i.numero_item || ':' || coalesce(i.quantidade::text, '') || ':' || coalesce(i.valor_total::text, '')
                  || ':' || coalesce(i.situacao, ''), '|' order by i.numero_item), '')) from oportunidade_itens i where i.oportunidade_id = o.id))
  from oportunidades o where o.id = p_id;
$$;

-- "Analisar viabilidade": salva em Licitações de interesse e devolve a análise (reaproveita a existente)
create or replace function public.analisar_viabilidade(p_oportunidade bigint) returns uuid
language plpgsql security definer set search_path = public as $$
declare o uuid := public.org_atual(); rid uuid;
begin
  if o is null or not public.pode_editar_org(o) then raise exception 'sem permissão'; end if;
  if not exists (select 1 from oportunidades where id = p_oportunidade) then raise exception 'oportunidade não encontrada'; end if;
  insert into licitacoes_interesse (organizacao_id, oportunidade_id, status, snapshot, snapshot_em)
  values (o, p_oportunidade, 'em_analise', public._snap_oportunidade(p_oportunidade), now())
  on conflict (organizacao_id, oportunidade_id) do update set
    status = case when licitacoes_interesse.status in ('a_analisar', 'arquivada') then 'em_analise' else licitacoes_interesse.status end,
    atualizado_em = now()
  returning id into rid;
  return rid;
end $$;

-- só marcar interesse (sem abrir a análise)
create or replace function public.marcar_interesse(p_oportunidade bigint) returns uuid
language plpgsql security definer set search_path = public as $$
declare o uuid := public.org_atual(); rid uuid;
begin
  if o is null or not public.pode_editar_org(o) then raise exception 'sem permissão'; end if;
  insert into licitacoes_interesse (organizacao_id, oportunidade_id, snapshot, snapshot_em)
  values (o, p_oportunidade, public._snap_oportunidade(p_oportunidade), now())
  on conflict (organizacao_id, oportunidade_id) do update set atualizado_em = now()
  returning id into rid;
  return rid;
end $$;

create or replace function public.salvar_viabilidade(p_id uuid, p_itens int[], p_lotes jsonb, p_premissas jsonb, p_resultado jsonb)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare t timestamptz := now();
begin
  if not exists (select 1 from licitacoes_interesse where id = p_id and public.pode_editar_org(organizacao_id)) then
    raise exception 'análise não encontrada';
  end if;
  if octet_length(coalesce(p_premissas, '{}')::text) > 200000 or octet_length(coalesce(p_resultado, '{}')::text) > 200000 then
    raise exception 'análise grande demais';
  end if;
  update licitacoes_interesse set itens_sel = coalesce(p_itens, '{}'), lotes = coalesce(p_lotes, '[]'),
    premissas = coalesce(p_premissas, '{}'), resultado = p_resultado,
    snapshot = public._snap_oportunidade(oportunidade_id), snapshot_em = t, analisado_em = t, atualizado_em = t,
    status = case when status = 'a_analisar' then 'em_analise' else status end
  where id = p_id;
  return t;
end $$;

-- decisão interna (não cria processo nem disputa)
create or replace function public.decidir_interesse(p_id uuid, p_status text, p_obs text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_status not in ('a_analisar', 'em_analise', 'viavel', 'inviavel', 'arquivada') then raise exception 'situação inválida'; end if;
  update licitacoes_interesse set status = p_status, decisao_obs = left(p_obs, 1000), decisao_por = auth.uid(),
    decisao_em = now(), atualizado_em = now()
  where id = p_id and public.pode_editar_org(organizacao_id);
  if not found then raise exception 'análise não encontrada'; end if;
end $$;

-- lista com o que mudou nos dados oficiais desde a última análise salva
create or replace function public.listar_interesses(p_status text default null) returns table (
  id uuid, oportunidade_id bigint, status text, analisado_em timestamptz, atualizado_em timestamptz, decisao_obs text,
  resultado jsonb, objeto text, orgao_nome text, uf text, municipio text, modalidade text, valor_estimado numeric,
  valor_sigiloso boolean, data_fim_proposta timestamptz, situacao text, link_pncp text, numero_controle_pncp text,
  mudancas text[], confianca text, motivo text)
language sql stable security definer set search_path = public as $$
  select li.id, li.oportunidade_id, li.status, li.analisado_em, li.atualizado_em, li.decisao_obs, li.resultado,
    op.objeto, op.orgao_nome, op.uf, op.municipio, op.modalidade, op.valor_estimado, op.valor_sigiloso,
    op.data_fim_proposta, op.situacao, op.link_pncp, op.numero_controle_pncp,
    array_remove(array[
      case when (li.snapshot->>'valor_estimado')::numeric is distinct from op.valor_estimado then 'valor estimado' end,
      case when (li.snapshot->>'data_fim_proposta')::timestamptz is distinct from op.data_fim_proposta then 'prazo de propostas' end,
      case when li.snapshot->>'situacao' is distinct from op.situacao then 'situação' end,
      case when li.snapshot->>'objeto_md5' is distinct from md5(coalesce(op.objeto, '')) then 'objeto' end,
      case when li.snapshot->>'itens_md5' is distinct from (s.j->>'itens_md5') then 'itens' end], null),
    c.confianca, c.motivo
  from licitacoes_interesse li
  join oportunidades op on op.id = li.oportunidade_id
  cross join lateral (select public._snap_oportunidade(op.id) j) s
  left join correspondencias c on c.organizacao_id = li.organizacao_id and c.fonte = 'licitacao' and c.ref_id = li.oportunidade_id
  where li.organizacao_id = public.org_atual() and public.pode_ler_org(li.organizacao_id)
    and (p_status is null or li.status = p_status)
  order by case li.status when 'em_analise' then 0 when 'a_analisar' then 1 when 'viavel' then 2 when 'inviavel' then 3 else 4 end,
    op.data_fim_proposta nulls last;
$$;

grant execute on function public.analisar_viabilidade(bigint), public.marcar_interesse(bigint),
  public.salvar_viabilidade(uuid, int[], jsonb, jsonb, jsonb), public.decidir_interesse(uuid, text, text),
  public.listar_interesses(text) to authenticated;
revoke all on function public._snap_oportunidade(bigint) from public, anon;

-- ------------------------------------------------------------------ leitura: licitações direcionadas pela linha
create or replace function public.oportunidades_linha(p_conf text default null, p_busca text default null, p_uf text default null,
  p_ordem text default 'prazo', p_limite int default 30, p_offset int default 0, p_aplicar_refinos boolean default true)
returns table (id bigint, numero_controle_pncp text, objeto text, orgao_nome text, unidade_nome text, uf text, municipio text,
  modalidade text, valor_estimado numeric, valor_sigiloso boolean, data_publicacao date, data_fim_proposta timestamptz,
  situacao text, link_pncp text, atualizado_em timestamptz, ia_resumo text, ia_atencao text,
  confianca text, evidencia text, motivo text, itens_compat int, itens_total int, itens_sem_codigo int, valor_compat numeric,
  nota int, interesse text, total bigint)
language plpgsql stable security definer set search_path = public as $$
declare o uuid := public.org_atual(); pf perfis_busca; q tsquery;
begin
  if o is null or not public.pode_ler_org(o) then raise exception 'sem permissão'; end if;
  select * into pf from perfis_busca where organizacao_id = o and origem = 'linha';
  if coalesce(trim(p_busca), '') <> '' then q := websearch_to_tsquery('portuguese', p_busca); end if;
  return query
  with base as (
    select c.ref_id, c.confianca, c.evidencia, c.motivo, c.itens_compat, c.itens_total, c.itens_sem_codigo, c.valor_compat, null::int nota
    from correspondencias c where c.organizacao_id = o and c.fonte = 'licitacao'
    union all
    select t.oportunidade_id, 'revisar', 'semantica',
      'Possível compatibilidade pelo significado do objeto (semelhança ' || t.nota || '/100); revise.', null, null, null, null, t.nota
    from triagem t
    where pf.id is not null and t.perfil_id = pf.id and t.faixa in ('alta', 'revisao')
      and not exists (select 1 from correspondencias c where c.organizacao_id = o and c.fonte = 'licitacao' and c.ref_id = t.oportunidade_id)
  )
  select op.id, op.numero_controle_pncp, op.objeto, op.orgao_nome, op.unidade_nome, op.uf, op.municipio, op.modalidade,
    op.valor_estimado, op.valor_sigiloso, op.data_publicacao, op.data_fim_proposta, op.situacao, op.link_pncp, op.atualizado_em,
    op.ia_resumo, op.ia_atencao,
    b.confianca, b.evidencia, b.motivo, b.itens_compat, b.itens_total, b.itens_sem_codigo, b.valor_compat, b.nota,
    (select li.status from licitacoes_interesse li where li.organizacao_id = o and li.oportunidade_id = op.id),
    count(*) over ()
  from base b join oportunidades op on op.id = b.ref_id
  where op.data_fim_proposta > now()
    and (p_conf is null or b.confianca = p_conf)
    and (p_uf is null or op.uf = p_uf)
    and (q is null or op.objeto_tsv @@ q)
    and (not p_aplicar_refinos or pf.id is null or (
          (cardinality(pf.ufs) = 0 or op.uf = any(pf.ufs))
      and (cardinality(pf.modalidades) = 0 or op.modalidade = any(pf.modalidades))
      and (pf.valor_min is null or op.valor_sigiloso or coalesce(op.valor_estimado, 0) = 0 or op.valor_estimado >= pf.valor_min)
      and (pf.valor_max is null or op.valor_sigiloso or op.valor_estimado is null or op.valor_estimado <= pf.valor_max)
      and (op.data_fim_proposta >= now() + make_interval(days => coalesce(pf.dias_min_abertura, 0)))))
  order by (b.confianca = 'confirmada') desc,
    case when p_ordem = 'valor' then -coalesce(b.valor_compat, op.valor_estimado, 0) else 0 end,
    case when p_ordem = 'recentes' then -extract(epoch from op.data_publicacao::timestamptz) else 0 end,
    op.data_fim_proposta
  limit least(coalesce(p_limite, 30), 100) offset coalesce(p_offset, 0);
end $$;

-- ------------------------------------------------------------------ leitura: compras planejadas (PCA)
create or replace function public.pca_linha(p_conf text default null, p_uf text default null, p_ano int default null,
  p_de date default null, p_ate date default null, p_orgao text default null, p_limite int default 30, p_offset int default 0)
returns table (id bigint, descricao text, orgao_cnpj text, orgao_nome text, nome_unidade text, uf text, ano int,
  categoria text, classificacao_codigo text, classificacao_nome text, cat_tipo char, codigo_item text, pdm_codigo text,
  quantidade numeric, unidade_medida text, valor_unitario numeric, valor_total numeric, data_desejada date,
  plano_atualizado_em timestamptz, item_atualizado_em timestamptz,
  confianca text, evidencia text, motivo text, nota int,
  licitacao_provavel_id bigint, licitacao_provavel_objeto text, total bigint)
language plpgsql stable security definer set search_path = public as $$
declare o uuid := public.org_atual(); pf perfis_busca;
begin
  if o is null or not public.pode_ler_org(o) then raise exception 'sem permissão'; end if;
  select * into pf from perfis_busca where organizacao_id = o and origem = 'linha';
  return query
  with base as (
    select c.ref_id, c.confianca, c.evidencia, c.motivo, c.linha_id, null::int nota
    from correspondencias c where c.organizacao_id = o and c.fonte = 'pca'
    union all
    select t.pca_item_id, 'revisar', 'semantica',
      'Possível compatibilidade pelo significado da descrição (semelhança ' || t.nota || '/100); revise.', null::uuid, t.nota
    from triagem_pca t
    where pf.id is not null and t.perfil_id = pf.id and t.faixa in ('alta', 'revisao')
      and not exists (select 1 from correspondencias c where c.organizacao_id = o and c.fonte = 'pca' and c.ref_id = t.pca_item_id)
  )
  select pi.id, pi.descricao, pl.orgao_cnpj, pl.orgao_nome, pi.nome_unidade, pl.uf, pl.ano, pi.categoria,
    pi.classificacao_codigo, pi.classificacao_nome, pi.cat_tipo, pi.codigo_item, pi.pdm_codigo,
    pi.quantidade, pi.unidade_medida, pi.valor_unitario, pi.valor_total, pi.data_desejada,
    pl.data_atualizacao, pi.atualizado_em,
    b.confianca, b.evidencia, b.motivo, b.nota,
    lp.id, lp.objeto,
    count(*) over ()
  from base b
  join pca_itens pi on pi.id = b.ref_id
  join pca_planos pl on pl.id = pi.plano_id
  -- licitação aberta do MESMO órgão já encontrada pela MESMA linha: vínculo provável (não oficial)
  left join lateral (
    select op.id, op.objeto from correspondencias c2 join oportunidades op on op.id = c2.ref_id
    where b.linha_id is not null and c2.organizacao_id = o and c2.fonte = 'licitacao' and c2.confianca = 'confirmada'
      and c2.linha_id = b.linha_id and op.orgao_cnpj = pl.orgao_cnpj and op.data_fim_proposta > now()
    order by op.data_publicacao desc limit 1) lp on true
  where (p_conf is null or b.confianca = p_conf)
    and (p_uf is null or pl.uf = p_uf)
    and (p_ano is null or pl.ano = p_ano)
    and (p_de is null or pi.data_desejada >= p_de)
    and (p_ate is null or pi.data_desejada <= p_ate)
    and (p_orgao is null or pl.orgao_nome ilike '%' || p_orgao || '%')
    and (pf.id is null or cardinality(pf.ufs) = 0 or pl.uf = any(pf.ufs))
  order by (b.confianca = 'confirmada') desc, pi.data_desejada nulls last, pi.valor_total desc nulls last
  limit least(coalesce(p_limite, 30), 100) offset coalesce(p_offset, 0);
end $$;

-- resumo para a tela inicial e a tela Empresa
create or replace function public.resumo_linha() returns jsonb
language sql stable security definer set search_path = public as $$
  with o as (select public.org_atual() id)
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
    'abertas', (select count(*) from oportunidades where data_fim_proposta > now()),
    'abertas_com_itens', (select count(*) from oportunidades where data_fim_proposta > now() and itens_em is not null),
    'itens_com_codigo', (select count(*) from oportunidade_itens i join oportunidades op on op.id = i.oportunidade_id
                         where op.data_fim_proposta > now() and i.cat_codigo is not null),
    'ultima_coleta', (select max(coletado_em) from oportunidades),
    'catalogo_em', (select max(concluido_em) from cat_sync where status = 'ok')) end;
$$;


grant execute on function public.oportunidades_linha(text, text, text, text, int, int, boolean),
  public.pca_linha(text, text, int, date, date, text, int, int), public.resumo_linha() to authenticated;

-- ------------------------------------------------------------------ desligamento reversível (flags em app_flags)
-- Operações exclusivas: sem execução por usuários. Para reativar: grant execute ... to authenticated e app_flags.ativo = true.
do $$ declare f text; begin
  foreach f in array array[
    'atualizar_cobranca(bigint, text, date, text)', 'cancelar_assessoria(bigint)', 'confirmar_contrato_assessoria(bigint)',
    'confirmar_empenho_assessoria(bigint)', 'confirmar_resultado_assessoria(bigint, text)',
    'definir_assessoria_processo(bigint, numeric, numeric, text, numeric)', 'listar_assessorias()',
    'propor_assessoria(bigint, numeric, numeric, text, numeric)', 'responder_assessoria(bigint, boolean)',
    'salvar_parametros_assessoria(jsonb)', 'solicitar_assessoria(bigint, text)', 'sugerir_comissao(bigint)',
    'calcular_lances(bigint)', 'disputa_resumo(bigint)', 'iniciar_disputa(bigint, bigint)',
    'mudar_situacao_disputa(bigint, text)', 'registrar_lance(bigint, integer, numeric, numeric, integer, text, text)']
  loop
    if to_regprocedure('public.' || f) is not null then
      execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    end if;
  end loop;
end $$;

-- Tabelas exclusivas: política restritiva (o histórico continua guardado; só a plataforma consulta enquanto desligado)
do $$ declare t text; m text; begin
  foreach t in array array['assessoria_parametros', 'parametros_custo', 'assessorias', 'assessoria_cobrancas', 'processo_empenhos',
                           'disputas', 'disputa_itens', 'disputa_eventos', 'processos', 'processo_viabilidade'] loop
    m := case when t in ('disputas', 'disputa_itens', 'disputa_eventos') then 'disputa'
              when t in ('processos', 'processo_viabilidade', 'processo_empenhos') then 'processos' else 'assessoria' end;
    if to_regclass('public.' || t) is not null then
      execute format('drop policy if exists modulo_desligado on public.%I', t);
      execute format('create policy modulo_desligado on public.%I as restrictive for all to authenticated using (public.flag_ativa(%L) or public.eh_admin_plataforma()) with check (public.flag_ativa(%L) or public.eh_admin_plataforma())', t, m, m);
    end if;
  end loop;
end $$;
