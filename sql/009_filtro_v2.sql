-- SISLICITA - Filtro v2: vetores (pgvector + Gemini embedding), perfil descrito em texto, triagem com nota e faixas.
create extension if not exists vector with schema extensions;

-- vetor de significado de cada edital (objeto), 768 dimensoes, meia precisao
create table if not exists public.edital_emb (
  oportunidade_id bigint primary key references public.oportunidades(id) on delete cascade,
  emb extensions.halfvec(768) not null,
  em timestamptz not null default now()
);
alter table public.edital_emb enable row level security;
drop policy if exists edital_emb_ler on public.edital_emb;
create policy edital_emb_ler on public.edital_emb for select to authenticated using (true);
drop policy if exists edital_emb_ins on public.edital_emb;
create policy edital_emb_ins on public.edital_emb for insert to authenticated with check (true);

alter table public.perfis_busca add column if not exists comissao_pct numeric not null default 1;
alter table public.perfis_busca add column if not exists nota_alta int not null default 70;
alter table public.perfis_busca add column if not exists nota_revisao int not null default 45;
alter table public.perfis_busca add column if not exists exemplos_pos bigint[] not null default '{}';
alter table public.perfis_busca add column if not exists exemplos_neg bigint[] not null default '{}';
alter table public.perfis_busca add column if not exists emb_desc extensions.halfvec(768);
alter table public.perfis_busca add column if not exists emb extensions.halfvec(768);
alter table public.perfis_busca add column if not exists calib jsonb;
alter table public.perfis_busca add column if not exists funil jsonb;
alter table public.perfis_busca add column if not exists triado_em timestamptz;

create table if not exists public.triagem (
  perfil_id uuid not null references public.perfis_busca(id) on delete cascade,
  oportunidade_id bigint not null references public.oportunidades(id) on delete cascade,
  nota int not null,
  faixa text not null,          -- alta | revisao | baixa | regra
  sem real,                     -- semelhanca (cosseno) com o perfil
  motivo text,
  comp jsonb,
  em timestamptz not null default now(),
  primary key (perfil_id, oportunidade_id)
);
create index if not exists triagem_faixa_idx on public.triagem (perfil_id, faixa, nota desc);
alter table public.triagem enable row level security;
drop policy if exists triagem_ler on public.triagem;
create policy triagem_ler on public.triagem for select to authenticated using (true);

create table if not exists public.funil_diario (
  perfil_id uuid not null references public.perfis_busca(id) on delete cascade,
  dia date not null,
  dados jsonb not null,
  primary key (perfil_id, dia)
);
alter table public.funil_diario enable row level security;
drop policy if exists funil_ler on public.funil_diario;
create policy funil_ler on public.funil_diario for select to authenticated using (true);

create or replace function public._autorizado() returns boolean language sql stable as $$
  select auth.uid() is not null or coalesce(auth.role(), '') = 'service_role' or current_user in ('postgres', 'service_role')
$$;

-- editais abertos ainda sem vetor (para o coletor)
create or replace function public.pendentes_vetor(p_limite int default 1000)
returns table (id bigint, texto text)
language sql security definer set search_path = public, extensions set statement_timeout = '60s' as $$
  select o.id, left(coalesce(o.objeto, ''), 2000)
  from oportunidades o
  where o.data_fim_proposta > now() and coalesce(o.objeto, '') <> ''
    and not exists (select 1 from edital_emb e where e.oportunidade_id = o.id)
  order by o.data_fim_proposta
  limit p_limite
$$;

