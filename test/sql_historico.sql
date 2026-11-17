-- Teste do histórico → linha (transação que sempre termina em erro "RESULTADO: {...}" e desfaz tudo).
-- Esperado: salvos=2 (classe 8905 M e grupo 979 S), principal_antes=8905, principal_depois=979, repetir=0 (não duplica),
--           outra_org=0 (isolamento), anon = permission denied.
do $$ declare r jsonb := '{}'; e text; id979 uuid;
begin
  perform set_config('request.jwt.claims', json_build_object('sub','8ebab03c-3a74-4e1c-ba28-213610ed8612','role','authenticated')::text, true);
  perform set_config('role','authenticated',true);
  r := r || jsonb_build_object('salvos', public.salvar_linhas_historico('[{"t":"M","c":"4550","n":5,"v":1000,"u":"2025-05-01"},{"t":"M","c":"4548","n":9,"v":4000},{"t":"S","c":"10006","n":2,"v":100},{"t":"M","c":"99999999","n":1}]'::jsonb));
  r := r || jsonb_build_object('principal_antes', (select codigo from minha_linha() where principal));
  select id into id979 from minha_linha() where codigo='979';
  perform public.definir_linha_principal(id979);
  r := r || jsonb_build_object('principal_depois', (select codigo from minha_linha() where principal), 'n_principais', (select count(*) from minha_linha() where principal));
  r := r || jsonb_build_object('repetir', public.salvar_linhas_historico('[{"t":"M","c":"4548","n":1}]'::jsonb));
  r := r || jsonb_build_object('origem', (select jsonb_agg(origem||':'||nivel||':'||codigo) from minha_linha()), 'evidencia', (select evidencia from minha_linha() where codigo='8905'));
  perform set_config('request.jwt.claims', json_build_object('sub','7b8cc4aa-cb30-4859-806e-03e6631b682f','role','authenticated')::text, true);
  r := r || jsonb_build_object('outra_org', (select count(*) from minha_linha()));
  perform set_config('role','anon',true);
  begin perform public.salvar_linhas_historico('[]'::jsonb); e:='EXECUTOU'; exception when others then e:=left(sqlerrm,40); end; r := r || jsonb_build_object('anon', e);
  raise exception 'RESULTADO: %', r;
end $$;
