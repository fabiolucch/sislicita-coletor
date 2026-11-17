-- 034: correspondência entre a linha de fornecimento e as licitações abertas / itens do PCA.
-- Níveis de evidência (do mais forte ao mais fraco):
--   codigo_item    : o item publicado traz o mesmo código de item/serviço selecionado              → confirmada
--   hierarquia     : o código do item publicado pertence à classe/grupo/PDM… selecionado           → confirmada
--   classificacao  : (PCA) a classificação informada no plano é exatamente a selecionada          → confirmada
--   parcial        : (PCA) o plano só informa um nível acima do selecionado (ex.: só a classe)     → revisar
--   texto          : o objeto cita o nome/especialidade da linha, sem código confiável              → revisar
--   semantica      : significado parecido (perfil automático da linha, vetores)                    → revisar
-- Campos oficiais verificados (17/11/2026):
--   PNCP itens da contratação: materialOuServico, catalogo{id,nome}, catalogoCodigoItem (frequentemente nulos)
--   PNCP itens do PCA: catalogoId, classificacaoCatalogoId (1 material, 2 serviço), classificacaoSuperiorCodigo
--     (= classe para material; = grupo para serviço), pdmCodigo, codigoItem.
-- Nada aqui apaga dados existentes; colunas novas são preenchidas pelo coletor e por funções em lote.

-- ------------------------------------------------------------------ itens: dados de catálogo
alter table public.oportunidade_itens add column if not exists catalogo_id smallint;
alter table public.oportunidade_itens add column if not exists catalogo_codigo_item text;
alter table public.oportunidade_itens add column if not exists cat_tipo char(1);
alter table public.oportunidade_itens add column if not exists cat_nivel text;
alter table public.oportunidade_itens add column if not exists cat_codigo text;
alter table public.oportunidade_itens add column if not exists fonte_atualizado_em timestamptz;
create index if not exists oi_cat on public.oportunidade_itens (cat_tipo, cat_nivel, cat_codigo) where cat_codigo is not null;

alter table public.pca_itens add column if not exists catalogo_id smallint;
alter table public.pca_itens add column if not exists classificacao_catalogo_id smallint;
alter table public.pca_itens add column if not exists codigo_item text;
alter table public.pca_itens add column if not exists pdm_codigo text;
alter table public.pca_itens add column if not exists cat_tipo char(1);
alter table public.pca_itens add column if not exists cat_nivel text;
alter table public.pca_itens add column if not exists cat_codigo text;
alter table public.pca_itens add column if not exists cat_verificacao text;   -- catalogo_id | codigo_e_nome | nao_verificado
create index if not exists pi_cat on public.pca_itens (cat_tipo, cat_nivel, cat_codigo) where cat_codigo is not null;
create index if not exists pi_cat_pend on public.pca_itens (id) where cat_verificacao is null;

-- nomes dos níveis para mensagens
create or replace function public.cat_nivel_nome(p_tipo char, p_nivel text) returns text language sql immutable as $$
  select case p_nivel when 'grupo' then 'grupo' when 'classe' then 'classe' when 'pdm' then 'PDM' when 'item' then 'item'
    when 'secao' then 'seção' when 'divisao' then 'divisão' when 'subclasse' then 'subclasse' when 'servico' then 'serviço' else p_nivel end;
$$;

