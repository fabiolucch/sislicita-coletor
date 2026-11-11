-- 027: ambiente de disputa. "Iniciar disputa" num edital cria o processo, importa os itens,
-- guarda as regras lidas pela IA, calcula o lance mínimo de cada item e abre a sala de disputa.
-- Os lances são enviados pelo robô oficial do Compras.gov.br (valor final mínimo parametrizado,
-- art. 19 da IN SEGES/ME 73/2022) ou pela extensão do navegador do cliente; o sistema nunca guarda
-- senha nem certificado digital do cliente.

create table if not exists public.disputas (
  processo_id bigint primary key references public.processos(id) on delete cascade,
  organizacao_id uuid not null default public.org_atual() references public.organizacoes(id) on delete cascade,
  oportunidade_id bigint references public.oportunidades(id),
  portal text not null default 'comprasnet' check (portal in ('comprasnet','licitacoes-e','bll','bnc','portal-compras-publicas','outro')),
  modo_disputa text check (modo_disputa in ('aberto','aberto_fechado','fechado_aberto','dispensa','nao_identificado')),
  robo text not null default 'oficial' check (robo in ('oficial','extensao','manual')),
  uasg text, numero_portal text, link_portal text,
  sessao_em timestamptz,
  intervalo_tipo text not null default 'valor' check (intervalo_tipo in ('valor','percentual')),
  intervalo_minimo numeric(12,4),
  situacao text not null default 'preparando' check (situacao in ('preparando','pronta','em_disputa','encerrada','cancelada')),
  regras jsonb not null default '{}'::jsonb,
  preparo jsonb not null default '{}'::jsonb,
  iniciada_em timestamptz, encerrada_em timestamptz,
  criado_por uuid default auth.uid() references auth.users(id) on delete set null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

create table if not exists public.disputa_itens (
  id bigserial primary key,
  processo_id bigint not null references public.disputas(processo_id) on delete cascade,
  organizacao_id uuid not null default public.org_atual() references public.organizacoes(id) on delete cascade,
  numero int not null,
  descricao text, unidade text,
  quantidade numeric(16,4) not null default 1,
  valor_referencia numeric(14,4),
  custo_unit numeric(14,4),
  preco_proposta numeric(14,4),
  lance_minimo numeric(14,4),          -- calculado: menor preço unitário que ainda dá a margem mínima
  valor_final_minimo numeric(14,4),    -- o que o cliente parametriza no portal (pode ser ajustado)
  participar boolean not null default true,
  melhor_lance numeric(14,4), nosso_lance numeric(14,4), posicao int,
  situacao text not null default 'aguardando' check (situacao in ('aguardando','aberto','encerrado','ganho','perdido','desclassificado','nao_participa')),
  observacao text,
  atualizado_em timestamptz not null default now(),
  unique (processo_id, numero)
);
create index if not exists disputa_itens_proc on public.disputa_itens (processo_id, numero);

create table if not exists public.disputa_eventos (
  id bigserial primary key,
  processo_id bigint not null references public.disputas(processo_id) on delete cascade,
  organizacao_id uuid not null default public.org_atual() references public.organizacoes(id) on delete cascade,
  item_numero int, tipo text not null, valor numeric(14,4), descricao text,
  origem text not null default 'sistema' check (origem in ('sistema','cliente','robo','ia')),
  em timestamptz not null default now()
);
create index if not exists disputa_eventos_proc on public.disputa_eventos (processo_id, em desc);

alter table public.disputas enable row level security;
alter table public.disputa_itens enable row level security;
alter table public.disputa_eventos enable row level security;
do $p$
declare t text;
begin
  foreach t in array array['disputas','disputa_itens','disputa_eventos'] loop
    execute format('drop policy if exists %I on public.%I', t || '_ler', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.pode_ler_org(organizacao_id))', t || '_ler', t);
    execute format('drop policy if exists %I on public.%I', t || '_esc', t);
    execute format('create policy %I on public.%I for all to authenticated using (public.pode_editar_org(organizacao_id)) with check (public.pode_editar_org(organizacao_id))', t || '_esc', t);
    execute format('drop policy if exists %I on public.%I', t || '_plano', t);
    execute format('create policy %I on public.%I as restrictive for all to authenticated using (public.tem_recurso_org(organizacao_id, ''processos''))', t || '_plano', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $p$;
grant usage, select on sequence public.disputa_itens_id_seq, public.disputa_eventos_id_seq to authenticated;

-- A. iniciar disputa a partir de um edital: cria o processo, a disputa e importa os itens do PNCP
create or replace function public.iniciar_disputa(p_oportunidade bigint, p_empresa bigint default null) returns bigint
language plpgsql security definer set search_path = public as $$
declare o uuid; op oportunidades; emp bigint; pid bigint; n int := 0; prt text;
begin
  o := public.org_atual();
  if o is null then raise exception 'sem organizacao ativa'; end if;
  if not public.tem_recurso_org(o, 'processos') then raise exception 'disputa disponivel nos planos Basico e Premium'; end if;
  select * into op from oportunidades where id = p_oportunidade;
  if not found then raise exception 'edital nao encontrado'; end if;
  emp := coalesce(p_empresa, (select id from empresas where organizacao_id = o order by propria desc nulls last, id limit 1));
  if emp is null then raise exception 'cadastre uma empresa antes de iniciar a disputa'; end if;
  if not exists (select 1 from empresas where id = emp and organizacao_id = o) then raise exception 'empresa de outra organizacao'; end if;

  select d.processo_id into pid from disputas d join processos p on p.id = d.processo_id
   where d.oportunidade_id = p_oportunidade and d.organizacao_id = o and p.empresa_id = emp and d.situacao <> 'cancelada' limit 1;
  if pid is not null then return pid; end if;

  insert into processos (empresa_id, oportunidade_id, titulo, orgao, uf, link_pncp, data_sessao, status, organizacao_id)
  values (emp, p_oportunidade, left(coalesce(op.objeto, 'Licitação'), 400), op.orgao_nome, op.uf, op.link_pncp, op.data_fim_proposta, 'preparando', o)
  returning id into pid;

  prt := case when coalesce(op.link_pncp,'') ilike '%comprasnet%' or coalesce(op.link_pncp,'') ilike '%compras.gov%' then 'comprasnet' else 'comprasnet' end;
  insert into disputas (processo_id, organizacao_id, oportunidade_id, portal, sessao_em, link_portal, situacao)
  values (pid, o, p_oportunidade, prt, op.data_fim_proposta, op.link_pncp, 'preparando');

  insert into disputa_itens (processo_id, organizacao_id, numero, descricao, unidade, quantidade, valor_referencia, preco_proposta)
  select pid, o, i.numero_item, left(coalesce(i.descricao,''), 600), i.unidade, coalesce(i.quantidade, 1),
         case when i.sigiloso then null else i.valor_unitario end,
         case when i.sigiloso then null else i.valor_unitario end
  from oportunidade_itens i where i.oportunidade_id = p_oportunidade
  on conflict do nothing;
  get diagnostics n = row_count;
  if n = 0 then
    insert into disputa_itens (processo_id, organizacao_id, numero, descricao, quantidade, valor_referencia, preco_proposta)
    values (pid, o, 1, left(coalesce(op.objeto, 'Item único'), 600), 1,
            case when op.valor_sigiloso then null else op.valor_estimado end,
            case when op.valor_sigiloso then null else op.valor_estimado end);
  end if;

  insert into disputa_eventos (processo_id, organizacao_id, tipo, descricao, origem)
  values (pid, o, 'disputa_criada', format('Disputa iniciada a partir do edital (%s itens)', greatest(n, 1)), 'cliente');
  return pid;
end $$;

-- B. lance mínimo por item: preço que ainda cobre custo, impostos, despesas, comissão e margem mínima
create or replace function public.calcular_lances(p_processo bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o uuid; pc parametros_custo; com numeric := 0; pct numeric; mmin numeric; den numeric; n int := 0; v jsonb;
begin
  select organizacao_id into o from disputas where processo_id = p_processo;
  if o is null or not public.pode_editar_org(o) then raise exception 'disputa nao encontrada'; end if;
  select * into pc from parametros_custo where organizacao_id = o;
  select coalesce(comissao_pct, 0) into com from assessorias where processo_id = p_processo and situacao = 'aceita';
  v := coalesce((select params from processo_viabilidade where processo_id = p_processo), '{}'::jsonb);
  pct := coalesce(nullif(v->>'imp','')::numeric, pc.impostos_pct, 0) + coalesce(nullif(v->>'frete','')::numeric, pc.frete_pct, 0)
       + coalesce(nullif(v->>'fin','')::numeric, pc.financeiro_pct, 0) + coalesce(nullif(v->>'out','')::numeric, pc.outros_pct, 0)
       + coalesce(com, 0);
  mmin := coalesce(nullif(v->>'mmin','')::numeric, pc.margem_min_pct, 0);
  den := 1 - (pct + mmin) / 100;
  if den <= 0 then raise exception 'impostos, despesas, comissao e margem minima somam 100%% ou mais: revise os percentuais'; end if;
  update disputa_itens set
    lance_minimo = round(custo_unit / den, 4),
    valor_final_minimo = coalesce(valor_final_minimo, round(custo_unit / den, 4)),
    atualizado_em = now()
  where processo_id = p_processo and custo_unit is not null;
  get diagnostics n = row_count;
  return jsonb_build_object('itens', n, 'percentuais', pct, 'margem_min', mmin, 'comissao', com);
end $$;

-- C. registrar o andamento da disputa (manual, pela extensão ou pelo acompanhamento do cliente)
create or replace function public.registrar_lance(p_processo bigint, p_item int, p_nosso numeric default null, p_melhor numeric default null, p_posicao int default null, p_situacao text default null, p_origem text default 'cliente') returns void
language plpgsql security definer set search_path = public as $$
declare o uuid; lim numeric;
begin
  select organizacao_id into o from disputas where processo_id = p_processo;
  if o is null or not public.pode_editar_org(o) then raise exception 'disputa nao encontrada'; end if;
  if p_origem not in ('cliente','robo','sistema','ia') then raise exception 'origem invalida'; end if;
  select valor_final_minimo into lim from disputa_itens where processo_id = p_processo and numero = p_item;
  if p_nosso is not null and lim is not null and p_nosso < lim then
    raise exception 'lance abaixo do valor final minimo do item %', p_item;
  end if;
  update disputa_itens set
    nosso_lance = coalesce(p_nosso, nosso_lance), melhor_lance = coalesce(p_melhor, melhor_lance),
    posicao = coalesce(p_posicao, posicao), situacao = coalesce(p_situacao, situacao), atualizado_em = now()
  where processo_id = p_processo and numero = p_item;
  if not found then raise exception 'item % nao encontrado nesta disputa', p_item; end if;
  insert into disputa_eventos (processo_id, organizacao_id, item_numero, tipo, valor, descricao, origem)
  values (p_processo, o, p_item, case when p_nosso is not null then 'lance' else 'atualizacao' end, coalesce(p_nosso, p_melhor),
    concat_ws(' · ', case when p_nosso is not null then 'nosso ' || to_char(p_nosso, 'FM999G999G990D00') end,
                     case when p_melhor is not null then 'melhor ' || to_char(p_melhor, 'FM999G999G990D00') end,
                     case when p_posicao is not null then 'posição ' || p_posicao end, p_situacao), p_origem);
end $$;

-- D. situação da disputa: pronta só quando os itens que vão participar têm custo e lance mínimo
create or replace function public.mudar_situacao_disputa(p_processo bigint, p_situacao text) returns void
language plpgsql security definer set search_path = public as $$
declare o uuid; faltam int;
begin
  select organizacao_id into o from disputas where processo_id = p_processo;
  if o is null or not public.pode_editar_org(o) then raise exception 'disputa nao encontrada'; end if;
  if p_situacao not in ('preparando','pronta','em_disputa','encerrada','cancelada') then raise exception 'situacao invalida'; end if;
  if p_situacao in ('pronta','em_disputa') then
    select count(*) into faltam from disputa_itens where processo_id = p_processo and participar and (custo_unit is null or valor_final_minimo is null);
    if faltam > 0 then raise exception 'ainda faltam custo e lance minimo em % item(ns)', faltam; end if;
  end if;
  update disputas set situacao = p_situacao, atualizado_em = now(),
    iniciada_em = case when p_situacao = 'em_disputa' then coalesce(iniciada_em, now()) else iniciada_em end,
    encerrada_em = case when p_situacao = 'encerrada' then now() else encerrada_em end
  where processo_id = p_processo;
  insert into disputa_eventos (processo_id, organizacao_id, tipo, descricao, origem) values (p_processo, o, 'situacao', p_situacao, 'cliente');
  if p_situacao = 'em_disputa' then update processos set status = 'disputa' where id = p_processo and status in ('preparando','habilitacao','proposta'); end if;
end $$;

-- E. resumo da disputa para a sala (um só round-trip)
create or replace function public.disputa_resumo(p_processo bigint) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'disputa', to_jsonb(d), 'processo', jsonb_build_object('titulo', p.titulo, 'orgao', p.orgao, 'uf', p.uf, 'status', p.status, 'link', p.link_pncp, 'empresa', e.nome),
    'itens', coalesce((select jsonb_agg(to_jsonb(i) order by i.numero) from disputa_itens i where i.processo_id = d.processo_id), '[]'::jsonb),
    'eventos', coalesce((select jsonb_agg(to_jsonb(x) order by x.em desc) from (select * from disputa_eventos where processo_id = d.processo_id order by em desc limit 60) x), '[]'::jsonb),
    'analise', (select dados from edital_analise where oportunidade_id = d.oportunidade_id),
    'assessoria', (select to_jsonb(a) from assessorias a where a.processo_id = d.processo_id),
    'habilitacao', coalesce((select jsonb_agg(jsonb_build_object('codigo', c.codigo, 'nome', c.nome, 'grupo', c.grupo, 'obrigatorio', c.obrigatorio, 'valido_ate', u.valido_ate))
       from hab_catalogo c left join lateral (select valido_ate from hab_documentos h where h.codigo = c.codigo and h.organizacao_id = d.organizacao_id order by criado_em desc limit 1) u on true
       where c.obrigatorio), '[]'::jsonb))
  from disputas d join processos p on p.id = d.processo_id left join empresas e on e.id = p.empresa_id
  where d.processo_id = p_processo and public.pode_ler_org(d.organizacao_id);
$$;

revoke execute on function public.iniciar_disputa(bigint, bigint), public.calcular_lances(bigint), public.registrar_lance(bigint, int, numeric, numeric, int, text, text), public.mudar_situacao_disputa(bigint, text), public.disputa_resumo(bigint) from public, anon;
grant execute on function public.iniciar_disputa(bigint, bigint), public.calcular_lances(bigint), public.registrar_lance(bigint, int, numeric, numeric, int, text, text), public.mudar_situacao_disputa(bigint, text), public.disputa_resumo(bigint) to authenticated;
