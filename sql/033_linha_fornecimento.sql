-- 033: base da reformulação — flags de módulos, catálogo oficial (CATMAT/CATSER do Compras.gov.br) e linha de fornecimento.
-- Fontes verificadas em 17/11/2026 (API pública, sem autenticação): https://dadosabertos.compras.gov.br
--   Material: 1_consultarGrupoMaterial → 2_consultarClasseMaterial → 3_consultarPdmMaterial → 4_consultarItemMaterial
--   Serviço:  1_consultarSecaoServico → 2_consultarDivisaoServico → 3_consultarGrupoServico → 4_consultarClasseServico
--             → 5_consultarSubClasseServico → 6_consultarItemServico
-- SICAF: a API pública de fornecedor (modulo-fornecedor/1_consultarFornecedor) não traz linhas de fornecimento e a consulta
-- pública de linhas no SICAF exige hCaptcha. Por isso a linha é DECLARADA pelo usuário (nunca "validada pelo SICAF").
-- Nada aqui apaga dados.

-- ------------------------------------------------------------------ flags de módulos (reversíveis)
create table if not exists public.app_flags (
  chave text primary key,
  ativo boolean not null,
  descricao text,
  atualizado_em timestamptz not null default now()
);
insert into public.app_flags (chave, ativo, descricao) values
  ('assessoria', false, 'Assessoria por comissão (retirada nesta versão; dados preservados)'),
  ('disputa',    false, 'Ambiente de disputa (desativado nesta versão; dados preservados)'),
  ('processos',  false, 'Acompanhamento operacional de processos (desativado nesta versão; dados preservados)')
on conflict (chave) do nothing;
alter table public.app_flags enable row level security;
drop policy if exists flags_ler on public.app_flags;
create policy flags_ler on public.app_flags for select to anon, authenticated using (true);
grant select on public.app_flags to anon, authenticated;

create or replace function public.flag_ativa(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select ativo from app_flags where chave = p), true);
$$;
grant execute on function public.flag_ativa(text) to anon, authenticated;

-- ------------------------------------------------------------------ normalização para busca
create or replace function public._norm_busca(t text) returns text language sql immutable as $$
  select lower(translate(coalesce(t, ''),
    'ÁÀÂÃÄáàâãäÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇçÑñ',
    'AAAAAaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCcNn'));
$$;

-- ------------------------------------------------------------------ catálogo oficial hierárquico
-- Identificação = (catalogo, tipo, nivel, codigo): evita colisão entre materiais e serviços e entre níveis.
-- Níveis de material: grupo, classe, pdm, item. Níveis de serviço: secao, divisao, grupo, classe, subclasse, servico.
create table if not exists public.cat_nos (
  catalogo text not null default 'compras',          -- Catálogo do Compras.gov.br (catalogoId = 1 no PNCP)
  tipo char(1) not null check (tipo in ('M', 'S')),
  nivel text not null check (nivel in ('grupo','classe','pdm','item','secao','divisao','subclasse','servico')),
  codigo text not null,                              -- representação original do código (sem zeros acrescentados)
  nome text not null,
  ativo boolean not null default true,
  caminho jsonb not null default '{}'::jsonb,         -- códigos dos ancestrais e do próprio nó, por nível
  rotulo text,                                       -- caminho legível: "89 SUBSISTÊNCIA › 8905 CARNES, AVES E PEIXES"
  busca text,                                        -- nome normalizado
  fonte_atualizado_em timestamptz,                   -- dataHoraAtualizacao informada pela API
  sincronizado_em timestamptz not null default now(),
  primary key (catalogo, tipo, nivel, codigo),
  check ((tipo = 'M' and nivel in ('grupo','classe','pdm','item')) or (tipo = 'S' and nivel in ('secao','divisao','grupo','classe','subclasse','servico')))
);
create index if not exists cat_nos_busca on public.cat_nos using gin (busca extensions.gin_trgm_ops);
create index if not exists cat_nos_caminho on public.cat_nos using gin (caminho jsonb_path_ops);
create index if not exists cat_nos_codigo on public.cat_nos (codigo);
alter table public.cat_nos enable row level security;
drop policy if exists cat_nos_ler on public.cat_nos;
create policy cat_nos_ler on public.cat_nos for select to anon, authenticated using (true);
grant select on public.cat_nos to anon, authenticated;

