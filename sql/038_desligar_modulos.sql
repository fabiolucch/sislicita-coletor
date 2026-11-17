-- 038: desligamento REVERSÍVEL de assessoria, disputa e acompanhamento operacional de processos.
-- Nada é apagado: tabelas, registros e funções continuam no banco.
-- Para reativar um módulo: update app_flags set ativo = true where chave = '...'; e
--   grant execute on function <função> to authenticated;  (as mesmas listadas abaixo)

-- operações exclusivas: sem execução por usuários (o serviço e o postgres continuam podendo)
do $$ declare f text; begin
  foreach f in array array[
    'atualizar_cobranca(bigint, text, date, text)', 'cancelar_assessoria(bigint)', 'confirmar_contrato_assessoria(bigint)',
    'confirmar_empenho_assessoria(bigint)', 'confirmar_resultado_assessoria(bigint, text)',
    'definir_assessoria_processo(bigint, numeric, numeric, text, numeric)', 'listar_assessorias()',
    'propor_assessoria(bigint, numeric, numeric, text, numeric)', 'responder_assessoria(bigint, boolean)',
    'salvar_parametros_assessoria(jsonb)', 'solicitar_assessoria(bigint, text)', 'sugerir_comissao(bigint)',
    'calcular_lances(bigint)', 'disputa_resumo(bigint)', 'iniciar_disputa(bigint, bigint)',
    'mudar_situacao_disputa(bigint, text)', 'registrar_lance(bigint, integer, numeric, numeric, integer, text, text)']
  loop
    if to_regprocedure('public.' || f) is not null then
      execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    end if;
  end loop;
end $$;

-- tabelas exclusivas: política restritiva ligada à flag (histórico guardado; enquanto desligado só a plataforma consulta)
do $$ declare t text; m text; begin
  foreach t in array array['assessoria_parametros', 'parametros_custo', 'assessorias', 'assessoria_cobrancas', 'processo_empenhos',
                           'disputas', 'disputa_itens', 'disputa_eventos', 'processos', 'processo_viabilidade'] loop
    m := case when t in ('disputas', 'disputa_itens', 'disputa_eventos') then 'disputa'
              when t in ('processos', 'processo_viabilidade', 'processo_empenhos') then 'processos' else 'assessoria' end;
    if to_regclass('public.' || t) is not null and not exists (
         select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = 'modulo_desligado') then
      execute format('create policy modulo_desligado on public.%I as restrictive for all to authenticated using (public.flag_ativa(%L) or public.eh_admin_plataforma()) with check (public.flag_ativa(%L) or public.eh_admin_plataforma())', t, m, m);
    end if;
  end loop;
end $$;
