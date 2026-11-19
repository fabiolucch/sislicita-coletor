-- 043 — fluxo do usuário: etapas de "Minhas licitações" e caixa de Triagem (só o que ainda não foi decidido)
alter table public.licitacoes_interesse drop constraint if exists licitacoes_interesse_status_check;
alter table public.licitacoes_interesse add constraint licitacoes_interesse_status_check
  check (status in ('a_analisar','em_analise','viavel','proposta_enviada','ganha','perdida','inviavel','arquivada'));

create or replace function public.decidir_interesse(p_id uuid, p_status text, p_obs text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_status not in ('a_analisar','em_analise','viavel','proposta_enviada','ganha','perdida','inviavel','arquivada') then
    raise exception 'situação inválida';
  end if;
  update licitacoes_interesse set status = p_status, decisao_obs = coalesce(left(p_obs, 1000), decisao_obs), decisao_por = auth.uid(),
    decisao_em = now(), atualizado_em = now()
  where id = p_id and public.pode_editar_org(organizacao_id);
  if not found then raise exception 'análise não encontrada'; end if;
end $$;

-- triagem: decidir direto pela oportunidade (cria o registro se preciso)
create or replace function public.triar_oportunidade(p_oportunidade bigint, p_status text)
returns uuid language plpgsql security definer set search_path = public as $$
declare rid uuid;
begin
  if p_status not in ('a_analisar','arquivada') then raise exception 'situação inválida'; end if;
  rid := public.marcar_interesse(p_oportunidade);
  update licitacoes_interesse set status = p_status, decisao_por = auth.uid(), decisao_em = now(), atualizado_em = now() where id = rid;
  return rid;
end $$;
grant execute on function public.triar_oportunidade(bigint, text) to authenticated;

drop function if exists public.oportunidades_linha(text, text, text, text, integer, integer, boolean);
create function public.oportunidades_linha(p_conf text default null, p_busca text default null, p_uf text default null,
  p_ordem text default 'prazo', p_limite integer default 30, p_offset integer default 0, p_aplicar_refinos boolean default true,
  p_so_novas boolean default false)
returns table(id bigint, numero_controle_pncp text, objeto text, orgao_nome text, unidade_nome text, uf text, municipio text,
  modalidade text, valor_estimado numeric, valor_sigiloso boolean, data_publicacao date, data_fim_proposta timestamptz, situacao text,
  link_pncp text, atualizado_em timestamptz, ia_resumo text, ia_atencao text, confianca text, evidencia text, motivo text,
  itens_compat integer, itens_total integer, itens_sem_codigo integer, valor_compat numeric, nota integer, interesse text, total bigint)
language plpgsql stable security definer set search_path = public as $$
declare o uuid := public.org_atual(); pf perfis_busca; q tsquery;
begin
  if o is null or not public.pode_ler_org(o) then raise exception 'sem permissão'; end if;
  select * into pf from perfis_busca where organizacao_id = o and origem = 'linha';
  if coalesce(trim(p_busca), '') <> '' then q := websearch_to_tsquery('portuguese', p_busca); end if;
  return query
  with base as (
    select c.ref_id, c.confianca, c.evidencia, c.motivo, c.itens_compat, c.itens_total, c.itens_sem_codigo, c.valor_compat, null::int nota
    from correspondencias c where c.organizacao_id = o and c.fonte = 'licitacao'
    union all
    select t.oportunidade_id, 'revisar', 'semantica',
      'Possível compatibilidade pelo significado do objeto (semelhança ' || t.nota || '/100); revise.', null, null, null, null, t.nota
    from triagem t
    where pf.id is not null and t.perfil_id = pf.id and t.faixa in ('alta', 'revisao')
      and not exists (select 1 from correspondencias c where c.organizacao_id = o and c.fonte = 'licitacao' and c.ref_id = t.oportunidade_id)
  )
  select op.id, op.numero_controle_pncp, op.objeto, op.orgao_nome, op.unidade_nome, op.uf, op.municipio, op.modalidade,
    op.valor_estimado, op.valor_sigiloso, op.data_publicacao, op.data_fim_proposta, op.situacao, op.link_pncp, op.atualizado_em,
    op.ia_resumo, op.ia_atencao,
    b.confianca, b.evidencia, b.motivo, b.itens_compat, b.itens_total, b.itens_sem_codigo, b.valor_compat, b.nota,
    (select li.status from licitacoes_interesse li where li.organizacao_id = o and li.oportunidade_id = op.id),
    count(*) over ()
  from base b join oportunidades op on op.id = b.ref_id
  where op.data_fim_proposta > now()
    and (p_conf is null or b.confianca = p_conf)
    and (p_uf is null or op.uf = p_uf)
    and (q is null or op.objeto_tsv @@ q)
    and (not p_so_novas or not exists (select 1 from licitacoes_interesse li where li.organizacao_id = o and li.oportunidade_id = op.id))
    and (not p_aplicar_refinos or pf.id is null or (
          (cardinality(pf.ufs) = 0 or op.uf = any(pf.ufs))
      and (cardinality(pf.modalidades) = 0 or op.modalidade = any(pf.modalidades))
      and (pf.valor_min is null or op.valor_sigiloso or coalesce(op.valor_estimado, 0) = 0 or op.valor_estimado >= pf.valor_min)
      and (pf.valor_max is null or op.valor_sigiloso or op.valor_estimado is null or op.valor_estimado <= pf.valor_max)
      and (op.data_fim_proposta >= now() + make_interval(days => coalesce(pf.dias_min_abertura, 0)))))
  order by (b.confianca = 'confirmada') desc,
    case when p_ordem = 'valor' then -coalesce(b.valor_compat, op.valor_estimado, 0) else 0 end,
    case when p_ordem = 'recentes' then -extract(epoch from op.data_publicacao::timestamptz) else 0 end,
    op.data_fim_proposta
  limit least(coalesce(p_limite, 30), 100) offset coalesce(p_offset, 0);
end $$;
grant execute on function public.oportunidades_linha(text, text, text, text, integer, integer, boolean, boolean) to authenticated;
