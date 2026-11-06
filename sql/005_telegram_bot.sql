-- SISLICITA 005: bot do Telegram responde /start e /status pelo webhook do Cloudflare (/api/telegram)
-- O segredo do webhook fica em coleta_estado (telegram_webhook_secret), definido pelo coletor ao registrar o webhook.
create or replace function public.tg_ok(p_secret text) returns boolean language sql stable security definer set search_path = public as $$
  select p_secret is not null and length(p_secret) >= 20
     and p_secret = (select valor from coleta_estado where chave = 'telegram_webhook_secret');
$$;

create or replace function public.tg_registrar(p_secret text, p_chat text) returns text language plpgsql security definer set search_path = public as $$
declare atual text;
begin
  if not public.tg_ok(p_secret) then return 'negado'; end if;
  select valor into atual from coleta_estado where chave = 'telegram_chat';
  if atual is null then
    insert into coleta_estado (chave, valor) values ('telegram_chat', p_chat);
    return 'registrado';
  end if;
  return case when atual = p_chat then 'dono' else 'outro' end;
end $$;

create or replace function public.tg_status(p_secret text) returns jsonb language sql stable security definer set search_path = public as $$
  select case when not public.tg_ok(p_secret) then null else jsonb_build_object(
    'ultima', (select jsonb_build_object('fonte', fonte, 'status', status, 'inicio', iniciado_em, 'fim', finalizado_em, 'erro', left(erro, 120))
               from coletas_log order by id desc limit 1),
    'ultima_ok', (select max(finalizado_em) from coletas_log where status = 'ok'),
    'erros_24h', (select count(*) from coletas_log where status = 'erro' and iniciado_em > now() - interval '24 hours'),
    'abertos', (select count(*) from oportunidades where data_fim_proposta >= now()),
    'radar_novo', (select count(*) from radar r join oportunidades o on o.id = r.oportunidade_id where r.status = 'novo' and o.data_fim_proposta >= now()),
    'radar_alto', (select count(*) from radar r join oportunidades o on o.id = r.oportunidade_id where r.status <> 'descartado' and r.score >= 80 and o.data_fim_proposta >= now()),
    'encerram7', (select count(*) from radar r join oportunidades o on o.id = r.oportunidade_id where r.status <> 'descartado' and o.data_fim_proposta between now() and now() + interval '7 days'),
    'alertas_7d', (select count(*) from alertas where criado_em > now() - interval '7 days'),
    'briefing', (select jsonb_build_object('titulo', titulo, 'em', gerado_em) from briefings order by id desc limit 1),
    'conectado_em', (select valor from coleta_estado where chave = 'telegram_inicio')
  ) end;
$$;

grant execute on function public.tg_ok(text), public.tg_registrar(text, text), public.tg_status(text) to anon, authenticated;
select 'ok5';