-- Classifica itens do PCA no catálogo. Itens antigos (sem catalogoId gravado) só são aceitos quando o código E o nome
-- da classificação superior conferem com o catálogo oficial (classe de material ou grupo de serviço) — evita colisão.
create or replace function public.pca_classificar_catalogo(p_lote int default 50000) returns int
language plpgsql security definer set search_path = public set statement_timeout = '600s' as $$
declare n int;
begin
  if not public._servico_ou_admin() then raise exception 'sem permissão'; end if;
  update pca_itens i set cat_tipo = x.t, cat_nivel = x.nv, cat_codigo = x.cod, cat_verificacao = x.ver
  from (
    select a.id, v.t,
      case when v.t = 'M' and pdm.codigo is not null then 'pdm' when v.t = 'M' then 'classe'
           when v.t = 'S' and srv.codigo is not null then 'servico' when v.t = 'S' then 'grupo' end nv,
      case when v.t = 'M' and pdm.codigo is not null then pdm.codigo when v.t = 'M' then a.classificacao_codigo
           when v.t = 'S' and srv.codigo is not null then srv.codigo when v.t = 'S' then a.classificacao_codigo end cod,
      case when v.t is null then 'nao_verificado' when a.catalogo_id = 1 then 'catalogo_id' else 'codigo_e_nome' end ver
    from (select * from pca_itens where cat_verificacao is null order by id limit p_lote) a
    left join lateral (select case
        when a.catalogo_id = 1 and a.classificacao_catalogo_id = 1 then 'M'
        when a.catalogo_id = 1 and a.classificacao_catalogo_id = 2 then 'S'
        when a.catalogo_id is not null then null
        when exists (select 1 from cat_nos c where c.catalogo = 'compras' and c.tipo = 'M' and c.nivel = 'classe' and c.codigo = a.classificacao_codigo
                       and regexp_replace(c.busca, '\s+', ' ', 'g') = regexp_replace(_norm_busca(a.classificacao_nome), '\s+', ' ', 'g')) then 'M'
        when exists (select 1 from cat_nos c where c.catalogo = 'compras' and c.tipo = 'S' and c.nivel = 'grupo' and c.codigo = a.classificacao_codigo
                       and regexp_replace(c.busca, '\s+', ' ', 'g') = regexp_replace(_norm_busca(a.classificacao_nome), '\s+', ' ', 'g')) then 'S'
      end t) v on true
    left join cat_nos pdm on v.t = 'M' and pdm.catalogo = 'compras' and pdm.tipo = 'M' and pdm.nivel = 'pdm' and pdm.codigo = a.pdm_codigo
    left join cat_nos srv on v.t = 'S' and srv.catalogo = 'compras' and srv.tipo = 'S' and srv.nivel = 'servico' and srv.codigo = a.codigo_item
  ) x where i.id = x.id;
  get diagnostics n = row_count;
  return n;
end $$;

-- ------------------------------------------------------------------ perfil automático da linha (reaproveita o motor de perfis)
alter table public.perfis_busca add column if not exists origem text not null default 'manual';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'perfis_busca_origem_ck') then
    alter table public.perfis_busca add constraint perfis_busca_origem_ck check (origem in ('manual', 'linha'));
  end if;
end $$;
create unique index if not exists perfis_linha_uq on public.perfis_busca (organizacao_id) where origem = 'linha';

-- Monta/atualiza o perfil "Linha de fornecimento" a partir das classificações. Preserva as preferências (UF, valores,
-- prazos) que a pessoa ajustou nele; só o texto muda. Retorna o id (ou null se não houver linha incluída).
create or replace function public.sincronizar_perfil_linha() returns uuid
language plpgsql security definer set search_path = public as $$
declare o uuid := public.org_atual(); t text; ex text; pid uuid;
begin
  if o is null or not public.pode_editar_org(o) then raise exception 'sem permissão'; end if;
  select string_agg(nome || coalesce(' (' || especialidade || ')', ''), '; ' order by nome) into t
    from linhas_fornecimento where organizacao_id = o and modo = 'incluir';
  select string_agg(nome || coalesce(' (' || especialidade || ')', ''), '; ' order by nome) into ex
    from linhas_fornecimento where organizacao_id = o and modo = 'excluir';
  if t is null then
    update perfis_busca set ativo = false, atualizado_em = now() where organizacao_id = o and origem = 'linha';
    return null;
  end if;
  t := 'Fornecimento de: ' || t || '.' || coalesce(' Não fornece: ' || ex || '.', '');
  insert into perfis_busca (organizacao_id, nome, ativo, prompt, origem, dias_min_abertura)
  values (o, 'Linha de fornecimento', true, t, 'linha', 0)
  on conflict (organizacao_id) where origem = 'linha' do update set
    prompt = excluded.prompt, ativo = true, atualizado_em = now(),
    emb_desc = case when perfis_busca.prompt is distinct from excluded.prompt then null else perfis_busca.emb_desc end
  returning id into pid;
  return pid;
end $$;

