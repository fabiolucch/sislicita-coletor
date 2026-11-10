-- 027: alinha os planos ao modelo comercial acordado e torna a proposta de assessoria
-- dependente de uma solicitação do cliente. Esta migração não escolhe preços nem gateway.

insert into public.planos (codigo, nome, descricao, preco_mensal, recursos, ordem, ativo) values
  ('teste_7_dias', 'Teste grátis · 7 dias', 'Acesso temporário às pesquisas, ao Radar e aos recursos de IA. Não inclui acompanhamento de processos nem habilitação SICAF.', 0, '{dados_publicos,ia,radar,perfis}', 0, true),
  ('gratuito', 'Gratuito', 'Pesquisas públicas básicas. O teste de 7 dias libera também Radar, perfis e IA.', 0, '{dados_publicos}', 1, true),
  ('basico', 'Básico', 'Pesquisas, Radar, perfis e acompanhamento de licitações, sem recursos de IA. Assessoria pode ser solicitada à parte por licitação.', null, '{dados_publicos,radar,perfis,processos}', 2, true),
  ('premium', 'Premium', 'Tudo do Básico, com IA e habilitação SICAF. A assessoria é opcional, negociada e contratada à parte por licitação.', null, '{dados_publicos,ia,radar,perfis,processos,habilitacao}', 3, true)
on conflict (codigo) do update set
  nome = excluded.nome,
  descricao = excluded.descricao,
  recursos = excluded.recursos,
  ordem = excluded.ordem,
  ativo = excluded.ativo;

-- Organizações atualmente no período de teste passam a usar a permissão específica do teste.
update public.assinaturas
set plano = 'teste_7_dias', atualizado_em = now()
where situacao = 'teste';

