-- Testes da reformulação (rodam numa transação e SEMPRE terminam em erro "RESULTADO: {...}", que desfaz tudo).
-- Uso: colar no SQL editor do Supabase. Esperado em RESULTADO:
--   A: hierarquia "1 de 4 itens", itens_excluidos 1, itens_sem_codigo 2;  B: codigo_item;  C: "nenhuma"
--   C_ve_corr/C_lista/C_pca = 0 (isolamento entre empresas);  iniciar_disputa/solicitar_assessoria: permission denied
do $$ declare r jsonb := '{}'; x jsonb; e text;
begin
  insert into cat_nos (tipo,nivel,codigo,nome,caminho,busca) values
   ('M','item','447402','CARNE BOVINA IN NATURA, ALCATRA','{"grupo":"89","classe":"8905","pdm":"4548","item":"447402"}','x'),
   ('M','item','999001','CARNE DEFUMADA TESTE','{"grupo":"89","classe":"8905","pdm":"4552","item":"999001"}','x'),
   ('M','item','999002','ITEM DE OUTRA CLASSE','{"grupo":"65","classe":"6505","item":"999002"}','x')
  on conflict do nothing;
  update oportunidade_itens set cat_tipo=null, cat_nivel=null, cat_codigo=null where oportunidade_id in (874,5667,5749);
  update oportunidade_itens set cat_tipo='M', cat_nivel='item', cat_codigo='447402' where oportunidade_id=874 and numero_item=(select min(numero_item) from oportunidade_itens where oportunidade_id=874);
  update oportunidade_itens set cat_tipo='M', cat_nivel='item', cat_codigo='999001' where oportunidade_id=874 and numero_item=(select min(numero_item)+1 from oportunidade_itens where oportunidade_id=874);
  update oportunidade_itens set cat_tipo='S', cat_nivel='servico', cat_codigo='21121' where oportunidade_id=5667 and numero_item=(select min(numero_item) from oportunidade_itens where oportunidade_id=5667);
  update oportunidade_itens set cat_tipo='M', cat_nivel='item', cat_codigo='999002' where oportunidade_id=5749;
  update oportunidades set objeto = 'Aquisição de carne bovina para teste', data_fim_proposta = now() + interval '10 days' where id in (5749);
  update oportunidades set data_fim_proposta = now() + interval '10 days' where id in (874, 5667);
  perform set_config('request.jwt.claims', json_build_object('sub','8ebab03c-3a74-4e1c-ba28-213610ed8612','role','authenticated')::text, true);
  perform set_config('role','authenticated',true);
  perform public.salvar_linha('M','classe','8905','incluir');
  perform public.salvar_linha('M','pdm','4552','excluir');
  perform public.salvar_linha('M','pdm','4548','incluir','cortes bovinos para churrasco');
  perform public.salvar_linha('S','servico','21121','incluir');
  begin perform public.salvar_linha('S','classe','8905'); e := 'ACEITOU'; exception when others then e := 'recusou código inexistente'; end;
  r := r || jsonb_build_object('codigo_inexistente', e);
  x := public.atualizar_correspondencias();
  r := r || jsonb_build_object('calc', x);
  r := r || jsonb_build_object('A', (select to_jsonb(c) - 'organizacao_id' - 'calculado_em' - 'linha_id' from correspondencias c where ref_id=874 and fonte='licitacao'));
  r := r || jsonb_build_object('B', (select evidencia from correspondencias c where ref_id=5667 and fonte='licitacao'));
  r := r || jsonb_build_object('C', coalesce((select motivo from correspondencias c where ref_id=5749 and fonte='licitacao'),'nenhuma'));
  begin perform public.iniciar_disputa(874, null); e:='EXECUTOU'; exception when others then e:=left(sqlerrm,60); end; r:=r||jsonb_build_object('iniciar_disputa',e);
  begin perform public.solicitar_assessoria(1, null); e:='EXECUTOU'; exception when others then e:=left(sqlerrm,60); end; r:=r||jsonb_build_object('solicitar_assessoria',e);
  r := r || jsonb_build_object('analise', public.analisar_viabilidade(874) = public.analisar_viabilidade(874));   -- reaproveita (sem duplicar)
  perform set_config('request.jwt.claims', json_build_object('sub','7b8cc4aa-cb30-4859-806e-03e6631b682f','role','authenticated')::text, true);
  r := r || jsonb_build_object('C_ve_corr', (select count(*) from correspondencias), 'C_lista', (select count(*) from public.oportunidades_linha()),
    'C_pca', (select count(*) from public.pca_linha()), 'C_interesses', (select count(*) from public.listar_interesses(null)));
  raise exception 'RESULTADO: %', r;
end $$;
