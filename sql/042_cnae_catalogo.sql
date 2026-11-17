-- 042: relação CNAE ↔ classe/grupo do catálogo (muitos-para-muitos), confiança e confirmação das linhas, CNAEs completos no cadastro.
-- Aditiva. A relação é aprendida de duas formas: (a) amostra de fornecedores reais com o mesmo CNAE principal no SICAF e o que
-- venderam em atas (determinística, preenchida pelo coletor); (b) sugestão de IA restrita a códigos existentes (confiança média).
-- Nenhuma das duas vira linha da empresa sem confirmação do usuário, exceto o histórico do próprio CNPJ (marcado "não confirmada").

alter table public.pessoas_juridicas add column if not exists cnaes jsonb, add column if not exists situacao_cadastral text;

alter table public.linhas_fornecimento drop constraint if exists linhas_fornecimento_origem_check;
alter table public.linhas_fornecimento add constraint linhas_fornecimento_origem_check
  check (origem = any (array['manual','ia','sicaf_declarado','historico_pncp','cnae_fornecedores']));
alter table public.linhas_fornecimento add column if not exists confianca text check (confianca in ('alta','media','baixa'));
alter table public.linhas_fornecimento add column if not exists confirmada boolean not null default true;
alter table public.linhas_fornecimento add column if not exists cnaes text[];
update public.linhas_fornecimento set confirmada = false, confianca = coalesce(confianca, 'alta') where origem = 'historico_pncp' and confirmada;

create table if not exists public.cnae_catalogo (
  cnae text not null, tipo char(1) not null check (tipo in ('M','S')), nivel text not null, codigo text not null,
  origem text not null check (origem in ('amostra_fornecedores','ia')),
  confianca text not null check (confianca in ('alta','media','baixa')),
  apoio int not null default 0, amostra int not null default 0, confirmacoes int not null default 0, motivo text,
  atualizado_em timestamptz not null default now(),
  primary key (cnae, tipo, nivel, codigo));
create index if not exists cnae_catalogo_cod on public.cnae_catalogo (tipo, nivel, codigo);
create table if not exists public.cnae_fila (cnae text primary key, pedido_em timestamptz not null default now(), processado_em timestamptz, tentativas int not null default 0, erro text);
alter table public.cnae_catalogo enable row level security; alter table public.cnae_fila enable row level security;
revoke all on public.cnae_catalogo, public.cnae_fila from anon, authenticated;

