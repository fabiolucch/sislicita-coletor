-- 026: a plataforma define as condições da assessoria diretamente em cada processo (sem depender de pedido do cliente).
-- Se as condições de uma assessoria já aceita forem alteradas, ela volta para "proposta" e o cliente precisa aceitar de novo.
create or replace function public.definir_assessoria_processo(p_processo bigint, p_comissao numeric, p_taxa numeric default 0, p_obs text default null, p_taxa_exito numeric default 0) returns bigint
language plpgsql security definer set search_path = public as $$
declare o uuid; a bigint; ativas boolean := coalesce((select taxas_fixas_ativas from assessoria_parametros where id = 1), true);
begin
  if not public.eh_admin_plataforma() then raise exception 'apenas a plataforma define as condicoes'; end if;
  if p_comissao is null or p_comissao < 0 or p_comissao > 100 then raise exception 'comissao invalida'; end if;
  select organizacao_id into o from processos where id = p_processo;
  if o is null then raise exception 'processo nao encontrado'; end if;
  insert into assessorias (organizacao_id, processo_id, plano, situacao, comissao_sugerida_pct, comissao_pct, taxa_perda, taxa_exito, proposta_por, proposta_em, observacao_plataforma)
  values (o, p_processo, public.plano_efetivo(o), 'proposta', public.sugerir_comissao(p_processo), p_comissao,
          case when ativas then coalesce(p_taxa, 0) else 0 end, case when ativas then coalesce(p_taxa_exito, 0) else 0 end, auth.uid(), now(), left(p_obs, 1000))
  on conflict (processo_id) do update set situacao = 'proposta', comissao_pct = excluded.comissao_pct, taxa_perda = excluded.taxa_perda, taxa_exito = excluded.taxa_exito,
    comissao_sugerida_pct = excluded.comissao_sugerida_pct, proposta_por = excluded.proposta_por, proposta_em = now(), observacao_plataforma = excluded.observacao_plataforma,
    aceito_por = null, aceito_em = null, aceite_versao = null, aceite_texto = null
  returning id into a;
  return a;
end $$;
revoke execute on function public.definir_assessoria_processo(bigint, numeric, numeric, text, numeric) from public, anon;
grant execute on function public.definir_assessoria_processo(bigint, numeric, numeric, text, numeric) to authenticated;