-- vetor final do perfil = descricao + media dos exemplos bons - metade da media dos ruins; e a calibragem da nota
create or replace function public.compor_perfil(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions set statement_timeout = '120s' as $$
declare p perfis_busca; d real[]; po real[]; ne real[]; v real[]; med real; alto real; pos_sim real; n int := 768;
begin
  if not _autorizado() then raise exception 'nao autenticado'; end if;
  select * into p from perfis_busca where id = p_id;
  d := case when p.emb_desc is null then null else p.emb_desc::vector::real[] end;
  select avg(e.emb::vector)::real[] into po from edital_emb e where e.oportunidade_id = any(p.exemplos_pos);
  select avg(e.emb::vector)::real[] into ne from edital_emb e where e.oportunidade_id = any(p.exemplos_neg);
  if d is null and po is null then
    update perfis_busca set emb = null, calib = null where id = p_id;
    return jsonb_build_object('erro', 'descreva o perfil ou marque exemplos');
  end if;
  select array_agg(coalesce(d[i], 0) + coalesce(po[i], 0) - 0.5 * coalesce(ne[i], 0) order by i) into v from generate_series(1, n) i;
  update perfis_busca set emb = l2_normalize(v::vector)::halfvec(768) where id = p_id returning * into p;
  -- calibragem: mediana dos editais abertos = nota 0; nivel dos exemplos bons (ou o 0,3% mais parecido) = nota 85
  select percentile_cont(0.5) within group (order by s), percentile_cont(0.997) within group (order by s) into med, alto
  from (select 1 - (e.emb <=> p.emb) as s from edital_emb e join oportunidades o on o.id = e.oportunidade_id where o.data_fim_proposta > now()) x;
  select avg(1 - (e.emb <=> p.emb)) into pos_sim from edital_emb e where e.oportunidade_id = any(p.exemplos_pos);
  if pos_sim is not null and alto is not null then alto := least(alto, pos_sim); end if;
  if med is null then med := 0.5; alto := 0.8; end if;
  alto := greatest(alto, med + 0.04);
  update perfis_busca set calib = jsonb_build_object('med', med, 'alto', alto, 'pos', pos_sim) where id = p_id;
  return jsonb_build_object('med', med, 'alto', alto, 'pos', pos_sim);
end $$;

-- triagem de todos os editais abertos para um perfil: nota 0-100, faixa e motivo; devolve o funil
create or replace function public.triar_perfil(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions set statement_timeout = '180s' as $$
declare p perfis_busca; q tsquery; x tsquery; med real; alto real; f jsonb;
begin
  if not _autorizado() then raise exception 'nao autenticado'; end if;
  perform compor_perfil(p_id);
  select * into p from perfis_busca where id = p_id;
  if p.emb is null then return jsonb_build_object('erro', 'descreva o perfil ou marque exemplos'); end if;
  med := (p.calib->>'med')::real; alto := (p.calib->>'alto')::real;
  q := case when cardinality(p.palavras_incluir) > 0 then websearch_to_tsquery('portuguese', (select string_agg('"' || w || '"', ' OR ') from unnest(p.palavras_incluir) w)) end;
  x := case when cardinality(p.palavras_excluir) > 0 then websearch_to_tsquery('portuguese', (select string_agg('"' || w || '"', ' OR ') from unnest(p.palavras_excluir) w)) end;
  delete from triagem where perfil_id = p_id;
  insert into triagem (perfil_id, oportunidade_id, nota, faixa, sem, motivo, comp)
  select p_id, t.id, t.nota,
    case when t.regra is not null then 'regra' when t.nota >= p.nota_alta then 'alta' when t.nota >= p.nota_revisao then 'revisao' else 'baixa' end,
    t.s, coalesce(t.regra, case when t.nota >= p.nota_alta then 'Muito parecido com o perfil' when t.nota >= p.nota_revisao then 'Parecido; confira' else 'Pouco parecido com o perfil' end),
    jsonb_build_object('sem', t.ns, 'reforco', t.kp, 'penal', t.kn)
  from (
    select o.id, s.s, s.ns, k.kp, k.kn,
      greatest(0, least(100, s.ns + k.kp - k.kn)) as nota,
      case
        when o.situacao is distinct from 'Divulgada no PNCP' then 'Situação: ' || coalesce(o.situacao, '?')
        when cardinality(p.ufs) > 0 and not (o.uf = any(p.ufs)) then 'UF fora do perfil (' || coalesce(o.uf, '?') || ')'
        when cardinality(p.modalidades) > 0 and not (o.modalidade = any(p.modalidades)) then 'Modalidade fora do perfil'
        when p.valor_min is not null and not o.valor_sigiloso and coalesce(o.valor_estimado, 0) > 0 and o.valor_estimado < p.valor_min then 'Valor abaixo do mínimo'
        when p.valor_max is not null and not o.valor_sigiloso and o.valor_estimado > p.valor_max then 'Valor acima do máximo'
        when o.data_fim_proposta < now() + make_interval(days => p.dias_min_abertura) then 'Prazo curto (menos de ' || p.dias_min_abertura || ' dias)'
      end as regra
    from oportunidades o
    join edital_emb e on e.oportunidade_id = o.id
    cross join lateral (select 1 - (e.emb <=> p.emb) as s) s0
    cross join lateral (select s0.s, round(greatest(0, (s0.s - med) / nullif(alto - med, 0)) * 85)::int as ns) s
    cross join lateral (select case when q is not null and o.objeto_tsv @@ q then 10 else 0 end as kp,
                               case when x is not null and o.objeto_tsv @@ x then 20 else 0 end as kn) k
    where o.data_fim_proposta > now()
  ) t;
  select jsonb_build_object(
    'abertos', (select count(*) from oportunidades where data_fim_proposta > now()),
    'com_vetor', (select count(*) from triagem where perfil_id = p_id),
    'alta', count(*) filter (where faixa = 'alta'),
    'revisao', count(*) filter (where faixa = 'revisao'),
    'baixa', count(*) filter (where faixa = 'baixa'),
    'regra', count(*) filter (where faixa = 'regra'),
    'cortes', (select coalesce(jsonb_object_agg(m, c), '{}'::jsonb) from (
        select regexp_replace(motivo, ' \(.*$', '') m, count(*) c from triagem where perfil_id = p_id and faixa = 'regra' group by 1) z),
    'quase', count(*) filter (where faixa = 'baixa' and nota >= p.nota_revisao - 10),
    'regra_bons', count(*) filter (where faixa = 'regra' and nota >= p.nota_alta),
    'calib', p.calib, 'em', now())
  into f from triagem where perfil_id = p_id;
  update perfis_busca set funil = f, triado_em = now() where id = p_id;
  insert into funil_diario (perfil_id, dia, dados) values (p_id, current_date, f)
  on conflict (perfil_id, dia) do update set dados = excluded.dados;
  return f;
end $$;

-- coloca no radar os "alta" dos perfis ativos; tira os que deixaram de ser alta e voce ainda nao mexeu
create or replace function public.radar_v2(p_id uuid) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  insert into radar (perfil_id, oportunidade_id, score, justificativa)
  select perfil_id, oportunidade_id, nota, 'Filtro v2: ' || motivo from triagem where perfil_id = p_id and faixa = 'alta'
  on conflict (perfil_id, oportunidade_id) where oportunidade_id is not null
  do update set score = excluded.score, justificativa = excluded.justificativa;
  get diagnostics n = row_count;
  delete from radar r where r.perfil_id = p_id and r.oportunidade_id is not null and r.justificativa like 'Filtro v2:%'
    and coalesce(r.status, 'novo') = 'novo'
    and not exists (select 1 from triagem t where t.perfil_id = r.perfil_id and t.oportunidade_id = r.oportunidade_id and t.faixa = 'alta');
  return n;
end $$;

create or replace function public.triar_todos() returns jsonb
language plpgsql security definer set search_path = public, extensions set statement_timeout = '600s' as $$
declare p record; r jsonb := '{}'::jsonb; f jsonb;
begin
  for p in select id, nome from perfis_busca where ativo and (emb_desc is not null or cardinality(exemplos_pos) > 0) loop
    f := triar_perfil(p.id);
    perform radar_v2(p.id);
    r := r || jsonb_build_object(p.nome, f->'alta');
  end loop;
  delete from triagem t using perfis_busca p where p.id = t.perfil_id and not p.ativo and p.triado_em < now() - interval '3 days';
  return r;
end $$;

grant execute on function public.compor_perfil(uuid), public.triar_perfil(uuid), public.radar_v2(uuid) to authenticated;

-- o radar antigo (palavras-chave) deixa de tratar editais dos perfis v2; o PCA continua por palavras
do $$
declare d text;
begin
  d := pg_get_functiondef('public.atualizar_radar'::regproc);
  if position('p.emb_desc is null' in d) = 0 then
    d := replace(d, 'if ''edital'' = any(p.fontes) then', 'if ''edital'' = any(p.fontes) and p.emb_desc is null and cardinality(p.exemplos_pos) = 0 then');
    if position('p.emb_desc is null' in d) = 0 then raise exception 'nao achei o trecho do radar antigo'; end if;
    execute d;
  end if;
end $$;