-- grava o vetor do perfil da linha (chamado pelo /api/perfil com o token do usuário)
create or replace function public.salvar_emb_perfil_linha(p_id uuid, p_emb text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not exists (select 1 from perfis_busca where id = p_id and origem = 'linha' and public.pode_editar_org(organizacao_id)) then
    raise exception 'perfil da linha não encontrado';
  end if;
  update perfis_busca set emb_desc = p_emb::extensions.vector, atualizado_em = now() where id = p_id;
end $$;

-- refinamentos do direcionamento automático (UF, modalidades, valores, prazo) — não mexem nas classificações
create or replace function public.refinar_linha(p_ufs text[], p_modalidades text[], p_valor_min numeric, p_valor_max numeric, p_dias int)
returns void language plpgsql security definer set search_path = public as $$
declare o uuid := public.org_atual();
begin
  if o is null or not public.pode_editar_org(o) then raise exception 'sem permissão'; end if;
  if p_valor_min is not null and p_valor_max is not null and p_valor_min > p_valor_max then raise exception 'valor mínimo maior que o máximo'; end if;
  update perfis_busca set ufs = coalesce(p_ufs, '{}'), modalidades = coalesce(p_modalidades, '{}'),
    valor_min = p_valor_min, valor_max = p_valor_max, dias_min_abertura = greatest(coalesce(p_dias, 0), 0), atualizado_em = now()
  where organizacao_id = o and origem = 'linha';
  if not found then raise exception 'cadastre a linha de fornecimento primeiro'; end if;
end $$;

-- ------------------------------------------------------------------ correspondências (por organização)
create table if not exists public.correspondencias (
  organizacao_id uuid not null references public.organizacoes(id) on delete cascade,
  fonte text not null check (fonte in ('licitacao', 'pca')),
  ref_id bigint not null,                              -- oportunidades.id ou pca_itens.id
  confianca text not null check (confianca in ('confirmada', 'revisar')),
  evidencia text not null check (evidencia in ('codigo_item', 'hierarquia', 'classificacao', 'parcial', 'texto')),
  linha_id uuid,
  itens_compat int, itens_total int, itens_sem_codigo int, itens_excluidos int,
  valor_compat numeric,
  motivo text not null,
  calculado_em timestamptz not null default now(),
  primary key (organizacao_id, fonte, ref_id)
);
alter table public.correspondencias enable row level security;
drop policy if exists corr_ler on public.correspondencias;
create policy corr_ler on public.correspondencias for select to authenticated using (public.pode_ler_org(organizacao_id));
grant select on public.correspondencias to authenticated;

create or replace function public.atualizar_correspondencias(p_org uuid default null) returns jsonb
language plpgsql security definer set search_path = public set statement_timeout = '240s' as $$
declare o uuid := coalesce(p_org, public.org_atual()); r jsonb;
begin
  if o is null or not (public.pode_ler_org(o) or public._servico_ou_admin()) then raise exception 'sem permissão'; end if;
  perform pg_advisory_xact_lock(hashtext('corresp:' || o::text));

  -- nós do catálogo alcançados por cada linha: o próprio nó e descendentes (confirma) e ancestrais (parcial)
  create temp table _alvo on commit drop as
  select distinct * from (
    select l.id linha_id, l.modo, l.tipo, l.nivel l_nivel, l.codigo l_codigo, n.nivel, n.codigo, false parcial
    from linhas_fornecimento l
    join cat_nos n on n.catalogo = l.catalogo and n.tipo = l.tipo and n.caminho @> jsonb_build_object(l.nivel, l.codigo)
    where l.organizacao_id = o and cat_ordem(n.tipo, n.nivel) >= cat_ordem(l.tipo, l.nivel)
    union all
    select l.id, l.modo, l.tipo, l.nivel, l.codigo, l.nivel, l.codigo, false
    from linhas_fornecimento l where l.organizacao_id = o
    union all
    select l.id, l.modo, l.tipo, l.nivel, l.codigo, a.nivel, a.codigo, true
    from linhas_fornecimento l
    join cat_nos a on a.catalogo = l.catalogo and a.tipo = l.tipo and l.caminho ->> a.nivel = a.codigo
    where l.organizacao_id = o and cat_ordem(a.tipo, a.nivel) < cat_ordem(l.tipo, l.nivel)
  ) z;
  create index on _alvo (tipo, nivel, codigo);

  delete from correspondencias where organizacao_id = o;

  -- licitações abertas: item a item
  create temp table _pi on commit drop as
  select t.oportunidade_id, t.numero_item, t.valor_total, t.cat_codigo,
    coalesce(bool_or(a.modo = 'incluir' and not a.parcial), false) inc,
    coalesce(bool_or(a.modo = 'excluir' and not a.parcial), false) exc,
    coalesce(bool_or(a.modo = 'incluir' and not a.parcial and a.l_nivel = t.cat_nivel), false) exato,
    (array_agg(a.linha_id order by (a.l_nivel = t.cat_nivel) desc, cat_ordem(a.tipo, a.l_nivel) desc)
       filter (where a.modo = 'incluir' and not a.parcial))[1] linha_id
  from oportunidade_itens t
  join oportunidades op on op.id = t.oportunidade_id and op.data_fim_proposta > now()
  left join _alvo a on a.tipo = t.cat_tipo and a.nivel = t.cat_nivel and a.codigo = t.cat_codigo
  group by 1, 2, 3, 4;

  insert into correspondencias (organizacao_id, fonte, ref_id, confianca, evidencia, linha_id,
    itens_compat, itens_total, itens_sem_codigo, itens_excluidos, valor_compat, motivo)
  select o, 'licitacao', p.oportunidade_id, 'confirmada',
    case when bool_or(p.exato and p.inc and not p.exc) then 'codigo_item' else 'hierarquia' end,
    (array_agg(p.linha_id order by p.exato desc) filter (where p.inc and not p.exc))[1],
    count(*) filter (where p.inc and not p.exc), count(*), count(*) filter (where p.cat_codigo is null),
    count(*) filter (where p.exc), sum(p.valor_total) filter (where p.inc and not p.exc), ''
  from _pi p group by p.oportunidade_id having bool_or(p.inc and not p.exc);

  -- objeto cita a linha, sem código que confirme (nunca quando todos os itens têm código e nenhum é compatível)
  insert into correspondencias (organizacao_id, fonte, ref_id, confianca, evidencia, linha_id, itens_total, itens_sem_codigo, motivo)
  select distinct on (op.id) o, 'licitacao', op.id, 'revisar', 'texto', l.id,
    (select count(*) from oportunidade_itens i where i.oportunidade_id = op.id),
    (select count(*) from oportunidade_itens i where i.oportunidade_id = op.id and i.cat_codigo is null),
    coalesce(nullif(l.especialidade, ''), l.nome)
  from linhas_fornecimento l
  cross join lateral (select plainto_tsquery('portuguese', coalesce(nullif(l.especialidade, ''), l.nome)) q) qq
  join oportunidades op on op.objeto_tsv @@ qq.q and op.data_fim_proposta > now()
  where l.organizacao_id = o and l.modo = 'incluir'
    and (l.nivel in ('pdm', 'item', 'servico', 'subclasse') or coalesce(l.especialidade, '') <> '')
    and numnode(qq.q) > 0
    and not exists (select 1 from correspondencias c where c.organizacao_id = o and c.fonte = 'licitacao' and c.ref_id = op.id)
    and not exists (select 1 from _pi p where p.oportunidade_id = op.id group by p.oportunidade_id
                    having bool_and(p.cat_codigo is not null) and not bool_or(p.inc))
    and not exists (select 1 from linhas_fornecimento x where x.organizacao_id = o and x.modo = 'excluir'
                    and op.objeto_tsv @@ plainto_tsquery('portuguese', coalesce(nullif(x.especialidade, ''), x.nome)))
  order by op.id, length(l.nome) desc;

  -- PCA: itens planejados (sem data ou com data a partir de 30 dias atrás)
  insert into correspondencias (organizacao_id, fonte, ref_id, confianca, evidencia, linha_id, valor_compat, motivo)
  select distinct on (pi.id) o, 'pca', pi.id,
    case when a.parcial and not (a.l_nivel = 'item' and pi.codigo_item = a.l_codigo) then 'revisar' else 'confirmada' end,
    case when a.l_nivel = 'item' and pi.codigo_item = a.l_codigo then 'codigo_item'
         when a.parcial then 'parcial'
         when a.l_nivel = pi.cat_nivel then case when pi.cat_nivel in ('pdm', 'servico') then 'codigo_item' else 'classificacao' end
         else 'hierarquia' end,
    a.linha_id, pi.valor_total, ''
  from pca_itens pi
  join _alvo a on a.tipo = pi.cat_tipo and a.nivel = pi.cat_nivel and a.codigo = pi.cat_codigo and a.modo = 'incluir'
  where pi.cat_codigo is not null and coalesce(pi.data_desejada, current_date) >= current_date - 30
    and not exists (select 1 from _alvo x where x.modo = 'excluir' and not x.parcial and x.tipo = pi.cat_tipo
                    and x.nivel = pi.cat_nivel and x.codigo = pi.cat_codigo)
  order by pi.id, (a.parcial and not (a.l_nivel = 'item' and pi.codigo_item = a.l_codigo)), (a.l_nivel = pi.cat_nivel) desc;

  -- mensagens verificáveis

  update correspondencias c set motivo =
      'Encontrada pelo código do item (' || l.codigo || ' ' || l.nome || '): ' || c.itens_compat || ' de ' || c.itens_total || ' itens compatíveis.'
    from linhas_fornecimento l where c.organizacao_id = o and c.fonte = 'licitacao' and c.evidencia = 'codigo_item' and l.id = c.linha_id;
  update correspondencias c set motivo =
      'Encontrada pela ' || cat_nivel_nome(l.tipo, l.nivel) || ' selecionada (' || l.codigo || ' ' || l.nome || '): '
      || c.itens_compat || ' de ' || c.itens_total || ' itens compatíveis.'
    from linhas_fornecimento l where c.organizacao_id = o and c.fonte = 'licitacao' and c.evidencia = 'hierarquia' and l.id = c.linha_id;
  update correspondencias c set motivo =
      'Possível compatibilidade pela descrição do objeto ("' || c.motivo || '"); '
      || case when coalesce(c.itens_total, 0) = 0 then 'os itens ainda não foram lidos' else 'os itens não trazem código de catálogo' end || '. Revise.'
    where c.organizacao_id = o and c.fonte = 'licitacao' and c.evidencia = 'texto';
  update correspondencias c set motivo = 'Encontrada pelo código do item (' || l.codigo || ' ' || l.nome || ').'
    from linhas_fornecimento l where c.organizacao_id = o and c.fonte = 'pca' and c.evidencia = 'codigo_item' and l.id = c.linha_id;
  update correspondencias c set motivo = 'Encontrada pela ' || cat_nivel_nome(l.tipo, l.nivel) || ' selecionada (' || l.codigo || ' ' || l.nome || ').'
    from linhas_fornecimento l where c.organizacao_id = o and c.fonte = 'pca' and c.evidencia in ('classificacao', 'hierarquia') and l.id = c.linha_id;
  update correspondencias c set motivo = 'O plano informa só a ' || cat_nivel_nome(pi.cat_tipo, pi.cat_nivel) || ' ' || pi.cat_codigo
      || ', que contém sua linha ' || l.codigo || ' ' || l.nome || '. Confira se o item planejado é o que você fornece.'
    from linhas_fornecimento l, pca_itens pi
    where c.organizacao_id = o and c.fonte = 'pca' and c.evidencia = 'parcial' and l.id = c.linha_id and pi.id = c.ref_id;

  select jsonb_build_object(
    'licitacoes_confirmadas', count(*) filter (where fonte = 'licitacao' and confianca = 'confirmada'),
    'licitacoes_revisar', count(*) filter (where fonte = 'licitacao' and confianca = 'revisar'),
    'pca_confirmadas', count(*) filter (where fonte = 'pca' and confianca = 'confirmada'),
    'pca_revisar', count(*) filter (where fonte = 'pca' and confianca = 'revisar'),
    'em', now()) into r
  from correspondencias where organizacao_id = o;
  return r;
end $$;

grant execute on function public.sincronizar_perfil_linha(), public.salvar_emb_perfil_linha(uuid, text),
  public.refinar_linha(text[], text[], numeric, numeric, int), public.atualizar_correspondencias(uuid) to authenticated;
grant execute on function public.atualizar_correspondencias(uuid) to service_role;
revoke all on function public.pca_classificar_catalogo(int) from public, anon, authenticated;
grant execute on function public.pca_classificar_catalogo(int), public.cat_completar() to service_role;
