-- Score de interesse: o quanto a licitação vale o seu tempo, não só se bateu a palavra-chave.
--
-- O score antigo (radar.score) era "50 + ts_rank*100", e ts_rank fica em 0,01-0,05:
-- TODAS as 16 mil linhas ficaram entre 51 e 55, e o alerta do Telegram (>= 80) nunca disparava.
-- radar.score passa a significar só ADERÊNCIA ao perfil; radar.interesse é a nota de decisão.

alter table public.radar add column if not exists interesse int;
alter table public.radar add column if not exists interesse_detalhe jsonb;
alter table public.radar add column if not exists interesse_em timestamptz;
create index if not exists radar_interesse on public.radar (interesse desc nulls last);

-- 1) aderência por palavra-chave numa escala que realmente separa (curva saturante)
create or replace function public.atualizar_radar() returns void language plpgsql as $$
declare
p record;
q tsquery;
x tsquery;
begin
for p in select * from public.perfis_busca where ativo loop
q := websearch_to_tsquery('portuguese', (select string_agg('"' || w || '"', ' OR ') from unnest(p.palavras_incluir) w));
if q is null or q::text = '' then continue; end if;
x := case when cardinality(p.palavras_excluir) > 0 then websearch_to_tsquery('portuguese', (select string_agg('"' || w || '"', ' OR ') from unnest(p.palavras_excluir) w)) else null end;
if 'edital' = any(p.fontes) then
insert into public.radar (perfil_id, oportunidade_id, score, justificativa)
select p.id, o.id, greatest(20, least(95, round(100 * (1 - exp(-ts_rank(o.objeto_tsv, q) * 25)))::int)), 'Palavras-chave do perfil no objeto'
from public.oportunidades o
where o.objeto_tsv @@ q
and (x is null or not (o.objeto_tsv @@ x))
and o.situacao = 'Divulgada no PNCP'
and o.data_fim_proposta >= now() + make_interval(days => p.dias_min_abertura)
and (p.valor_min is null or o.valor_sigiloso or o.valor_estimado >= p.valor_min)
and (p.valor_max is null or o.valor_sigiloso or o.valor_estimado <= p.valor_max)
and (cardinality(p.ufs) = 0 or o.uf = any(p.ufs))
and (cardinality(p.modalidades) = 0 or o.modalidade = any(p.modalidades))
on conflict (perfil_id, oportunidade_id) where oportunidade_id is not null do nothing;
end if;
if 'pca' = any(p.fontes) then
insert into public.radar (perfil_id, pca_item_id, score, justificativa)
select p.id, i.id, greatest(20, least(95, round(100 * (1 - exp(-ts_rank(i.descricao_tsv, q) * 25)))::int)), 'Item previsto no PCA'
from public.pca_itens i
where i.descricao_tsv @@ q
and (x is null or not (i.descricao_tsv @@ x))
and (i.data_desejada is null or i.data_desejada >= current_date)
on conflict (perfil_id, pca_item_id) where pca_item_id is not null do nothing;
end if;
end loop;
end;
$$;

-- 2) o score de decisão: aderência + retorno + margem + risco + prazo
--    Cada parte vai de 0 a 100; o que não se sabe entra como 50 (neutro), para que
--    falta de dado não premie nem puna.
create or replace function public.calcular_interesse(p_limite int default 6000) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  with alvo as (
    select r.id, r.score,
           coalesce(o.valor_estimado, i.valor_total) valor,
           coalesce(o.valor_sigiloso, false) sigiloso,
           coalesce(o.data_fim_proposta::date, i.data_desejada) prazo,
           o.ia_termo, a.risco
    from radar r
    left join oportunidades o on o.id = r.oportunidade_id
    left join pca_itens i on i.id = r.pca_item_id
    left join edital_analise a on a.oportunidade_id = r.oportunidade_id
    where r.status <> 'descartado'
      and (r.oportunidade_id is null or o.data_fim_proposta >= now())
    order by r.score desc
    limit p_limite
  ), calc as (
    select t.*,
      -- retorno: comissão potencial, em escala log (R$ 30 mil = 0, R$ 10 mi = 100)
      case when t.sigiloso then 50
           when coalesce(t.valor,0) > 0 then greatest(0, least(100, round(((log(t.valor) - 4.5) / 2.5) * 100)))
           else 50 end ret,
      -- prazo: dá para mobilizar uma empresa a tempo?
      case when t.prazo is null then 50
           when t.prazo - current_date < 2  then 20
           when t.prazo - current_date <= 5 then 60
           when t.prazo - current_date <= 20 then 100
           when t.prazo - current_date <= 60 then 85
           else 65 end pz,
      -- risco: quanto o edital é restritivo (invertido)
      case when t.risco is null then 50 else 100 - t.risco end rk,
      -- margem: desconto típico da disputa nesse objeto (30% ou mais = folga grande).
      -- Com menos de 5 compras na amostra isso é ruído, não sinal: entra neutro.
      case when coalesce(d.qt,0) >= 5 then d.mg else 50 end mg,
      coalesce(d.qt,0) mg_n
    from alvo t
    left join lateral (
      select count(*) qt,
             least(100, greatest(0, round((percentile_cont(0.5) within group (order by rc.desconto)) / 0.30 * 100))) mg
      from resultados_compras rc
      where t.ia_termo is not null and length(t.ia_termo) > 2
        and rc.objeto_tsv @@ websearch_to_tsquery('portuguese', t.ia_termo)
        and rc.desconto is not null
    ) d on true
  )
  update public.radar r set
    interesse = round(0.35*c.score + 0.25*c.ret + 0.15*c.mg + 0.10*c.rk + 0.15*c.pz),
    interesse_detalhe = jsonb_build_object('aderencia', c.score, 'retorno', c.ret, 'margem', c.mg, 'margem_n', c.mg_n, 'risco', c.rk, 'prazo', c.pz),
    interesse_em = now()
  from calc c where r.id = c.id;
  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function public.calcular_interesse(int) from public, anon;
grant execute on function public.calcular_interesse(int) to service_role, authenticated;

select 'ok7_interesse';