create table if not exists public.cat_sync (
  chave text primary key,             -- 'M:grupo', 'S:servico', ...
  total int, inseridos int, status text, erro text,
  iniciado_em timestamptz, concluido_em timestamptz
);
alter table public.cat_sync enable row level security;
drop policy if exists cat_sync_ler on public.cat_sync;
create policy cat_sync_ler on public.cat_sync for select to authenticated using (true);
grant select on public.cat_sync to authenticated;

-- ordem dos níveis (para comparação hierárquica)
create or replace function public.cat_ordem(p_tipo char, p_nivel text) returns int language sql immutable as $$
  select case when p_tipo = 'M' then array_position(array['grupo','classe','pdm','item'], p_nivel)
              else array_position(array['secao','divisao','grupo','classe','subclasse','servico'], p_nivel) end;
$$;

-- busca por nome ou código (sem carregar o catálogo no navegador)
create or replace function public.cat_buscar(p_q text, p_tipo char default null, p_limite int default 40, p_offset int default 0)
returns table (tipo char, nivel text, codigo text, nome text, ativo boolean, caminho jsonb, rotulo text, n_filhos int)
language plpgsql stable security definer set search_path = public, extensions as $$
declare q text := trim(coalesce(p_q, '')); w text[];
begin
  if q = '' then return; end if;
  p_limite := least(greatest(coalesce(p_limite, 40), 1), 100);
  if q ~ '^[0-9]+$' then
    return query
      select c.tipo, c.nivel, c.codigo, c.nome, c.ativo, c.caminho, c.rotulo,
        (select count(*)::int from cat_nos f where f.tipo = c.tipo and f.caminho @> jsonb_build_object(c.nivel, c.codigo) and f.nivel <> c.nivel)
      from cat_nos c where c.codigo = q and (p_tipo is null or c.tipo = p_tipo)
      order by c.tipo, cat_ordem(c.tipo, c.nivel) limit p_limite offset p_offset;
    return;
  end if;
  w := array(select x from unnest(regexp_split_to_array(_norm_busca(q), '\s+')) x where length(x) >= 2);
  if cardinality(w) = 0 then return; end if;
  return query
    select c.tipo, c.nivel, c.codigo, c.nome, c.ativo, c.caminho, c.rotulo, null::int
    from cat_nos c
    where (p_tipo is null or c.tipo = p_tipo)
      and not exists (select 1 from unnest(w) x where c.busca not like '%' || x || '%')
    order by c.ativo desc, similarity(c.busca, _norm_busca(q)) desc,
             cat_ordem(c.tipo, c.nivel), length(c.nome)
    limit p_limite offset p_offset;
end $$;
grant execute on function public.cat_buscar(text, char, int, int) to anon, authenticated;