create or replace function public.solicitar_plano(p_plano text, p_obs text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare o uuid := public.org_atual();
begin
  if o is null or not public.pode_admin_org(o) then
    raise exception 'apenas administradores da organizacao pedem troca de plano';
  end if;
  if p_plano not in ('basico', 'premium') then
    raise exception 'selecione o plano Basico ou Premium';
  end if;
  update public.solicitacoes_plano set situacao = 'cancelada'
  where organizacao_id = o and situacao = 'aberta';
  insert into public.solicitacoes_plano (organizacao_id, plano, solicitante, observacao)
  values (o, p_plano, auth.uid(), left(p_obs, 500));
end
$$;

create or replace function public.definir_plano(
  p_org uuid,
  p_plano text,
  p_situacao text,
  p_teste_ate timestamptz default null,
  p_periodo_fim timestamptz default null
)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.eh_admin_plataforma() then raise exception 'apenas a plataforma altera planos'; end if;
  if not exists (select 1 from public.planos where codigo = p_plano and ativo) then
    raise exception 'plano invalido';
  end if;
  if p_situacao not in ('teste', 'ativa', 'pendente', 'inadimplente', 'cancelada') then
    raise exception 'situacao invalida';
  end if;
  if p_situacao = 'teste' and (p_plano <> 'teste_7_dias' or p_teste_ate is null or p_teste_ate <= now()) then
    raise exception 'o teste deve usar o plano de 7 dias e uma data futura';
  end if;
  if p_plano = 'teste_7_dias' and p_situacao <> 'teste' then
    raise exception 'o plano de teste so pode ser ativado como teste';
  end if;

  insert into public.assinaturas (organizacao_id, plano, situacao, teste_ate, periodo_fim)
  values (p_org, p_plano, p_situacao, p_teste_ate, p_periodo_fim)
  on conflict (organizacao_id) do update set
    plano = excluded.plano,
    situacao = excluded.situacao,
    teste_ate = excluded.teste_ate,
    periodo_fim = excluded.periodo_fim,
    atualizado_em = now();

  insert into public.assinaturas_eventos (organizacao_id, tipo, dados, por)
  values (p_org, 'plano_definido',
    jsonb_build_object('plano', p_plano, 'situacao', p_situacao, 'teste_ate', p_teste_ate, 'periodo_fim', p_periodo_fim), auth.uid());
  update public.solicitacoes_plano set situacao = 'atendida'
  where organizacao_id = p_org and situacao = 'aberta' and plano = p_plano;
end
$$;

revoke execute on function public.solicitar_plano(text, text),
  public.definir_plano(uuid, text, text, timestamptz, timestamptz) from public, anon;
grant execute on function public.solicitar_plano(text, text),
  public.definir_plano(uuid, text, text, timestamptz, timestamptz) to authenticated, service_role;

create or replace function public._assinatura_inicial()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.tipo = 'cliente' then
    insert into public.assinaturas (organizacao_id, plano, situacao, teste_ate)
    values (new.id, 'teste_7_dias', 'teste', now() + interval '7 days')
    on conflict (organizacao_id) do nothing;
    insert into public.assinaturas_eventos (organizacao_id, tipo, dados)
    values (new.id, 'teste_iniciado', jsonb_build_object('plano', 'teste_7_dias', 'dias', 7));
  end if;
  return new;
end
$$;

-- Processos não ficam acessíveis pelo plano gratuito após o término do teste.
drop policy if exists plano_processos_ins on public.processos;
drop policy if exists plano_processos on public.processos;
create policy plano_processos on public.processos as restrictive for all to authenticated
  using (public.tem_recurso_org(organizacao_id, 'processos'))
  with check (public.tem_recurso_org(organizacao_id, 'processos'));

-- Cada proposta guarda uma cópia imutável do texto e das condições que o cliente verá.
alter table public.assessorias add column if not exists termo_versao_proposta text;
alter table public.assessorias add column if not exists termo_texto_proposta text;
alter table public.assessorias add column if not exists proposta_snapshot jsonb;

create or replace function public.definir_assessoria_processo(
  p_processo bigint,
  p_comissao numeric,
  p_taxa numeric default 0,
  p_obs text default null,
  p_taxa_exito numeric default 0
)
returns bigint
language plpgsql security definer set search_path = public
as $$
declare
  v_org uuid;
  v_assessoria bigint;
  v_situacao text;
  v_plano text;
  v_termos assessoria_parametros;
  v_taxas_ativas boolean;
  v_taxa_perda numeric(12,2);
  v_taxa_sucesso numeric(12,2);
begin
  if not public.eh_admin_plataforma() then
    raise exception 'apenas a plataforma define as condicoes';
  end if;
  if p_comissao is null or p_comissao < 0 or p_comissao > 100
     or coalesce(p_taxa, 0) < 0 or coalesce(p_taxa_exito, 0) < 0 then
    raise exception 'condicoes financeiras invalidas';
  end if;

  select organizacao_id into v_org from public.processos where id = p_processo;
  if v_org is null then raise exception 'processo nao encontrado'; end if;

  select id, situacao into v_assessoria, v_situacao
  from public.assessorias where processo_id = p_processo for update;
  if v_assessoria is null or v_situacao not in ('solicitada', 'proposta', 'aceita') then
    raise exception 'o cliente precisa solicitar a assessoria antes de receber uma proposta';
  end if;

  select * into v_termos from public.assessoria_parametros where id = 1;
  if not found or nullif(btrim(v_termos.texto_aceite), '') is null
     or nullif(btrim(v_termos.versao_aceite), '') is null then
    raise exception 'configure a versao e o texto dos termos antes de enviar propostas';
  end if;
  v_taxas_ativas := coalesce(v_termos.taxas_fixas_ativas, false);
  v_taxa_perda := case when v_taxas_ativas then coalesce(p_taxa, 0) else 0 end;
  v_taxa_sucesso := case when v_taxas_ativas then coalesce(p_taxa_exito, 0) else 0 end;
  select public.plano_efetivo(v_org) into v_plano;

  update public.assessorias set
    situacao = 'proposta',
    plano = v_plano,
    comissao_pct = p_comissao,
    taxa_perda = v_taxa_perda,
    taxa_exito = v_taxa_sucesso,
    comissao_sugerida_pct = public.sugerir_comissao(p_processo),
    proposta_por = auth.uid(),
    proposta_em = now(),
    observacao_plataforma = left(p_obs, 1000),
    termo_versao_proposta = v_termos.versao_aceite,
    termo_texto_proposta = v_termos.texto_aceite,
    proposta_snapshot = jsonb_build_object(
      'processo_id', p_processo,
      'plano_cliente', v_plano,
      'comissao_pct', p_comissao,
      'base_comissao', 'cada empenho registrado após a assinatura do contrato com o órgão',
      'taxa_perda', v_taxa_perda,
      'taxa_exito', v_taxa_sucesso,
      'observacao_plataforma', left(p_obs, 1000),
      'proposta_em', now()
    ),
    aceito_por = null,
    aceito_em = null,
    aceite_versao = null,
    aceite_texto = null
  where id = v_assessoria;

  return v_assessoria;
end
$$;

create or replace function public.propor_assessoria(
  p_id bigint,
  p_comissao numeric,
  p_taxa numeric,
  p_obs text default null,
  p_taxa_exito numeric default 0
)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_processo bigint;
begin
  select processo_id into v_processo from public.assessorias where id = p_id;
  if v_processo is null then raise exception 'assessoria nao encontrada'; end if;
  perform public.definir_assessoria_processo(v_processo, p_comissao, p_taxa, p_obs, p_taxa_exito);
end
$$;

create or replace function public.responder_assessoria(p_id bigint, p_aceitar boolean)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  a public.assessorias;
begin
  if p_aceitar is null then raise exception 'informe aceitar ou recusar a proposta'; end if;
  select * into a from public.assessorias where id = p_id for update;
  if not found or not public.pode_admin_org(a.organizacao_id) then
    raise exception 'apenas administradores da empresa respondem';
  end if;
  if a.situacao <> 'proposta' then raise exception 'nao ha proposta pendente'; end if;

  if p_aceitar then
    if a.proposta_snapshot is null or a.termo_versao_proposta is null or a.termo_texto_proposta is null then
      raise exception 'a proposta nao possui uma versao completa dos termos';
    end if;
    update public.assessorias set
      situacao = 'aceita',
      aceito_por = auth.uid(),
      aceito_em = now(),
      aceite_versao = a.termo_versao_proposta,
      aceite_texto = jsonb_build_object(
        'termos', a.termo_texto_proposta,
        'condicoes', a.proposta_snapshot
      )::text
    where id = p_id;
    perform public._gerar_cobrancas(a.processo_id);
  else
    update public.assessorias set situacao = 'recusada' where id = p_id;
  end if;
end
$$;

revoke execute on function public.definir_assessoria_processo(bigint, numeric, numeric, text, numeric),
  public.propor_assessoria(bigint, numeric, numeric, text, numeric),
  public.responder_assessoria(bigint, boolean) from public, anon;
grant execute on function public.definir_assessoria_processo(bigint, numeric, numeric, text, numeric),
  public.propor_assessoria(bigint, numeric, numeric, text, numeric),
  public.responder_assessoria(bigint, boolean) to authenticated;
