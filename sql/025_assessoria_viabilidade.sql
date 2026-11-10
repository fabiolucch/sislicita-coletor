-- 025: cálculo de lucro por licitação, assessoria opcional (Básico e Premium) e cobranças:
-- taxa fixa se o certame for perdido e/ou taxa fixa se for vencido (ambas configuráveis e desligáveis)
-- + comissão sobre cada empenho de contrato assinado. Desistência não gera cobrança.
-- Percentuais e taxas são definidos pela plataforma por licitação; o sistema sugere a comissão a partir do lucro estimado.

-- A. parâmetros (só a plataforma altera) ----------------------------------------------------------
create table if not exists public.assessoria_parametros (
  id int primary key default 1 check (id = 1),
  comissao_padrao_basico numeric(6,3),     -- % sobre empenho, referência para Básico (maior)
  comissao_padrao_premium numeric(6,3),    -- % sobre empenho, referência para Premium
  taxa_perda_basico numeric(12,2),         -- R$ cobrado se o certame for perdido
  taxa_perda_premium numeric(12,2),
  taxa_exito_basico numeric(12,2),         -- R$ cobrado se o certame for vencido (além da comissão)
  taxa_exito_premium numeric(12,2),
  taxas_fixas_ativas boolean not null default true,
  participacao_lucro_pct numeric(6,3),     -- sugestão: comissão = participação × margem estimada
  comissao_min_pct numeric(6,3),
  comissao_max_pct numeric(6,3),
  texto_aceite text,
  versao_aceite text not null default '2026-11-v1',
  atualizado_em timestamptz not null default now()
);
insert into public.assessoria_parametros (id, participacao_lucro_pct, comissao_min_pct, comissao_max_pct, texto_aceite)
values (1, 20, 1, 10,
 'Contrato a ser revisado por advogado antes do uso com clientes. Ao aceitar, a empresa contrata a assessoria do SISLICITA para esta licitação, nas condições acima: (1) se o certame for perdido, é devida a taxa fixa indicada; (2) se for vencido, é devida a taxa fixa de êxito indicada, se houver, e a comissão indicada sobre o valor de cada empenho emitido no contrato assinado com o órgão, à medida que os empenhos forem registrados; (3) a desistência da participação não gera cobrança.')
on conflict (id) do nothing;
alter table public.assessoria_parametros enable row level security;
drop policy if exists assess_par_ler on public.assessoria_parametros;
create policy assess_par_ler on public.assessoria_parametros for select to authenticated using (true);
revoke insert, update, delete on public.assessoria_parametros from authenticated, anon;
grant select on public.assessoria_parametros to authenticated;