-- filhos diretos de um nó (navegação por níveis); sem p_nivel = raiz do tipo
create or replace function public.cat_filhos(p_tipo char, p_nivel text default null, p_codigo text default null, p_limite int default 200, p_offset int default 0)
returns table (tipo char, nivel text, codigo text, nome text, ativo boolean, caminho jsonb, rotulo text)
language sql stable security definer set search_path = public as $$
  with alvo as (
    select case when p_nivel is null then (case when p_tipo = 'M' then 'grupo' else 'secao' end)
                when p_tipo = 'M' then (array['grupo','classe','pdm','item'])[cat_ordem('M', p_nivel) + 1]
                else (array['secao','divisao','grupo','classe','subclasse','servico'])[cat_ordem('S', p_nivel) + 1] end as nv)
  select c.tipo, c.nivel, c.codigo, c.nome, c.ativo, c.caminho, c.rotulo
  from cat_nos c, alvo a
  where c.tipo = p_tipo
    and (c.nivel = a.nv
         -- serviços sem subclasse ficam direto abaixo da classe
         or (p_tipo = 'S' and p_nivel = 'classe' and c.nivel = 'servico' and not (c.caminho ? 'subclasse')))
    and (p_nivel is null or c.caminho @> jsonb_build_object(p_nivel, p_codigo))
  order by c.ativo desc, c.nivel, c.nome
  limit least(coalesce(p_limite, 200), 500) offset coalesce(p_offset, 0);
$$;
grant execute on function public.cat_filhos(char, text, text, int, int) to anon, authenticated;

-- ------------------------------------------------------------------ carga e sincronização (só serviço/plataforma)
create extension if not exists http with schema extensions;

create or replace function public._cat_get(p_url text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r extensions.http_response; i int;
begin
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '60000');
  for i in 1..3 loop                                   -- retentativas limitadas
    begin
      r := extensions.http_get(p_url);
      if r.status = 200 then return r.content::jsonb; end if;
      if r.status in (204, 404) then return null; end if;
    exception when others then null;
    end;
    perform pg_sleep(i * 2);
  end loop;
  raise exception 'catálogo indisponível (%): %', coalesce(r.status::text, 'sem resposta'), p_url;
end $$;

-- carrega um nível inteiro (idempotente: upsert; códigos que somem da fonte são preservados)
create or replace function public.cat_sincronizar(p_tipo char, p_nivel text) returns int
language plpgsql security definer set search_path = public, extensions set statement_timeout = '900s' as $$
declare base text := 'https://dadosabertos.compras.gov.br'; ep text; tam text := ''; pag int := 1; tot int := 1;
        j jsonb; n int := 0; k int; v_chave text := p_tipo || ':' || p_nivel;
