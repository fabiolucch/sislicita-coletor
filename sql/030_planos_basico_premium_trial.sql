-- 030: planos Básico/Premium e escolha do plano após o teste completo de 7 dias.
-- A rotina registra o plano pretendido, mas não efetua cobrança: falta integrar o provedor e checkout.

alter table public.assinaturas
  add column if not exists plano_apos_teste text references public.planos(codigo),
  add column if not exists cancelar_apos_teste boolean not null default false;

update public.planos
set nome = 'Teste por 7 dias',
    descricao = 'Acesso completo por sete dias a todos os recursos do sistema.',
    preco_mensal = 0,
    recursos = '{dados_publicos,ia,radar,perfis,processos,habilitacao,precos,mercado}',
    ordem = 0,
    ativo = true
where codigo = 'teste_7_dias';

update public.planos
set nome = 'Pesquisa e PCA',
    descricao = 'Pesquisa de editais públicos no PNCP e consulta ao Plano de Contratações Anual.',
    recursos = '{dados_publicos}',
    ordem = 1,
    ativo = true
where codigo = 'gratuito';

update public.planos
set nome = 'Plano Básico',
    descricao = 'Pesquisa de editais no PNCP e consulta ao PCA. Não inclui Radar, Triagem, IA, acompanhamento ou habilitação.',
    recursos = '{dados_publicos}',
    ordem = 2,
    ativo = true
where codigo = 'basico';

update public.planos
set nome = 'Plano Premium',
    descricao = 'Acesso completo: editais, PCA, Radar, Triagem, IA, acompanhamento de licitações e habilitação SICAF de empresas e pessoas.',
    recursos = '{dados_publicos,ia,radar,perfis,processos,habilitacao,precos,mercado}',
    ordem = 3,
    ativo = true
where codigo = 'premium';

-- Planos antigos podem conter a permissão de Assessoria. Ela fica guardada no código,
-- mas deixa de ser um recurso ativo até a retomada do módulo.
update public.planos set recursos = array_remove(recursos, 'assessoria') where 'assessoria' = any(recursos);

create or replace function public.escolher_plano_apos_teste(p_plano text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_org uuid := public.org_atual();
  v_assinatura public.assinaturas;
begin
  if v_org is null or not public.pode_admin_org(v_org) then
    raise exception 'apenas administradores da organização podem escolher o plano';
  end if;
  if p_plano is null or p_plano not in ('basico','premium') then
    raise exception 'selecione o Plano Básico ou o Plano Premium';
  end if;
  select * into v_assinatura from public.assinaturas where organizacao_id = v_org for update;
  if not found or v_assinatura.situacao <> 'teste' or v_assinatura.teste_ate <= now() then
    raise exception 'a escolha do plano após o teste só pode ser feita durante os 7 dias grátis';
  end if;

  update public.assinaturas
  set plano_apos_teste = p_plano, cancelar_apos_teste = false, atualizado_em = now()
  where organizacao_id = v_org;
  update public.solicitacoes_plano set situacao = 'cancelada'
  where organizacao_id = v_org and situacao = 'aberta';
  insert into public.solicitacoes_plano (organizacao_id, plano, solicitante, observacao)
  values (v_org, p_plano, auth.uid(), 'Plano escolhido para após o teste gratuito de 7 dias. A cobrança requer a integração do checkout.');
  insert into public.assinaturas_eventos (organizacao_id, tipo, dados, por)
  values (v_org, 'plano_apos_teste_escolhido', jsonb_build_object('plano', p_plano, 'teste_ate', v_assinatura.teste_ate), auth.uid());
  return jsonb_build_object('ok', true, 'plano_apos_teste', p_plano, 'teste_ate', v_assinatura.teste_ate);
end
$$;

create or replace function public.cancelar_plano_apos_teste()
returns void
language plpgsql security definer set search_path = public
as $$
declare v_org uuid := public.org_atual();
begin
  if v_org is null or not public.pode_admin_org(v_org) then
    raise exception 'apenas administradores da organização podem alterar a assinatura';
  end if;
  if not exists (select 1 from public.assinaturas where organizacao_id = v_org and situacao = 'teste' and teste_ate > now()) then
    raise exception 'não há teste gratuito ativo para cancelar';
  end if;
  update public.assinaturas set plano_apos_teste = null, cancelar_apos_teste = true, atualizado_em = now()
  where organizacao_id = v_org;
  update public.solicitacoes_plano set situacao = 'cancelada'
  where organizacao_id = v_org and situacao = 'aberta';
  insert into public.assinaturas_eventos (organizacao_id, tipo, dados, por)
  values (v_org, 'plano_apos_teste_cancelado', jsonb_build_object('em', now()), auth.uid());
end
$$;

create or replace function public.meu_plano() returns jsonb
language sql stable security definer set search_path = public as $$
  with o as (select public.org_atual() id), e as (select public.plano_efetivo((select id from o)) p)
  select jsonb_build_object(
    'plano', (select p from e),
    'nome', coalesce((select nome from planos where codigo = (select p from e)), 'Plataforma'),
    'recursos', case when (select p from e) = 'plataforma' or public.eh_admin_plataforma() then to_jsonb(array['*'])
                     else to_jsonb(coalesce((select recursos from planos where codigo = (select p from e)), '{}')) end,
    'contratado', (select plano from assinaturas where organizacao_id = (select id from o)),
    'situacao', (select situacao from assinaturas where organizacao_id = (select id from o)),
    'teste_ate', (select teste_ate from assinaturas where organizacao_id = (select id from o)),
    'plano_apos_teste', (select plano_apos_teste from assinaturas where organizacao_id = (select id from o)),
    'cancelar_apos_teste', (select cancelar_apos_teste from assinaturas where organizacao_id = (select id from o)),
    'solicitado', (select plano from solicitacoes_plano where organizacao_id = (select id from o) and situacao = 'aberta' order by criado_em desc limit 1));
$$;

revoke execute on function public.escolher_plano_apos_teste(text), public.cancelar_plano_apos_teste() from public, anon;
grant execute on function public.escolher_plano_apos_teste(text), public.cancelar_plano_apos_teste() to authenticated;
revoke execute on function public.meu_plano() from public, anon;
grant execute on function public.meu_plano() to authenticated, service_role;
