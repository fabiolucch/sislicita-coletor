-- SISLICITA - triagem mais leve: calcula tudo numa tabela temporaria e grava em `triagem` so o que a tela usa
-- (alta, revisao, quase entraram, cortados por regra com nota >= revisao e os exemplos). Os totais continuam de todos os editais.
create or replace function public.triar_perfil(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions set statement_timeout = '180s' as $$
declare p perfis_busca; q tsquery; x tsquery; med real; alto real; f jsonb;
begin
  if not _autorizado() then raise exception 'nao autenticado'; end if;
  if not pg_try_advisory_xact_lock(hashtext('triar:' || p_id::text)) then
    return jsonb_build_object('erro', 'Já existe uma triagem deste perfil em andamento. Aguarde 1 ou 2 minutos e recarregue a página.');
  end if;
  perform compor_perfil(p_id);
  select * into p from perfis_busca where id = p_id;
  if p.emb is null then return jsonb_build_object('erro', 'descreva o perfil ou marque exemplos'); end if;
  med := (p.calib->>'med')::real; alto := (p.calib->>'alto')::real;
  q := case when cardinality(p.palavras_incluir) > 0 then websearch_to_tsquery('portuguese', (select string_agg('"' || w || '"', ' OR ') from unnest(p.palavras_incluir) w)) end;
  x := case when cardinality(p.palavras_excluir) > 0 then websearch_to_tsquery('portuguese', (select string_agg('"' || w || '"', ' OR ') from unnest(p.palavras_excluir) w)) end;

  create temp table _tri on commit drop as
  select o.id as oportunidade_id, s.s, s.ns, k.kp, k.kn,
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
  cross join lateral (select 1 - (e.emb <=> p.emb) as s0) s0
  cross join lateral (select s0.s0 as s, round(greatest(0, (s0.s0 - med) / nullif(alto - med, 0)) * 85)::int as ns) s
  cross join lateral (select case when q is not null and o.objeto_tsv @@ q then 10 else 0 end as kp,
                             case when x is not null and o.objeto_tsv @@ x then 20 else 0 end as kn) k
  where o.data_fim_proposta > now();

  alter table _tri add column faixa text;
  update _tri set faixa = case when regra is not null then 'regra' when nota >= p.nota_alta then 'alta' when nota >= p.nota_revisao then 'revisao' else 'baixa' end;

  delete from triagem where perfil_id = p_id;
  insert into triagem (perfil_id, oportunidade_id, nota, faixa, sem, motivo, comp)
  select p_id, t.oportunidade_id, t.nota, t.faixa, t.s,
    coalesce(t.regra, case when t.nota >= p.nota_alta then 'Muito parecido com o perfil' when t.nota >= p.nota_revisao then 'Parecido; confira' else 'Pouco parecido com o perfil' end),
    jsonb_build_object('sem', t.ns, 'reforco', t.kp, 'penal', t.kn)
  from _tri t
  where t.faixa in ('alta', 'revisao')
     or (t.faixa = 'baixa' and t.nota >= p.nota_revisao - 10)
     or (t.faixa = 'regra' and t.nota >= p.nota_revisao)
     or t.oportunidade_id = any(coalesce(p.exemplos_pos, '{}') || coalesce(p.exemplos_neg, '{}'));

  select jsonb_build_object(
    'abertos', (select count(*) from oportunidades where data_fim_proposta > now()),
    'com_vetor', count(*),
    'alta', count(*) filter (where faixa = 'alta'),
    'revisao', count(*) filter (where faixa = 'revisao'),
    'baixa', count(*) filter (where faixa = 'baixa'),
    'regra', count(*) filter (where faixa = 'regra'),
    'cortes', (select coalesce(jsonb_object_agg(m, c), '{}'::jsonb) from (
        select regexp_replace(regra, ' \(.*$', '') m, count(*) c from _tri where faixa = 'regra' group by 1) z),
    'quase', count(*) filter (where faixa = 'baixa' and nota >= p.nota_revisao - 10),
    'regra_bons', count(*) filter (where faixa = 'regra' and nota >= p.nota_alta),
    'calib', p.calib, 'em', now())
  into f from _tri;
  update perfis_busca set funil = f, triado_em = now() where id = p_id;
  insert into funil_diario (perfil_id, dia, dados) values (p_id, current_date, f)
  on conflict (perfil_id, dia) do update set dados = excluded.dados;
  return f;
end $$;
