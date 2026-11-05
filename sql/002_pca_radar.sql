-- SISLICITA - ajustes do PCA e funcao do radar (v2)
alter table public.pca_planos add column if not exists itens_coletados_em timestamptz;
alter table public.pca_itens add column if not exists sequencial_pca int;
alter table public.pca_itens add column if not exists codigo_unidade text;
alter table public.pca_itens add column if not exists nome_unidade text;
alter table public.pca_itens add column if not exists classificacao_codigo text;
alter table public.pca_itens add column if not exists classificacao_nome text;
alter table public.pca_itens add column if not exists grupo_contratacao text;
alter table public.pca_itens drop constraint if exists pca_itens_plano_id_numero_item_key;
create unique index if not exists pca_itens_uq on public.pca_itens (plano_id, sequencial_pca, numero_item);

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
select p.id, o.id, least(100, 50 + round(ts_rank(o.objeto_tsv, q) * 100)::int), 'Palavras-chave do perfil no objeto'
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
select p.id, i.id, least(100, 50 + round(ts_rank(i.descricao_tsv, q) * 100)::int), 'Item previsto no PCA'
from public.pca_itens i
where i.descricao_tsv @@ q
and (x is null or not (i.descricao_tsv @@ x))
and (i.data_desejada is null or i.data_desejada >= current_date)
on conflict (perfil_id, pca_item_id) where pca_item_id is not null do nothing;
end if;
end loop;
end;
$$;

revoke execute on function public.atualizar_radar() from public, anon, authenticated;
grant execute on function public.atualizar_radar() to service_role;
