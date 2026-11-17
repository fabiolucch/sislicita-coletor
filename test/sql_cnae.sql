-- Teste da relação CNAE → classe/grupo e da confirmação (transação que sempre termina em erro "RESULTADO", desfazendo tudo).
-- Esperado: registrar=2; sugestoes inclui "4634601:Mclasse8905:alta:3/4" e "4634601:Sgrupo979:alta:2/4"; ia_salvas_4691500=1 (código inventado recusado);
--   linha.origem=cnae_fornecedores, confirmada=true; confirmadas_agora=1; confirmacoes_cnae=1; outra_org_linhas=0; anon=permission denied.
do $$ declare r jsonb := '{}'; e text; k int; lid uuid;
begin
  r := r || jsonb_build_object('registrar', public.registrar_cnae_catalogo('4634601', 4, '[{"f":"a","t":"M","c":"4548"},{"f":"a","t":"M","c":"4550"},{"f":"b","t":"M","c":"3267"},{"f":"c","t":"M","c":"4548"},{"f":"d","t":"S","c":"10006"},{"f":"a","t":"S","c":"10006"}]'::jsonb));
  perform set_config('request.jwt.claims', json_build_object('sub','8ebab03c-3a74-4e1c-ba28-213610ed8612','role','authenticated')::text, true);
  perform set_config('role','authenticated',true);
  r := r || jsonb_build_object('sugestoes', (select jsonb_agg(cnae||':'||tipo||nivel||codigo||':'||confianca||':'||apoio||'/'||amostra) from sugestoes_cnae(array['4634601','4691500'])));
  begin perform salvar_sugestoes_cnae('[{"cnae":"4691500","tipo":"M","nivel":"classe","codigo":"8905","motivo":"x"},{"cnae":"4691500","tipo":"M","nivel":"classe","codigo":"99999","motivo":"inventado"}]'::jsonb); exception when others then e:=sqlerrm; end;
  r := r || jsonb_build_object('ia_salvas_4691500', (select count(*) from sugestoes_cnae(array['4691500'])), 'erro_ia', e);
  lid := confirmar_sugestao_cnae('M','classe','8905', array['4634601'], 'cnae_fornecedores','alta','x');
  r := r || jsonb_build_object('linha', (select to_jsonb(m) - 'id' - 'rotulo' - 'atualizado_em' - 'catalogo_sincronizado_em' - 'nome' from minha_linha() m where id=lid));
  k := salvar_linhas_historico('[{"t":"S","c":"10006","n":2,"v":100}]'::jsonb);
  r := r || jsonb_build_object('hist_confirmada', (select confirmada from minha_linha() where codigo='979'), 'confirmadas_agora', confirmar_linhas(array(select id from minha_linha() where not confirmada)));
  r := r || jsonb_build_object('confirmacoes_cnae', (select confirmacoes from sugestoes_cnae(array['4634601']) where codigo='8905'));
  perform set_config('request.jwt.claims', json_build_object('sub','7b8cc4aa-cb30-4859-806e-03e6631b682f','role','authenticated')::text, true);
  r := r || jsonb_build_object('outra_org_linhas', (select count(*) from minha_linha()));
  perform set_config('role','anon',true);
  begin perform sugestoes_cnae(array['4634601']); e:='EXECUTOU'; exception when others then e:=left(sqlerrm,40); end; r := r || jsonb_build_object('anon', e);
  raise exception 'RESULTADO: %', r;
end $$;
