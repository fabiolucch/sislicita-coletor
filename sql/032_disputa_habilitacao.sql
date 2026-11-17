-- 032: a conferência de habilitação da disputa passa a dizer se cada documento obrigatório está ANEXADO (mesmo sem data de validade),
-- considera só os documentos da natureza jurídica da empresa e informa a data da sessão, para validar na data certa.
create or replace function public.disputa_resumo(p_processo bigint) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'disputa', to_jsonb(d), 'processo', jsonb_build_object('titulo', p.titulo, 'orgao', p.orgao, 'uf', p.uf, 'status', p.status, 'link', p.link_pncp, 'empresa', e.nome, 'data_sessao', p.data_sessao),
    'itens', coalesce((select jsonb_agg(to_jsonb(i) order by i.numero) from disputa_itens i where i.processo_id = d.processo_id), '[]'::jsonb),
    'eventos', coalesce((select jsonb_agg(to_jsonb(x) order by x.em desc) from (select * from disputa_eventos where processo_id = d.processo_id order by em desc limit 60) x), '[]'::jsonb),
    'analise', (select dados from edital_analise where oportunidade_id = d.oportunidade_id),
    'assessoria', (select to_jsonb(a) from assessorias a where a.processo_id = d.processo_id),
    'habilitacao', coalesce((select jsonb_agg(jsonb_build_object('codigo', c.codigo, 'nome', c.nome, 'grupo', c.grupo, 'obrigatorio', c.obrigatorio,
         'anexado', u.id is not null, 'valido_ate', u.valido_ate, 'arquivo', u.arquivo_nome) order by c.ordem)
       from hab_catalogo c left join lateral (select h.id, h.valido_ate, h.arquivo_nome from hab_documentos h where h.codigo = c.codigo and h.organizacao_id = d.organizacao_id order by h.criado_em desc limit 1) u on true
       where c.obrigatorio and ((nat.n is null and c.naturezas <> array['pf']) or nat.n = any(c.naturezas))), '[]'::jsonb))
  from disputas d join processos p on p.id = d.processo_id left join empresas e on e.id = p.empresa_id
  left join lateral (select he.natureza n from hab_empresas he where he.organizacao_id = d.organizacao_id and he.natureza is not null and he.natureza <> 'pf' order by he.atualizado_em desc limit 1) nat on true
  where d.processo_id = p_processo and public.pode_ler_org(d.organizacao_id);
$$;
