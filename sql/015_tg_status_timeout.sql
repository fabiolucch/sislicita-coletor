-- tg_status estourava o statement_timeout do papel anon (count de "abertos" levava ~20 s) e o bot respondia
-- "Não consegui ler a situação". Agora "abertos" vem do dashboard_cache e a função tem timeout próprio.
create or replace function public.tg_status(p_secret text) returns jsonb language sql stable security definer set search_path = public set statement_timeout = '25s' as $$
  select case when not public.tg_ok(p_secret) then null else jsonb_build_object(
    'ultima', (select jsonb_build_object('fonte', fonte, 'status', status, 'inicio', iniciado_em, 'fim', finalizado_em, 'erro', left(erro, 120))
               from coletas_log order by id desc limit 1),
    'ultima_ok', (select max(finalizado_em) from coletas_log where status = 'ok'),
    'erros_24h', (select count(*) from coletas_log where status = 'erro' and iniciado_em > now() - interval '24 hours'),
    'abertos', (select coalesce((dados->>'abertos')::bigint, 0) from dashboard_cache where id = 1),
    'radar_novo', (select count(*) from radar r join oportunidades o on o.id = r.oportunidade_id where r.status = 'novo' and o.data_fim_proposta >= now()),
    'radar_alto', (select count(*) from radar r join oportunidades o on o.id = r.oportunidade_id where r.status <> 'descartado' and r.score >= 80 and o.data_fim_proposta >= now()),
    'encerram7', (select count(*) from radar r join oportunidades o on o.id = r.oportunidade_id where r.status <> 'descartado' and o.data_fim_proposta between now() and now() + interval '7 days'),
    'alertas_7d', (select count(*) from alertas where criado_em > now() - interval '7 days'),
    'briefing', (select jsonb_build_object('titulo', titulo, 'em', gerado_em) from briefings order by id desc limit 1),
    'conectado_em', (select valor from coleta_estado where chave = 'telegram_inicio')
  ) end;
$$;
grant execute on function public.tg_status(text) to anon, authenticated;
select 'ok15';
