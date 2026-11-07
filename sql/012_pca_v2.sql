-- SISLICITA 012 - filtro v2 tambem no PCA (previsao de compras)
create table if not exists public.pca_emb (
  pca_item_id bigint primary key references public.pca_itens(id) on delete cascade,
  emb extensions.halfvec(768) not null,
  em timestamptz not null default now()
);
alter table public.pca_emb enable row level security;
drop policy if exists pca_emb_ler on public.pca_emb;
create policy pca_emb_ler on public.pca_emb for select to authenticated using (true);

create table if not exists public.triagem_pca (
  perfil_id uuid not null references public.perfis_busca(id) on delete cascade,
  pca_item_id bigint not null references public.pca_itens(id) on delete cascade,
  nota int not null, faixa text not null, sem real, motivo text,
  em timestamptz not null default now(),
  primary key (perfil_id, pca_item_id)
);
create index if not exists triagem_pca_faixa_idx on public.triagem_pca (perfil_id, faixa, nota desc);
alter table public.triagem_pca enable row level security;
drop policy if exists triagem_pca_ler on public.triagem_pca;
create policy triagem_pca_ler on public.triagem_pca for select to authenticated using (true);

alter table public.perfis_busca add column if not exists funil_pca jsonb;

-- itens futuros do PCA ainda sem vetor
create or replace function public.pendentes_vetor_pca(p_limite int default 1000)
returns table (id bigint, texto text)
language sql security definer set search_path = public, extensions set statement_timeout = '60s' as $f$
  select i.id, left(coalesce(i.descricao, '') || case when i.classificacao_nome is null then '' else ' (' || i.classificacao_nome || ')' end, 2000)
  from pca_itens i
  where i.data_desejada >= current_date and length(coalesce(i.descricao, '')) >= 10
    and not exists (select 1 from pca_emb e where e.pca_item_id = i.id)
  order by i.data_desejada
  limit p_limite
$f$;

-- triagem dos itens do PCA para um perfil (mesma nota 0-100; regras: UF e faixa de valor)
create or replace function public.triar_pca(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions set statement_timeout = '240s' as $f$
declare p perfis_busca; med real; alto real; f jsonb;
begin
  if not _autorizado() then raise exception 'nao autenticado'; end if;
  select * into p from perfis_busca where id = p_id;
  if p.emb is null then return jsonb_build_object('erro', 'perfil sem vetor'); end if;

  create temp table _pc on commit drop as
  select i.id as pca_item_id, (1 - (e.emb <=> p.emb))::real as s,
    case
      when cardinality(p.ufs) > 0 and pl.uf is not null and not (pl.uf = any(p.ufs)) then 'UF fora do perfil (' || pl.uf || ')'
      when p.valor_min is not null and coalesce(i.valor_total, 0) > 0 and i.valor_total < p.valor_min then 'Valor abaixo do mínimo'
      when p.valor_max is not null and coalesce(i.valor_total, 0) > 0 and i.valor_total > p.valor_max then 'Valor acima do máximo'
    end as regra
  from pca_itens i
  join pca_emb e on e.pca_item_id = i.id
  join pca_planos pl on pl.id = i.plano_id
  where i.data_desejada >= current_date;

  select percentile_cont(0.5) within group (order by s), percentile_cont(0.997) within group (order by s)
    into med, alto from _pc;
  if med is null then return jsonb_build_object('erro', 'nenhum item do PCA vetorizado ainda'); end if;
  alto := greatest(alto, med + 0.04);

  alter table _pc add column nota int;
  alter table _pc add column faixa text;
  update _pc set nota = greatest(0, least(100, round(greatest(0, (s - med) / (alto - med)) * 85)::int)) where true;
  update _pc set faixa = case when regra is not null then 'regra' when nota >= p.nota_alta then 'alta'
                              when nota >= p.nota_revisao then 'revisao' else 'baixa' end where true;

  delete from triagem_pca where perfil_id = p_id;
  insert into triagem_pca (perfil_id, pca_item_id, nota, faixa, sem, motivo)
  select p_id, t.pca_item_id, t.nota, t.faixa, t.s,
    coalesce(t.regra, case when t.nota >= p.nota_alta then 'Muito parecido com o perfil'
                           when t.nota >= p.nota_revisao then 'Parecido; confira'
                           else 'Pouco parecido com o perfil' end)
  from _pc t
  where t.faixa in ('alta', 'revisao') or (t.faixa = 'baixa' and t.nota >= p.nota_revisao - 10)
     or (t.faixa = 'regra' and t.nota >= p.nota_revisao);

  select jsonb_build_object('itens', count(*),
    'alta', count(*) filter (where faixa = 'alta'), 'revisao', count(*) filter (where faixa = 'revisao'),
    'baixa', count(*) filter (where faixa = 'baixa'), 'regra', count(*) filter (where faixa = 'regra'),
    'calib', jsonb_build_object('med', med, 'alto', alto), 'em', now())
  into f from _pc;
  update perfis_busca set funil_pca = f where id = p_id;
  return f;
end $f$;