begin
  if not public._servico_ou_admin() then raise exception 'sem permissão'; end if;
  ep := case v_chave
    when 'M:grupo' then '/modulo-material/1_consultarGrupoMaterial'
    when 'M:classe' then '/modulo-material/2_consultarClasseMaterial'
    when 'M:pdm' then '/modulo-material/3_consultarPdmMaterial'
    when 'S:secao' then '/modulo-servico/1_consultarSecaoServico'
    when 'S:divisao' then '/modulo-servico/2_consultarDivisaoServico'
    when 'S:grupo' then '/modulo-servico/3_consultarGrupoServico'
    when 'S:classe' then '/modulo-servico/4_consultarClasseServico'
    when 'S:subclasse' then '/modulo-servico/5_consultarSubClasseServico'
    when 'S:servico' then '/modulo-servico/6_consultarItemServico'
  end;
  if ep is null then raise exception 'nível não sincronizável em lote: %', v_chave; end if;
  if v_chave in ('M:pdm', 'S:servico') then tam := '&tamanhoPagina=500'; end if;
  insert into cat_sync (chave, status, iniciado_em, erro) values (v_chave, 'rodando', now(), null)
  on conflict (chave) do update set status = 'rodando', iniciado_em = now(), erro = null;
  while pag <= tot loop
    j := _cat_get(base || ep || '?pagina=' || pag || tam);
    exit when j is null;
    tot := coalesce((j->>'totalPaginas')::int, 1);
    insert into cat_nos (tipo, nivel, codigo, nome, ativo, caminho, fonte_atualizado_em, busca, sincronizado_em)
    select p_tipo, p_nivel, x.codigo, x.nome, x.ativo, x.caminho, x.atu, _norm_busca(x.nome), now()
    from (
      select
        case p_nivel when 'grupo' then r->>'codigoGrupo' when 'classe' then r->>'codigoClasse' when 'pdm' then r->>'codigoPdm'
             when 'secao' then r->>'codigoSecao' when 'divisao' then r->>'codigoDivisao' when 'subclasse' then r->>'codigoSubclasse'
             when 'servico' then r->>'codigoServico' end as codigo,
        trim(both '"' from trim(case p_nivel when 'grupo' then r->>'nomeGrupo' when 'classe' then r->>'nomeClasse' when 'pdm' then r->>'nomePdm'
             when 'secao' then r->>'nomeSecao' when 'divisao' then r->>'nomeDivisao' when 'subclasse' then r->>'nomeSubclasse'
             when 'servico' then r->>'nomeServico' end)) as nome,
        coalesce((case v_chave when 'M:grupo' then r->>'statusGrupo' when 'M:classe' then r->>'statusClasse' when 'M:pdm' then r->>'statusPdm'
             when 'S:secao' then r->>'statusSecao' when 'S:divisao' then r->>'statusDivisao' when 'S:grupo' then r->>'statusGrupo'
             when 'S:classe' then r->>'statusGrupo' when 'S:subclasse' then r->>'statusSubclasse' when 'S:servico' then r->>'statusServico' end)::boolean, true) as ativo,
        jsonb_strip_nulls(case p_tipo
          when 'M' then jsonb_build_object('grupo', r->>'codigoGrupo', 'classe', r->>'codigoClasse', 'pdm', r->>'codigoPdm')
          else jsonb_build_object('secao', r->>'codigoSecao', 'divisao', r->>'codigoDivisao', 'grupo', r->>'codigoGrupo',
                                  'classe', r->>'codigoClasse', 'subclasse', r->>'codigoSubclasse', 'servico', r->>'codigoServico') end) as caminho,
        (r->>'dataHoraAtualizacao')::timestamptz as atu
      from jsonb_array_elements(coalesce(j->'resultado', '[]'::jsonb)) r
    ) x
    where x.codigo is not null and coalesce(x.nome, '') <> ''
    on conflict (catalogo, tipo, nivel, codigo) do update set
      nome = excluded.nome, ativo = excluded.ativo, caminho = cat_nos.caminho || excluded.caminho,
      fonte_atualizado_em = excluded.fonte_atualizado_em, busca = excluded.busca, sincronizado_em = now();
    get diagnostics k = row_count; n := n + k;
    pag := pag + 1;
  end loop;
  update cat_sync set status = 'ok', total = n, inseridos = n, concluido_em = now() where cat_sync.chave = v_chave;
  return n;
exception when others then
  -- a página com erro desfaz só esta carga; o que já estava no banco continua valendo
  update cat_sync set status = 'erro', erro = left(sqlerrm, 300), concluido_em = now() where cat_sync.chave = v_chave;
  return -1;
end $$;

-- completa ancestrais de serviço (a API de grupo/classe/subclasse não devolve a seção) e monta o rótulo legível
create or replace function public.cat_completar() returns void
language plpgsql security definer set search_path = public set statement_timeout = '300s' as $$
begin
  if not public._servico_ou_admin() then raise exception 'sem permissão'; end if;
  update cat_nos c set caminho = p.caminho || c.caminho from cat_nos p
   where c.tipo = 'S' and c.nivel = 'grupo' and p.tipo = 'S' and p.nivel = 'divisao' and p.codigo = c.caminho->>'divisao' and not (c.caminho ? 'secao');
  update cat_nos c set caminho = p.caminho || c.caminho from cat_nos p
   where c.tipo = 'S' and c.nivel = 'classe' and p.tipo = 'S' and p.nivel = 'grupo' and p.codigo = c.caminho->>'grupo' and not (c.caminho ? 'secao');
  update cat_nos c set caminho = p.caminho || c.caminho from cat_nos p
   where c.tipo = 'S' and c.nivel = 'subclasse' and p.tipo = 'S' and p.nivel = 'classe' and p.codigo = c.caminho->>'classe' and not (c.caminho ? 'grupo');
  update cat_nos c set caminho = p.caminho || c.caminho from cat_nos p
   where c.tipo = 'S' and c.nivel = 'subclasse' and p.tipo = 'S' and p.nivel = 'classe' and p.codigo = c.caminho->>'classe' and not (c.caminho ? 'secao');
  update cat_nos c set rotulo = (
    select string_agg(a.codigo || ' ' || a.nome, ' › ' order by cat_ordem(c.tipo, a.nivel))
    from cat_nos a where a.tipo = c.tipo and a.nivel <> c.nivel and c.caminho ->> a.nivel = a.codigo
      and cat_ordem(c.tipo, a.nivel) < cat_ordem(c.tipo, c.nivel))
  where true;
