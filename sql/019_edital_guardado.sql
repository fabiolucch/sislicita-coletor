-- Editais guardados pelo usuario (botao "Guardar no meu banco" nos Detalhes):
-- o texto fica no banco para sempre (a limpeza dos 30 dias nao apaga) e o edital ganha vetor.
alter table public.edital_textos add column if not exists guardado boolean not null default false;

create or replace function public.limpar_mercado() returns void language sql security definer set search_path = public as $fn$
  delete from contratos_pncp where publicado_em < now() - interval '180 days';
  delete from resultados_compras where atualizado_em < now() - interval '180 days';
  delete from resultados_compras where atualizado_em < now() - interval '60 days' and valor_homologado is null;
  delete from alertas where criado_em < now() - interval '90 days';
  delete from edital_textos t using oportunidades o where o.id = t.oportunidade_id and not t.guardado and o.data_fim_proposta < now() - interval '30 days';
$fn$;

-- vetor: editais abertos + editais guardados (mesmo encerrados)
create or replace function public.pendentes_vetor(p_limite int default 1000)
returns table (id bigint, texto text)
language sql security definer set search_path = public, extensions set statement_timeout = '60s' as $$
  (select o.id, left(coalesce(o.objeto, ''), 2000)
   from oportunidades o
   where o.data_fim_proposta > now() and coalesce(o.objeto, '') <> ''
     and not exists (select 1 from edital_emb e where e.oportunidade_id = o.id)
   order by o.data_fim_proposta
   limit p_limite)
  union all
  (select o.id, left(coalesce(o.objeto, ''), 2000)
   from edital_textos t join oportunidades o on o.id = t.oportunidade_id
   where t.guardado and o.data_fim_proposta <= now() and coalesce(o.objeto, '') <> ''
     and not exists (select 1 from edital_emb e where e.oportunidade_id = o.id)
   limit p_limite)
$$;