-- coletor: p_itens = [{"f":"cnpj do fornecedor","t":"M|S","c":"código do PDM ou do serviço"}], p_amostra = nº de fornecedores consultados
create or replace function public.registrar_cnae_catalogo(p_cnae text, p_amostra int, p_itens jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare k int;
begin
  if not public._servico_ou_admin() then raise exception 'sem permissão'; end if;
  delete from cnae_catalogo where cnae = p_cnae and origem = 'amostra_fornecedores';
  insert into cnae_catalogo (cnae, tipo, nivel, codigo, origem, confianca, apoio, amostra, motivo)
  select p_cnae, g.t, g.nv, g.alvo, 'amostra_fornecedores',
         case when g.apoio::numeric / greatest(p_amostra, 1) >= 0.5 then 'alta' when g.apoio::numeric / greatest(p_amostra, 1) >= 0.2 then 'media' else 'baixa' end,
         g.apoio, p_amostra, format('%s de %s fornecedores com este CNAE e com vendas em atas de registro de preços venderam itens desta %s', g.apoio, p_amostra, case when g.t = 'M' then 'classe' else 'grupo' end)
  from (
    select j.t, case when j.t = 'M' then 'classe' else 'grupo' end nv, j.alvo, count(distinct j.f)::int apoio
    from (select x->>'f' f, x->>'t' t, case when x->>'t' = 'M' then n.caminho->>'classe' else n.caminho->>'grupo' end alvo
          from jsonb_array_elements(coalesce(p_itens, '[]'::jsonb)) x
          join cat_nos n on n.catalogo = 'compras' and n.tipo = x->>'t' and n.nivel = case when x->>'t' = 'M' then 'pdm' else 'servico' end and n.codigo = x->>'c') j
    where j.alvo is not null group by j.t, j.alvo having count(distinct j.f) >= 2 order by 4 desc limit 25) g
  join cat_nos c on c.catalogo = 'compras' and c.tipo = g.t and c.nivel = g.nv and c.codigo = g.alvo
  on conflict (cnae, tipo, nivel, codigo) do update set origem = excluded.origem, confianca = excluded.confianca, apoio = excluded.apoio,
    amostra = excluded.amostra, motivo = excluded.motivo, atualizado_em = now();
  get diagnostics k = row_count;
  update cnae_fila set processado_em = now(), erro = null where cnae = p_cnae;
  return k;
end $$;

-- IA: só aceita códigos que existem no catálogo; nunca sobrescreve o que veio de fornecedores reais; confiança sempre média
create or replace function public.salvar_sugestoes_cnae(p_sugestoes jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare k int;
begin
  if auth.uid() is null and not public._servico_ou_admin() then raise exception 'sem permissão'; end if;
  insert into cnae_catalogo (cnae, tipo, nivel, codigo, origem, confianca, motivo)
  select x->>'cnae', c.tipo, c.nivel, c.codigo, 'ia', 'media', left(x->>'motivo', 300)
  from jsonb_array_elements(coalesce(p_sugestoes, '[]'::jsonb)) x
  join cat_nos c on c.catalogo = 'compras' and c.tipo = x->>'tipo' and c.nivel = x->>'nivel' and c.codigo = x->>'codigo' and c.nivel in ('classe','grupo')
  where x->>'cnae' ~ '^\d{7}$'
  on conflict (cnae, tipo, nivel, codigo) do nothing;
  get diagnostics k = row_count;
  return k;
end $$;

-- sugestões para os CNAEs da empresa; CNAEs ainda sem amostra de fornecedores entram na fila do coletor
create or replace function public.sugestoes_cnae(p_cnaes text[])
returns table (cnae text, tipo char, nivel text, codigo text, nome text, rotulo text, origem text, confianca text, apoio int, amostra int, confirmacoes int, motivo text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
begin
  if auth.uid() is null then raise exception 'sem permissão'; end if;
  insert into cnae_fila (cnae) select distinct c from unnest(p_cnaes) c
   where c ~ '^\d{7}$' and not exists (select 1 from cnae_catalogo x where x.cnae = c and x.origem = 'amostra_fornecedores')
  on conflict (cnae) do update set processado_em = case when cnae_fila.processado_em < now() - interval '30 days' then null else cnae_fila.processado_em end;
  return query
  select x.cnae, x.tipo, x.nivel, x.codigo, n.nome, n.rotulo, x.origem, x.confianca, x.apoio, x.amostra, x.confirmacoes, x.motivo
  from cnae_catalogo x join cat_nos n on n.catalogo = 'compras' and n.tipo = x.tipo and n.nivel = x.nivel and n.codigo = x.codigo and n.ativo is not false
  where x.cnae = any (p_cnaes)
  order by x.cnae, (x.origem = 'amostra_fornecedores') desc, x.apoio desc, x.confirmacoes desc, n.nome;
end $$;

-- o usuário confirma uma sugestão: grava a linha (origem/confiança/CNAEs de origem) e conta a confirmação para o aprendizado
create or replace function public.confirmar_sugestao_cnae(p_tipo char, p_nivel text, p_codigo text, p_cnaes text[], p_origem text, p_confianca text, p_motivo text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare l linhas_fornecimento; antes text; o uuid := public.org_atual();
begin
  if p_origem not in ('ia', 'cnae_fornecedores') then raise exception 'origem inválida'; end if;
  select origem into antes from linhas_fornecimento where organizacao_id = o and tipo = p_tipo and nivel = p_nivel and codigo = p_codigo;
  l := public.salvar_linha(p_tipo, p_nivel, p_codigo, 'incluir', null, case when p_origem = 'ia' then 'ia' else 'manual' end, p_motivo, null, null);
  update linhas_fornecimento set origem = case when antes is null or antes = 'historico_pncp' then p_origem else origem end, confianca = coalesce(confianca, p_confianca), confirmada = true, cnaes = p_cnaes, atualizado_em = now() where id = l.id;
  update cnae_catalogo set confirmacoes = confirmacoes + 1 where cnae = any (p_cnaes) and tipo = p_tipo and nivel = p_nivel and codigo = p_codigo;
  return l.id;
end $$;

create or replace function public.confirmar_linhas(p_ids uuid[]) returns int
language plpgsql security definer set search_path = public as $$
declare o uuid := public.org_atual(); k int;
begin
  if o is null or not public.pode_editar_org(o) then raise exception 'sem permissão'; end if;
  update linhas_fornecimento set confirmada = true, atualizado_em = now() where organizacao_id = o and id = any (p_ids) and not confirmada;
  get diagnostics k = row_count; return k;
end $$;

-- histórico do próprio CNPJ: entra como linha NÃO confirmada (confiança alta), usada na busca até o usuário confirmar ou remover
create or replace function public.salvar_linhas_historico(p_itens jsonb, p_fonte text default 'atas de registro de preços (Compras.gov.br)')
returns integer language plpgsql security definer set search_path = public as $$
declare o uuid := public.org_atual(); pj uuid; r record; k int := 0; primeira boolean := true;
begin
  if o is null or not public.pode_editar_org(o) then raise exception 'sem permissão para alterar a linha de fornecimento'; end if;
  select id into pj from pessoas_juridicas where organizacao_id = o order by propria desc, criado_em limit 1;
  for r in select * from historico_para_linhas(p_itens) limit 40 loop
    insert into linhas_fornecimento (organizacao_id, pessoa_juridica_id, tipo, nivel, codigo, nome, caminho, rotulo, modo, origem, situacao_catalogo, evidencia, principal, confianca, confirmada)
    select o, pj, r.tipo, r.nivel, r.codigo, r.nome, c.caminho, c.rotulo, 'incluir', 'historico_pncp', case when c.ativo then 'ativo' else 'inativo' end,
           format('%s itens em %s%s', r.n_itens, p_fonte, case when r.ultima is not null then ', o mais recente em ' || to_char(r.ultima, 'DD/MM/YYYY') else '' end),
           primeira and not exists (select 1 from linhas_fornecimento x where x.organizacao_id = o and x.principal), 'alta', false
    from cat_nos c where c.catalogo = 'compras' and c.tipo = r.tipo and c.nivel = r.nivel and c.codigo = r.codigo
    on conflict (organizacao_id, catalogo, tipo, nivel, codigo) do nothing;
    if found then k := k + 1; end if;
    primeira := false;
  end loop;
  return k;
end $$;

drop function if exists public.minha_linha();
create function public.minha_linha()
returns table (id uuid, tipo char, nivel text, codigo text, nome text, rotulo text, modo text, especialidade text, origem text, ia_motivo text,
               situacao text, atualizado_em timestamptz, catalogo_sincronizado_em timestamptz, principal boolean, evidencia text, confianca text, confirmada boolean, cnaes text[])
language sql stable security definer set search_path = public as $$
  select l.id, l.tipo, l.nivel, l.codigo, l.nome, coalesce(c.rotulo, l.rotulo), l.modo, l.especialidade, l.origem, l.ia_motivo,
    case when c.codigo is null then case when l.nivel = 'item' and l.tipo = 'M' then 'a_conferir' else 'nao_encontrado' end
         when c.ativo then 'ativo' else 'inativo' end,
    l.atualizado_em, c.sincronizado_em, l.principal, l.evidencia, l.confianca, l.confirmada, l.cnaes
  from linhas_fornecimento l
  left join cat_nos c on c.catalogo = l.catalogo and c.tipo = l.tipo and c.nivel = l.nivel and c.codigo = l.codigo
  where l.organizacao_id = public.org_atual() and public.pode_ler_org(l.organizacao_id)
  order by l.modo, l.principal desc, l.tipo, cat_ordem(l.tipo, l.nivel), l.nome;
$$;

revoke all on function public.registrar_cnae_catalogo(text, int, jsonb), public.salvar_sugestoes_cnae(jsonb), public.sugestoes_cnae(text[]),
  public.confirmar_sugestao_cnae(char, text, text, text[], text, text, text), public.confirmar_linhas(uuid[]), public.salvar_linhas_historico(jsonb, text), public.minha_linha() from public, anon;
grant execute on function public.salvar_sugestoes_cnae(jsonb), public.sugestoes_cnae(text[]), public.confirmar_sugestao_cnae(char, text, text, text[], text, text, text),
  public.confirmar_linhas(uuid[]), public.salvar_linhas_historico(jsonb, text), public.minha_linha() to authenticated;