end $$;

revoke all on function public._cat_get(text), public.cat_sincronizar(char, text), public.cat_completar() from public, anon, authenticated;

-- ------------------------------------------------------------------ cadastro da empresa: só o que falta
alter table public.pessoas_juridicas add column if not exists descricao_atividades text;
alter table public.pessoas_juridicas add column if not exists dados_publicos jsonb;          -- retorno da consulta pública (com fonte e data)
alter table public.pessoas_juridicas add column if not exists dados_publicos_em timestamptz;

-- ------------------------------------------------------------------ linha de fornecimento (declarada pela empresa)
create table if not exists public.linhas_fornecimento (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null default public.org_atual() references public.organizacoes(id) on delete cascade,
  pessoa_juridica_id uuid references public.pessoas_juridicas(id) on delete cascade,
  catalogo text not null default 'compras',
  tipo char(1) not null check (tipo in ('M', 'S')),
  nivel text not null,
  codigo text not null,
  nome text not null,
  caminho jsonb not null default '{}'::jsonb,
  rotulo text,
  modo text not null default 'incluir' check (modo in ('incluir', 'excluir')),
  especialidade text,                          -- o que de fato fornece dentro da classificação
  origem text not null default 'manual' check (origem in ('manual', 'ia', 'sicaf_declarado')),
  ia_motivo text,
  situacao_catalogo text not null default 'ativo' check (situacao_catalogo in ('ativo', 'inativo', 'a_conferir')),
  criado_por uuid default auth.uid(),
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (organizacao_id, catalogo, tipo, nivel, codigo)
);
create index if not exists lf_org on public.linhas_fornecimento (organizacao_id);
alter table public.linhas_fornecimento enable row level security;
drop policy if exists lf_ler on public.linhas_fornecimento;
create policy lf_ler on public.linhas_fornecimento for select to authenticated using (public.pode_ler_org(organizacao_id));
-- escrita só pelas funções abaixo (que validam o código no catálogo oficial)
grant select on public.linhas_fornecimento to authenticated;

create or replace function public.salvar_linha(p_tipo char, p_nivel text, p_codigo text, p_modo text default 'incluir',
  p_especialidade text default null, p_origem text default 'manual', p_ia_motivo text default null,
  p_nome text default null, p_caminho jsonb default null)
