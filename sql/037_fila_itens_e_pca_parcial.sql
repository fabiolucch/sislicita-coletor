-- 037: fila de leitura de itens para a linha, códigos pendentes de resolução no catálogo, e refinamento do PCA parcial.
create table if not exists public.cat_ausentes (
  tipo char(1) not null, codigo text not null, verificado_em timestamptz not null default now(),
  primary key (tipo, codigo)
);
alter table public.cat_ausentes enable row level security;
create index if not exists corr_ref on public.correspondencias (fonte, ref_id);

-- editais abertos sem itens lidos: primeiro os que alguma linha já sugeriu e os acompanhados (para detectar mudanças)
create or replace function public.fila_itens_linha(p_limite int default 2500)
returns table (id bigint, numero_controle_pncp text, data_fim_proposta timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public._servico_ou_admin() then raise exception 'sem permissão'; end if;
  return query
  with pri as (
    select c.ref_id oid, 1 p from correspondencias c where c.fonte = 'licitacao'
    union all
    select t.oportunidade_id, 1 from triagem t join perfis_busca pb on pb.id = t.perfil_id and pb.origem = 'linha'
     where t.faixa in ('alta', 'revisao')
    union all
    select li.oportunidade_id, 0 from licitacoes_interesse li where li.status in ('a_analisar', 'em_analise', 'viavel'))
  select o.id, o.numero_controle_pncp, o.data_fim_proposta
  from oportunidades o
  left join (select oid, min(p) p from pri group by oid) x on x.oid = o.id
  where o.data_fim_proposta > now()
    and (o.itens_em is null or (x.p = 0 and o.itens_em < now() - interval '2 days'))
  order by coalesce(x.p, 2), o.data_publicacao desc
  limit least(coalesce(p_limite, 2500), 10000);
end $$;

-- códigos de item (material) e serviço vistos nos editais que ainda não estão no catálogo local
create or replace function public.cat_codigos_pendentes(p_limite int default 1500)
returns table (tipo char, codigo text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public._servico_ou_admin() then raise exception 'sem permissão'; end if;
  return query
  select distinct i.cat_tipo, i.cat_codigo from oportunidade_itens i
  where i.cat_codigo is not null
    and not exists (select 1 from cat_nos n where n.catalogo = 'compras' and n.tipo = i.cat_tipo and n.nivel = i.cat_nivel and n.codigo = i.cat_codigo)
    and not exists (select 1 from cat_ausentes a where a.tipo = i.cat_tipo and a.codigo = i.cat_codigo and a.verificado_em > now() - interval '30 days')
  limit least(coalesce(p_limite, 1500), 5000);
end $$;

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
  cross join lateral (select public._tsq_linha(case when l.nivel in ('pdm', 'item', 'servico', 'subclasse') then l.nome end, l.especialidade) q) qq
  join oportunidades op on op.objeto_tsv @@ qq.q and op.data_fim_proposta > now()
  where l.organizacao_id = o and l.modo = 'incluir' and qq.q is not null
    and not exists (select 1 from correspondencias c where c.organizacao_id = o and c.fonte = 'licitacao' and c.ref_id = op.id)
    and not exists (select 1 from _pi p where p.oportunidade_id = op.id group by p.oportunidade_id
                    having bool_and(p.cat_codigo is not null) and not bool_or(p.inc))
    and not exists (select 1 from linhas_fornecimento x where x.organizacao_id = o and x.modo = 'excluir'
                    and public._tsq_linha(case when x.nivel in ('pdm', 'item', 'servico', 'subclasse') then x.nome end, x.especialidade) is not null
                    and op.objeto_tsv @@ public._tsq_linha(case when x.nivel in ('pdm', 'item', 'servico', 'subclasse') then x.nome end, x.especialidade))
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
  -- parcial só fica quando a descrição do item planejado também cita a linha (senão é ruído do nível superior)
  delete from correspondencias c using pca_itens pi, linhas_fornecimento l
  where c.organizacao_id = o and c.fonte = 'pca' and c.evidencia = 'parcial' and pi.id = c.ref_id and l.id = c.linha_id
    and not coalesce(pi.descricao_tsv @@ public._tsq_linha(l.nome, l.especialidade), false);

  -- mensagens verificáveis

  update correspondencias c set motivo =
      'Encontrada pelo código do item (' || l.codigo || ' ' || l.nome || '): ' || c.itens_compat || ' de ' || c.itens_total || ' itens compatíveis.'
    from linhas_fornecimento l where c.organizacao_id = o and c.fonte = 'licitacao' and c.evidencia = 'codigo_item' and l.id = c.linha_id;
  update correspondencias c set motivo =
      'Encontrada ' || cat_nivel_artigo(l.nivel) || ' ' || cat_nivel_nome(l.tipo, l.nivel) || case when cat_nivel_artigo(l.nivel) = 'pela' then ' selecionada (' else ' selecionado (' end || '' || l.codigo || ' ' || l.nome || '): '
      || c.itens_compat || ' de ' || c.itens_total || ' itens compatíveis.'
    from linhas_fornecimento l where c.organizacao_id = o and c.fonte = 'licitacao' and c.evidencia = 'hierarquia' and l.id = c.linha_id;
  update correspondencias c set motivo =
      'Possível compatibilidade pela descrição do objeto ("' || c.motivo || '"); '
      || case when coalesce(c.itens_total, 0) = 0 then 'os itens ainda não foram lidos' else 'os itens não trazem código de catálogo' end || '. Revise.'
    where c.organizacao_id = o and c.fonte = 'licitacao' and c.evidencia = 'texto';
  update correspondencias c set motivo = 'Encontrada pelo código do item (' || l.codigo || ' ' || l.nome || ').'
    from linhas_fornecimento l where c.organizacao_id = o and c.fonte = 'pca' and c.evidencia = 'codigo_item' and l.id = c.linha_id;
  update correspondencias c set motivo = 'Encontrada ' || cat_nivel_artigo(l.nivel) || ' ' || cat_nivel_nome(l.tipo, l.nivel) || case when cat_nivel_artigo(l.nivel) = 'pela' then ' selecionada (' else ' selecionado (' end || '' || l.codigo || ' ' || l.nome || ').'
    from linhas_fornecimento l where c.organizacao_id = o and c.fonte = 'pca' and c.evidencia in ('classificacao', 'hierarquia') and l.id = c.linha_id;
  update correspondencias c set motivo = 'O plano informa só ' || case when cat_nivel_artigo(pi.cat_nivel) = 'pela' then 'a ' else 'o ' end || cat_nivel_nome(pi.cat_tipo, pi.cat_nivel) || ' ' || pi.cat_codigo
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