create or replace function public.salvar_parametros_assessoria(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.eh_admin_plataforma() then raise exception 'apenas a plataforma'; end if;
  update assessoria_parametros set
    comissao_padrao_basico = nullif(p->>'comissao_padrao_basico','')::numeric,
    comissao_padrao_premium = nullif(p->>'comissao_padrao_premium','')::numeric,
    taxa_perda_basico = nullif(p->>'taxa_perda_basico','')::numeric,
    taxa_perda_premium = nullif(p->>'taxa_perda_premium','')::numeric,
    taxa_exito_basico = nullif(p->>'taxa_exito_basico','')::numeric,
    taxa_exito_premium = nullif(p->>'taxa_exito_premium','')::numeric,
    taxas_fixas_ativas = coalesce((p->>'taxas_fixas_ativas')::boolean, taxas_fixas_ativas),
    participacao_lucro_pct = nullif(p->>'participacao_lucro_pct','')::numeric,
    comissao_min_pct = nullif(p->>'comissao_min_pct','')::numeric,
    comissao_max_pct = nullif(p->>'comissao_max_pct','')::numeric,
    texto_aceite = coalesce(nullif(p->>'texto_aceite',''), texto_aceite),
    versao_aceite = case when coalesce(p->>'texto_aceite','') <> '' and p->>'texto_aceite' is distinct from texto_aceite
                         then to_char(now(), 'YYYY-MM-DD"T"HH24MI') else versao_aceite end,
    atualizado_em = now()
  where id = 1;
end $$;

-- B. parâmetros de custo da empresa e cálculo de lucro por processo --------------------------------
create table if not exists public.parametros_custo (
  organizacao_id uuid primary key default public.org_atual() references public.organizacoes(id) on delete cascade,
  impostos_pct numeric(6,3), frete_pct numeric(6,3), financeiro_pct numeric(6,3), outros_pct numeric(6,3), margem_min_pct numeric(6,3),
  atualizado_em timestamptz not null default now()
);
create table if not exists public.processo_viabilidade (
  processo_id bigint primary key references public.processos(id) on delete cascade,
  organizacao_id uuid not null default public.org_atual() references public.organizacoes(id) on delete cascade,
  itens jsonb not null default '[]'::jsonb,
  params jsonb not null default '{}'::jsonb,
  totais jsonb not null default '{}'::jsonb,
  atualizado_em timestamptz not null default now()
);

-- C. assessoria por licitação ----------------------------------------------------------------------
create table if not exists public.assessorias (
  id bigserial primary key,
  organizacao_id uuid not null references public.organizacoes(id) on delete cascade,
  processo_id bigint not null unique references public.processos(id) on delete cascade,
  plano text,
  situacao text not null default 'solicitada' check (situacao in ('solicitada','proposta','aceita','recusada','cancelada')),
  comissao_sugerida_pct numeric(6,3),
  comissao_pct numeric(6,3),
  taxa_perda numeric(12,2),
  taxa_exito numeric(12,2),
  solicitado_por uuid references auth.users(id) on delete set null,
  solicitado_em timestamptz not null default now(),
  proposta_por uuid references auth.users(id) on delete set null,
  proposta_em timestamptz,
  aceito_por uuid references auth.users(id) on delete set null,
  aceito_em timestamptz,
  aceite_versao text,
  aceite_texto text,
  observacao_cliente text,
  observacao_plataforma text
);
alter table public.processos add column if not exists contrato_assinado_em date;
alter table public.processos add column if not exists contrato_numero text;

create table if not exists public.processo_empenhos (
  id bigserial primary key,
  organizacao_id uuid not null default public.org_atual() references public.organizacoes(id) on delete cascade,
  processo_id bigint not null references public.processos(id) on delete cascade,
  numero text not null,
  data date not null,
  valor numeric(14,2) not null check (valor > 0),
  observacao text,
  criado_por uuid default auth.uid() references auth.users(id) on delete set null,
  criado_em timestamptz not null default now()
);
create index if not exists empenhos_proc on public.processo_empenhos (processo_id);

create table if not exists public.assessoria_cobrancas (
  id bigserial primary key,
  organizacao_id uuid not null references public.organizacoes(id) on delete cascade,
  assessoria_id bigint not null references public.assessorias(id) on delete cascade,
  tipo text not null check (tipo in ('taxa_perda','taxa_exito','comissao_empenho')),
  empenho_id bigint references public.processo_empenhos(id) on delete set null,
  base_valor numeric(14,2), pct numeric(6,3),
  valor numeric(14,2) not null,
  situacao text not null default 'aberta' check (situacao in ('aberta','paga','cancelada')),
  criado_em timestamptz not null default now(),
  pago_em date, observacao text
);
create unique index if not exists cobr_empenho_unico on public.assessoria_cobrancas (empenho_id) where empenho_id is not null and situacao <> 'cancelada';
create unique index if not exists cobr_taxa_unica on public.assessoria_cobrancas (assessoria_id, tipo) where tipo in ('taxa_perda','taxa_exito') and situacao <> 'cancelada';

-- RLS: cliente lê o que é da sua organização; a plataforma lê tudo; escrita sensível só por funções
alter table public.parametros_custo enable row level security;
alter table public.processo_viabilidade enable row level security;
alter table public.assessorias enable row level security;
alter table public.processo_empenhos enable row level security;
alter table public.assessoria_cobrancas enable row level security;
do $p$
declare t text;
begin
  foreach t in array array['parametros_custo','processo_viabilidade','processo_empenhos'] loop
    execute format('drop policy if exists %I on public.%I', t || '_ler', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.pode_ler_org(organizacao_id))', t || '_ler', t);
    execute format('drop policy if exists %I on public.%I', t || '_esc', t);
    execute format('create policy %I on public.%I for all to authenticated using (public.pode_editar_org(organizacao_id)) with check (public.pode_editar_org(organizacao_id))', t || '_esc', t);
    execute format('drop policy if exists %I on public.%I', t || '_plano', t);
    execute format('create policy %I on public.%I as restrictive for all to authenticated using (public.tem_recurso_org(organizacao_id, ''processos''))', t || '_plano', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
  foreach t in array array['assessorias','assessoria_cobrancas'] loop
    execute format('drop policy if exists %I on public.%I', t || '_ler', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.pode_ler_org(organizacao_id))', t || '_ler', t);
    execute format('revoke insert, update, delete on public.%I from authenticated, anon', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $p$;
-- empenho e viabilidade devem ser do mesmo processo/organização
create or replace function public._mesma_org_processo() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.organizacao_id is distinct from (select organizacao_id from processos where id = new.processo_id) then
    raise exception 'processo de outra organizacao';
  end if;
  return new;
end $$;
drop trigger if exists t_empenho_org on public.processo_empenhos;
create trigger t_empenho_org before insert or update on public.processo_empenhos for each row execute function public._mesma_org_processo();
drop trigger if exists t_viab_org on public.processo_viabilidade;
create trigger t_viab_org before insert or update on public.processo_viabilidade for each row execute function public._mesma_org_processo();

-- D. sugestão de comissão: participação sobre a margem estimada, limitada entre mínimo e máximo
create or replace function public.sugerir_comissao(p_processo bigint) returns numeric
language sql stable security definer set search_path = public as $$
  with par as (select * from assessoria_parametros where id = 1),
       v as (select nullif(totais->>'margem_pct','')::numeric m from processo_viabilidade where processo_id = p_processo)
  select case when (select participacao_lucro_pct from par) is null or (select m from v) is null or (select m from v) <= 0 then null
    else round(least(coalesce((select comissao_max_pct from par), 100), greatest(coalesce((select comissao_min_pct from par), 0),
      (select participacao_lucro_pct from par) * (select m from v) / 100)), 2) end;
$$;

-- E. fluxo: cliente pede → plataforma propõe → cliente aceita ---------------------------------------
create or replace function public.solicitar_assessoria(p_processo bigint, p_obs text default null) returns bigint
language plpgsql security definer set search_path = public as $$
declare o uuid; pl text; a bigint;
begin
  select organizacao_id into o from processos where id = p_processo;
  if o is null or not public.pode_editar_org(o) then raise exception 'processo nao encontrado'; end if;
  if not public.tem_recurso_org(o, 'processos') then raise exception 'assessoria disponivel nos planos Basico e Premium'; end if;
  pl := public.plano_efetivo(o);
  insert into assessorias (organizacao_id, processo_id, plano, comissao_sugerida_pct, solicitado_por, observacao_cliente)
  values (o, p_processo, pl, public.sugerir_comissao(p_processo), auth.uid(), left(p_obs, 1000))
  on conflict (processo_id) do update set situacao = 'solicitada', plano = excluded.plano, comissao_sugerida_pct = excluded.comissao_sugerida_pct,
    solicitado_por = excluded.solicitado_por, solicitado_em = now(), observacao_cliente = excluded.observacao_cliente,
    aceito_em = null, aceito_por = null
  where assessorias.situacao in ('recusada','cancelada')
  returning id into a;
  if a is null then raise exception 'ja existe assessoria em andamento para este processo'; end if;
  return a;
end $$;

drop function if exists public.propor_assessoria(bigint, numeric, numeric, text);
drop function if exists public.propor_assessoria(bigint, numeric, numeric, text, numeric);
create or replace function public.propor_assessoria(p_id bigint, p_comissao numeric, p_taxa numeric, p_obs text default null, p_taxa_exito numeric default 0) returns void
language plpgsql security definer set search_path = public as $$
declare ativas boolean := coalesce((select taxas_fixas_ativas from assessoria_parametros where id = 1), true);
begin
  if not public.eh_admin_plataforma() then raise exception 'apenas a plataforma define as condicoes'; end if;
  if p_comissao is null or p_comissao < 0 or p_comissao > 100 then raise exception 'comissao invalida'; end if;
  update assessorias set situacao = 'proposta', comissao_pct = p_comissao,
    taxa_perda = case when ativas then coalesce(p_taxa, 0) else 0 end, taxa_exito = case when ativas then coalesce(p_taxa_exito, 0) else 0 end,
    comissao_sugerida_pct = public.sugerir_comissao(processo_id), proposta_por = auth.uid(), proposta_em = now(),
    observacao_plataforma = left(p_obs, 1000)
  where id = p_id and situacao in ('solicitada','proposta');
  if not found then raise exception 'assessoria nao encontrada ou ja aceita'; end if;
end $$;

create or replace function public.responder_assessoria(p_id bigint, p_aceitar boolean) returns void
language plpgsql security definer set search_path = public as $$
declare a assessorias; par assessoria_parametros;
begin
  select * into a from assessorias where id = p_id for update;
  if not found or not public.pode_admin_org(a.organizacao_id) then raise exception 'apenas administradores da empresa respondem'; end if;
  if a.situacao <> 'proposta' then raise exception 'nao ha proposta pendente'; end if;
  select * into par from assessoria_parametros where id = 1;
  if p_aceitar then
    update assessorias set situacao = 'aceita', aceito_por = auth.uid(), aceito_em = now(), aceite_versao = par.versao_aceite,
      aceite_texto = format('Comissão de %s%% sobre cada empenho do contrato assinado; taxa fixa de R$ %s se o certame for perdido; taxa fixa de R$ %s se for vencido; desistência sem cobrança. %s',
        a.comissao_pct, coalesce(a.taxa_perda, 0), coalesce(a.taxa_exito, 0), par.texto_aceite)
    where id = p_id;
    perform public._gerar_cobrancas(a.processo_id);
  else
    update assessorias set situacao = 'recusada' where id = p_id;
  end if;
end $$;

create or replace function public.cancelar_assessoria(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare a assessorias;
begin
  select * into a from assessorias where id = p_id;
  if not found then raise exception 'assessoria nao encontrada'; end if;
  if not (public.eh_admin_plataforma() or (public.pode_admin_org(a.organizacao_id) and a.situacao in ('solicitada','proposta'))) then
    raise exception 'apos o aceite, so a plataforma cancela';
  end if;
  update assessorias set situacao = 'cancelada' where id = p_id;
end $$;

-- F. cobranças: taxa se perdido; comissão por empenho quando o contrato está assinado ----------------
create or replace function public._gerar_cobrancas(p_processo bigint) returns void
language plpgsql security definer set search_path = public as $$
declare a assessorias; p processos; ativas boolean := coalesce((select taxas_fixas_ativas from assessoria_parametros where id = 1), true);
begin
  select * into a from assessorias where processo_id = p_processo and situacao = 'aceita';
  if not found then return; end if;
  select * into p from processos where id = p_processo;
  if p.status = 'perdido' and coalesce(a.taxa_perda, 0) > 0 and ativas then
    insert into assessoria_cobrancas (organizacao_id, assessoria_id, tipo, valor, observacao)
    values (a.organizacao_id, a.id, 'taxa_perda', a.taxa_perda, 'Certame perdido')
    on conflict do nothing;
  end if;
  if p.status = 'ganho' and coalesce(a.taxa_exito, 0) > 0 and ativas then
    insert into assessoria_cobrancas (organizacao_id, assessoria_id, tipo, valor, observacao)
    values (a.organizacao_id, a.id, 'taxa_exito', a.taxa_exito, 'Certame vencido')
    on conflict do nothing;
  end if;
  if p.contrato_assinado_em is not null and coalesce(a.comissao_pct, 0) > 0 then
    insert into assessoria_cobrancas (organizacao_id, assessoria_id, tipo, empenho_id, base_valor, pct, valor, observacao)
    select a.organizacao_id, a.id, 'comissao_empenho', e.id, e.valor, a.comissao_pct, round(e.valor * a.comissao_pct / 100, 2), 'Empenho ' || e.numero
    from processo_empenhos e
    where e.processo_id = p_processo
      and not exists (select 1 from assessoria_cobrancas c where c.empenho_id = e.id and c.situacao <> 'cancelada');
  end if;
end $$;
revoke execute on function public._gerar_cobrancas(bigint) from public, anon, authenticated;

create or replace function public._t_cobrancas_processo() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public._gerar_cobrancas(new.id);
  return new;
end $$;
drop trigger if exists t_cobr_processo on public.processos;
create trigger t_cobr_processo after update of status, contrato_assinado_em on public.processos for each row execute function public._t_cobrancas_processo();
create or replace function public._t_cobrancas_empenho() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public._gerar_cobrancas(new.processo_id);
  return new;
end $$;
drop trigger if exists t_cobr_empenho on public.processo_empenhos;
create trigger t_cobr_empenho after insert on public.processo_empenhos for each row execute function public._t_cobrancas_empenho();

-- empenho com cobrança gerada não pode ser apagado nem alterado pelo cliente
create or replace function public._t_empenho_travado() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from assessoria_cobrancas c where c.empenho_id = old.id and c.situacao <> 'cancelada') and not public.eh_admin_plataforma() then
    raise exception 'empenho com comissao lancada: peca a correcao a equipe';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists t_empenho_travado on public.processo_empenhos;
create trigger t_empenho_travado before update or delete on public.processo_empenhos for each row execute function public._t_empenho_travado();

create or replace function public.atualizar_cobranca(p_id bigint, p_situacao text, p_pago_em date default null, p_obs text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.eh_admin_plataforma() then raise exception 'apenas a plataforma'; end if;
  if p_situacao not in ('aberta','paga','cancelada') then raise exception 'situacao invalida'; end if;
  update assessoria_cobrancas set situacao = p_situacao, pago_em = case when p_situacao = 'paga' then coalesce(p_pago_em, current_date) end,
    observacao = coalesce(p_obs, observacao) where id = p_id;
end $$;

-- visão da plataforma
drop function if exists public.listar_assessorias();
create or replace function public.listar_assessorias() returns table (id bigint, organizacao text, processo_id bigint, titulo text, orgao text, status_processo text,
  plano text, situacao text, comissao_sugerida_pct numeric, comissao_pct numeric, taxa_perda numeric, taxa_exito numeric, margem_pct numeric, receita numeric,
  solicitado_em timestamptz, aceito_em timestamptz, cobrado numeric, recebido numeric)
language sql stable security definer set search_path = public as $$
  select a.id, o.nome, a.processo_id, p.titulo, p.orgao, p.status, a.plano, a.situacao, public.sugerir_comissao(a.processo_id), a.comissao_pct, a.taxa_perda, a.taxa_exito,
    nullif(v.totais->>'margem_pct','')::numeric, nullif(v.totais->>'receita','')::numeric, a.solicitado_em, a.aceito_em,
    (select coalesce(sum(valor),0) from assessoria_cobrancas c where c.assessoria_id = a.id and c.situacao <> 'cancelada'),
    (select coalesce(sum(valor),0) from assessoria_cobrancas c where c.assessoria_id = a.id and c.situacao = 'paga')
  from assessorias a join organizacoes o on o.id = a.organizacao_id join processos p on p.id = a.processo_id
  left join processo_viabilidade v on v.processo_id = a.processo_id
  where public.eh_admin_plataforma() order by a.solicitado_em desc;
$$;

revoke execute on function public.salvar_parametros_assessoria(jsonb), public.sugerir_comissao(bigint), public.solicitar_assessoria(bigint, text),
  public.propor_assessoria(bigint, numeric, numeric, text, numeric), public.responder_assessoria(bigint, boolean), public.cancelar_assessoria(bigint),
  public.atualizar_cobranca(bigint, text, date, text), public.listar_assessorias() from public, anon;
grant execute on function public.salvar_parametros_assessoria(jsonb), public.sugerir_comissao(bigint), public.solicitar_assessoria(bigint, text),
  public.propor_assessoria(bigint, numeric, numeric, text, numeric), public.responder_assessoria(bigint, boolean), public.cancelar_assessoria(bigint),
  public.atualizar_cobranca(bigint, text, date, text), public.listar_assessorias() to authenticated;

-- G. textos dos planos: assessoria é opcional nos dois planos pagos (Premium com condições melhores)
update public.planos set descricao = 'Dados públicos com leitura por IA, Radar, perfis de busca, acompanhamento e cálculo de lucro das licitações. Assessoria opcional, por licitação.'
  where codigo = 'basico';
update public.planos set descricao = 'Tudo do Básico, mais habilitação (SICAF e certidões) e assessoria opcional com condições de comissão melhores.'
  where codigo = 'premium';