returns public.linhas_fornecimento
language plpgsql security definer set search_path = public as $$
declare o uuid := public.org_atual(); c cat_nos; pdm cat_nos; r linhas_fornecimento; pj uuid;
begin
  if o is null or not public.pode_editar_org(o) then raise exception 'sem permissão para alterar a linha de fornecimento'; end if;
  if p_modo not in ('incluir', 'excluir') then raise exception 'modo inválido'; end if;
  if p_origem not in ('manual', 'ia', 'sicaf_declarado') then raise exception 'origem inválida'; end if;
  p_codigo := trim(p_codigo);
  select * into c from cat_nos where catalogo = 'compras' and tipo = p_tipo and nivel = p_nivel and codigo = p_codigo;
  select id into pj from pessoas_juridicas where organizacao_id = o order by propria desc, criado_em limit 1;
  if c.codigo is null then
    -- itens de material não são carregados em lote; aceita se o PDM informado existe, e a conferência fica pendente
    if p_tipo = 'M' and p_nivel = 'item' and p_caminho ? 'pdm' then
      select * into pdm from cat_nos where tipo = 'M' and nivel = 'pdm' and codigo = p_caminho->>'pdm';
      if pdm.codigo is null or coalesce(trim(p_nome), '') = '' then raise exception 'item não encontrado no catálogo oficial'; end if;
      c.nome := left(trim(p_nome), 400); c.caminho := pdm.caminho || jsonb_build_object('item', p_codigo);
      c.rotulo := coalesce(pdm.rotulo || ' › ', '') || pdm.codigo || ' ' || pdm.nome; c.ativo := null;
    else
      raise exception 'código % (%/%) não encontrado no catálogo oficial', p_codigo, p_tipo, p_nivel;
    end if;
  end if;
  insert into linhas_fornecimento (organizacao_id, pessoa_juridica_id, tipo, nivel, codigo, nome, caminho, rotulo, modo,
    especialidade, origem, ia_motivo, situacao_catalogo)
  values (o, pj, p_tipo, p_nivel, p_codigo, c.nome, c.caminho, c.rotulo, p_modo, nullif(trim(p_especialidade), ''),
    p_origem, case when p_origem = 'ia' then left(p_ia_motivo, 400) end,
    case when c.ativo is null then 'a_conferir' when c.ativo then 'ativo' else 'inativo' end)
  on conflict (organizacao_id, catalogo, tipo, nivel, codigo) do update set
    modo = excluded.modo, especialidade = excluded.especialidade, nome = excluded.nome, caminho = excluded.caminho,
    rotulo = excluded.rotulo, situacao_catalogo = excluded.situacao_catalogo,
    -- a origem só "sobe" de ia para manual quando a pessoa edita; nunca vira sicaf por conta própria
    origem = case when linhas_fornecimento.origem = 'sicaf_declarado' then 'sicaf_declarado' else excluded.origem end,
    ia_motivo = coalesce(excluded.ia_motivo, linhas_fornecimento.ia_motivo), atualizado_em = now()
  returning * into r;
  return r;
end $$;

create or replace function public.remover_linha(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from linhas_fornecimento where id = p_id and public.pode_editar_org(organizacao_id)) then
    raise exception 'linha não encontrada';
  end if;
  delete from linhas_fornecimento where id = p_id;
end $$;

-- linha da organização atual, com a situação ATUAL do código no catálogo (inativação posterior aparece)
create or replace function public.minha_linha() returns table (
  id uuid, tipo char, nivel text, codigo text, nome text, rotulo text, modo text, especialidade text, origem text,
  ia_motivo text, situacao text, atualizado_em timestamptz, catalogo_sincronizado_em timestamptz)
language sql stable security definer set search_path = public as $$
  select l.id, l.tipo, l.nivel, l.codigo, l.nome, coalesce(c.rotulo, l.rotulo), l.modo, l.especialidade, l.origem, l.ia_motivo,
    case when c.codigo is null then case when l.nivel = 'item' and l.tipo = 'M' then 'a_conferir' else 'nao_encontrado' end
         when c.ativo then 'ativo' else 'inativo' end,
    l.atualizado_em, c.sincronizado_em
  from linhas_fornecimento l
  left join cat_nos c on c.catalogo = l.catalogo and c.tipo = l.tipo and c.nivel = l.nivel and c.codigo = l.codigo
  where l.organizacao_id = public.org_atual() and public.pode_ler_org(l.organizacao_id)
  order by l.modo, l.tipo, cat_ordem(l.tipo, l.nivel), l.nome;
$$;

grant execute on function public.salvar_linha(char, text, text, text, text, text, text, text, jsonb),
  public.remover_linha(uuid), public.minha_linha() to authenticated;
