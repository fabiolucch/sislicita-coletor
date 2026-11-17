-- 039: linha de fornecimento derivada do histórico público do CNPJ (atas de registro de preços) + linha principal.
-- Classe (material) e grupo (serviço) são a chave de ligação com o PCA; o histórico é traduzido para esse nível.
-- Aditiva: não apaga nada. Reversível: remover origem/colunas novas não afeta as linhas existentes.

alter table public.linhas_fornecimento drop constraint if exists linhas_fornecimento_origem_check;
alter table public.linhas_fornecimento add constraint linhas_fornecimento_origem_check
  check (origem = any (array['manual','ia','sicaf_declarado','historico_pncp']));
alter table public.linhas_fornecimento add column if not exists principal boolean not null default false;
alter table public.linhas_fornecimento add column if not exists evidencia text;
create unique index if not exists lf_principal_uq on public.linhas_fornecimento (organizacao_id) where principal;

-- p_itens: [{"t":"M","c":"4548","n":12,"v":1500.5,"u":"2025-06-01"}, {"t":"S","c":"10006",...}]
--   t = M (c = código do PDM) ou S (c = código do serviço); n = nº de itens; v = valor total; u = data mais recente
-- Material sobe até a CLASSE (CATMAT); serviço sobe até o GRUPO (CATSER). Códigos desconhecidos são ignorados e contados.
create or replace function public.historico_para_linhas(p_itens jsonb)
returns table (tipo char, nivel text, codigo text, nome text, rotulo text, n_itens bigint, valor numeric, ultima date, filhos jsonb, desconhecidos bigint)
language sql stable security definer set search_path = public as $$
  with it as (
    select x->>'t' t, x->>'c' c, coalesce((x->>'n')::bigint, 1) n, coalesce((x->>'v')::numeric, 0) v, nullif(x->>'u', '')::date u
    from jsonb_array_elements(coalesce(p_itens, '[]'::jsonb)) x
    where x->>'t' in ('M', 'S') and x->>'c' ~ '^\d{1,9}$'
  ), j as (
    select it.*, f.nome fnome, f.caminho,
           case when it.t = 'M' then f.caminho->>'classe' else f.caminho->>'grupo' end alvo
    from it left join cat_nos f on f.catalogo = 'compras' and f.tipo = it.t and f.nivel = case when it.t = 'M' then 'pdm' else 'servico' end and f.codigo = it.c
  ), g as (
    select t, alvo, sum(n) n, sum(v) v, max(u) u,
           jsonb_agg(jsonb_build_object('codigo', c, 'nome', fnome, 'n', n) order by n desc) filter (where alvo is not null) filhos
    from j where alvo is not null group by t, alvo
  )
  select g.t::char, case when g.t = 'M' then 'classe' else 'grupo' end, g.alvo, c.nome, c.rotulo, g.n, g.v, g.u, g.filhos,
         (select count(*) from j where j.alvo is null)
  from g join cat_nos c on c.catalogo = 'compras' and c.tipo = g.t and c.nivel = case when g.t = 'M' then 'classe' else 'grupo' end and c.codigo = g.alvo
  order by g.v desc, g.n desc;
$$;

-- grava as classes/grupos do histórico como linha (origem historico_pncp); a de maior valor vira a principal se ainda não houver
create or replace function public.salvar_linhas_historico(p_itens jsonb, p_fonte text default 'atas de registro de preços (Compras.gov.br)')
returns integer language plpgsql security definer set search_path = public as $$
declare o uuid := public.org_atual(); pj uuid; r record; k int := 0; primeira boolean := true;
begin
  if o is null or not public.pode_editar_org(o) then raise exception 'sem permissão para alterar a linha de fornecimento'; end if;
  select id into pj from pessoas_juridicas where organizacao_id = o order by propria desc, criado_em limit 1;
  for r in select * from historico_para_linhas(p_itens) limit 40 loop
    insert into linhas_fornecimento (organizacao_id, pessoa_juridica_id, tipo, nivel, codigo, nome, caminho, rotulo, modo, origem, situacao_catalogo, evidencia, principal)
    select o, pj, r.tipo, r.nivel, r.codigo, r.nome, c.caminho, c.rotulo, 'incluir', 'historico_pncp', case when c.ativo then 'ativo' else 'inativo' end,
           format('%s itens em %s%s', r.n_itens, p_fonte, case when r.ultima is not null then ', o mais recente em ' || to_char(r.ultima, 'DD/MM/YYYY') else '' end),
           primeira and not exists (select 1 from linhas_fornecimento x where x.organizacao_id = o and x.principal)
    from cat_nos c where c.catalogo = 'compras' and c.tipo = r.tipo and c.nivel = r.nivel and c.codigo = r.codigo
    on conflict (organizacao_id, catalogo, tipo, nivel, codigo) do nothing;
    if found then k := k + 1; end if;
    primeira := false;
  end loop;
  return k;
end $$;

create or replace function public.definir_linha_principal(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare o uuid := public.org_atual();
begin
  if o is null or not public.pode_editar_org(o) then raise exception 'sem permissão'; end if;
  if not exists (select 1 from linhas_fornecimento where id = p_id and organizacao_id = o and modo = 'incluir') then raise exception 'linha não encontrada'; end if;
  update linhas_fornecimento set principal = false where organizacao_id = o and principal;
  update linhas_fornecimento set principal = true where id = p_id;
end $$;

drop function if exists public.minha_linha();
create function public.minha_linha()
returns table (id uuid, tipo char, nivel text, codigo text, nome text, rotulo text, modo text, especialidade text, origem text, ia_motivo text,
               situacao text, atualizado_em timestamptz, catalogo_sincronizado_em timestamptz, principal boolean, evidencia text)
language sql stable security definer set search_path = public as $$
  select l.id, l.tipo, l.nivel, l.codigo, l.nome, coalesce(c.rotulo, l.rotulo), l.modo, l.especialidade, l.origem, l.ia_motivo,
    case when c.codigo is null then case when l.nivel = 'item' and l.tipo = 'M' then 'a_conferir' else 'nao_encontrado' end
         when c.ativo then 'ativo' else 'inativo' end,
    l.atualizado_em, c.sincronizado_em, l.principal, l.evidencia
  from linhas_fornecimento l
  left join cat_nos c on c.catalogo = l.catalogo and c.tipo = l.tipo and c.nivel = l.nivel and c.codigo = l.codigo
  where l.organizacao_id = public.org_atual() and public.pode_ler_org(l.organizacao_id)
  order by l.modo, l.principal desc, l.tipo, cat_ordem(l.tipo, l.nivel), l.nome;
$$;

revoke all on function public.historico_para_linhas(jsonb), public.salvar_linhas_historico(jsonb, text), public.definir_linha_principal(uuid), public.minha_linha() from public, anon;
grant execute on function public.historico_para_linhas(jsonb), public.salvar_linhas_historico(jsonb, text), public.definir_linha_principal(uuid), public.minha_linha() to authenticated;
