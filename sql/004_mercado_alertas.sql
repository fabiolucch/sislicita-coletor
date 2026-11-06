-- SISLICITA 004: mercado (contratos e resultados do PNCP), fornecedores, alertas, vigia de editais e papeis de usuario

-- Contratos assinados publicados no PNCP (quem ganhou o que, por quanto). Guardados por ~180 dias.
create table if not exists public.contratos_pncp (
  numero_controle_pncp text primary key,
  compra text,                       -- numero de controle da compra (liga com oportunidades.numero_controle_pncp)
  orgao_cnpj text, orgao_nome text, uf text, municipio text, esfera text,
  tipo text, categoria text,
  fornecedor_ni text, fornecedor_nome text, tipo_pessoa text,
  objeto text, valor_global numeric, valor_inicial numeric,
  data_assinatura date, vigencia_fim date, publicado_em timestamptz,
  objeto_tsv tsvector generated always as (to_tsvector('portuguese', coalesce(objeto,''))) stored
);
create index if not exists contratos_pncp_tsv on public.contratos_pncp using gin (objeto_tsv);
create index if not exists contratos_pncp_forn on public.contratos_pncp (fornecedor_ni);
create index if not exists contratos_pncp_pub on public.contratos_pncp (publicado_em);
create index if not exists contratos_pncp_compra on public.contratos_pncp (compra);

-- Compras homologadas (valor estimado x homologado) para medir o desconto vencedor tipico
create table if not exists public.resultados_compras (
  compra text primary key,
  orgao_nome text, uf text, municipio text, modalidade text, srp boolean,
  objeto text, valor_estimado numeric, valor_homologado numeric,
  desconto numeric generated always as (case when valor_estimado > 0 and valor_homologado > 0 then round(1 - valor_homologado / valor_estimado, 4) end) stored,
  atualizado_em timestamptz,
  objeto_tsv tsvector generated always as (to_tsvector('portuguese', coalesce(objeto,''))) stored
);
create index if not exists resultados_compras_tsv on public.resultados_compras using gin (objeto_tsv);
create index if not exists resultados_compras_at on public.resultados_compras (atualizado_em);

-- Fornecedores: agregados dos contratos + dados cadastrais (BrasilAPI) para prospeccao
alter table public.prospects add column if not exists cnae_descricao text;
alter table public.prospects add column if not exists valor_contratos_gov numeric;
alter table public.prospects add column if not exists ufs_atuacao text[];
alter table public.prospects add column if not exists ultimo_contrato date;
alter table public.prospects add column if not exists enriquecido_em timestamptz;

-- Estado das coletas incrementais e alertas (Telegram + painel)
create table if not exists public.coleta_estado (chave text primary key, valor text, atualizado_em timestamptz not null default now());
create table if not exists public.alertas (
  id bigserial primary key,
  tipo text not null, ref text not null,
  titulo text, texto text, link text,
  criado_em timestamptz not null default now(), enviado_em timestamptz,
  unique (tipo, ref)
);
alter table public.radar add column if not exists notificado_em timestamptz;
alter table public.briefings add column if not exists enviado_em timestamptz;
alter table public.oportunidades add column if not exists arquivos_ids int[];
alter table public.oportunidades add column if not exists vigia_em timestamptz;

-- Papeis de usuario: admin, editor, leitor. Quem nao tem linha e tratado como editor.
create table if not exists public.usuarios_papeis (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text, papel text not null default 'editor' check (papel in ('admin','editor','leitor')),
  criado_em timestamptz not null default now()
);

create or replace function public.meu_papel() returns text language sql stable security definer set search_path = public as $$
  select coalesce((select papel from usuarios_papeis where user_id = auth.uid()),
                  case when not exists (select 1 from usuarios_papeis) then 'admin' else 'editor' end);
$$;
create or replace function public.pode_editar() returns boolean language sql stable security definer set search_path = public as $$
  select public.meu_papel() in ('admin','editor');
$$;
create or replace function public.definir_papel(p_email text, p_papel text) returns text language plpgsql security definer set search_path = public as $$
declare u uuid;
begin
  if public.meu_papel() <> 'admin' then raise exception 'apenas administradores'; end if;
  if p_papel not in ('admin','editor','leitor') then raise exception 'papel invalido'; end if;
  select id into u from auth.users where lower(email) = lower(trim(p_email));
  if u is null then raise exception 'usuario nao encontrado: convide-o primeiro em Authentication > Users no Supabase'; end if;
  insert into usuarios_papeis (user_id, email, papel) values (u, lower(trim(p_email)), p_papel)
    on conflict (user_id) do update set papel = excluded.papel, email = excluded.email;
  return 'ok';
end $$;
create or replace function public.listar_usuarios() returns table (email text, papel text, ultimo_acesso timestamptz) language sql stable security definer set search_path = public as $$
  select u.email::text, coalesce(p.papel, 'editor'), u.last_sign_in_at from auth.users u left join usuarios_papeis p on p.user_id = u.id
  where public.meu_papel() = 'admin' order by u.email;
$$;

-- RLS: todos os autenticados leem; so admin/editor escrevem
do $$
declare t text;
begin
  foreach t in array array['contratos_pncp','resultados_compras','coleta_estado','alertas','usuarios_papeis'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity loop
    execute format('drop policy if exists auth_all on public.%I', t);
    execute format('drop policy if exists ler on public.%I', t);
    execute format('drop policy if exists inserir on public.%I', t);
    execute format('drop policy if exists alterar on public.%I', t);
    execute format('drop policy if exists apagar on public.%I', t);
    execute format('create policy ler on public.%I for select to authenticated using (true)', t);
    if t <> 'usuarios_papeis' then
      execute format('create policy inserir on public.%I for insert to authenticated with check (public.pode_editar())', t);
      execute format('create policy alterar on public.%I for update to authenticated using (public.pode_editar()) with check (public.pode_editar())', t);
      execute format('create policy apagar on public.%I for delete to authenticated using (public.pode_editar())', t);
    end if;
  end loop;
end $$;

-- Atualiza a tabela de fornecedores (prospects) a partir dos contratos
create or replace function public.atualizar_fornecedores() returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into prospects (cnpj, razao_social, origem, qtd_contratos_gov, valor_contratos_gov, ufs_atuacao, ultimo_contrato, atualizado_em)
  select fornecedor_ni, max(fornecedor_nome), 'pncp', count(*), sum(valor_global), array_agg(distinct uf) filter (where uf is not null),
         max(data_assinatura), now()
  from contratos_pncp where tipo_pessoa = 'PJ' and fornecedor_ni ~ '^\d{14}$'
  group by fornecedor_ni
  on conflict (cnpj) do update set qtd_contratos_gov = excluded.qtd_contratos_gov, valor_contratos_gov = excluded.valor_contratos_gov,
    ufs_atuacao = excluded.ufs_atuacao, ultimo_contrato = excluded.ultimo_contrato,
    razao_social = coalesce(prospects.razao_social, excluded.razao_social), atualizado_em = now();
  get diagnostics n = row_count;
  return n;
end $$;

-- Fornecedores que mais vendem um tipo de objeto (busca textual nos contratos)
create or replace function public.fornecedores_setor(q text, p_uf text default null, p_dias int default 180, p_limite int default 40)
returns table (cnpj text, nome text, contratos bigint, valor numeric, ufs text[], ultimo date, exemplo text,
               porte text, municipio text, uf text, cnae text, telefone text, email text, situacao text, prospect_id bigint)
language sql stable set search_path = public as $$
  with c as (
    select fornecedor_ni, max(fornecedor_nome) nome, count(*) n, sum(valor_global) v, array_agg(distinct uf) filter (where uf is not null) ufs,
           max(data_assinatura) ult, (array_agg(objeto order by valor_global desc nulls last))[1] ex
    from contratos_pncp
    where objeto_tsv @@ websearch_to_tsquery('portuguese', q) and tipo_pessoa = 'PJ'
      and (p_uf is null or uf = p_uf) and publicado_em > now() - make_interval(days => p_dias)
    group by fornecedor_ni
  )
  select c.fornecedor_ni, coalesce(p.razao_social, c.nome), c.n, c.v, c.ufs, c.ult, left(c.ex, 200),
         p.porte, p.municipio, p.uf, coalesce(p.cnae_descricao, p.cnae_principal), p.telefone, p.email, p.situacao_cadastral, p.id
  from c left join prospects p on p.cnpj = c.fornecedor_ni
  order by c.n desc, c.v desc nulls last limit p_limite;
$$;

-- Contratos parecidos (para preco de referencia e concorrencia)
create or replace function public.contratos_parecidos(q text, p_uf text default null, p_limite int default 30)
returns table (data date, orgao text, uf text, fornecedor text, cnpj text, objeto text, valor numeric, compra text)
language sql stable set search_path = public as $$
  select data_assinatura, orgao_nome, uf, fornecedor_nome, fornecedor_ni, left(objeto, 220), valor_global, compra
  from contratos_pncp where objeto_tsv @@ websearch_to_tsquery('portuguese', q) and (p_uf is null or uf = p_uf)
  order by data_assinatura desc nulls last limit p_limite;
$$;

-- Desconto vencedor tipico (1 - homologado/estimado) para um tipo de objeto
create or replace function public.desconto_historico(q text, p_uf text default null) returns jsonb
language sql stable set search_path = public as $$
  with r as (
    select desconto, modalidade from resultados_compras
    where objeto_tsv @@ websearch_to_tsquery('portuguese', q) and (p_uf is null or uf = p_uf)
      and desconto between -0.2 and 0.9
  )
  select jsonb_build_object(
    'n', (select count(*) from r),
    'mediana', (select percentile_cont(0.5) within group (order by desconto) from r),
    'p25', (select percentile_cont(0.25) within group (order by desconto) from r),
    'p75', (select percentile_cont(0.75) within group (order by desconto) from r),
    'por_modalidade', (select coalesce(jsonb_agg(x order by x.n desc), '[]') from (
        select modalidade, count(*) n, percentile_cont(0.5) within group (order by desconto) mediana from r group by modalidade) x));
$$;

-- Retencao: contratos 180 dias, resultados 365 dias, alertas 90 dias
create or replace function public.limpar_mercado() returns void language sql security definer set search_path = public as $$
  delete from contratos_pncp where publicado_em < now() - interval '180 days';
  delete from resultados_compras where atualizado_em < now() - interval '365 days';
  delete from alertas where criado_em < now() - interval '90 days';
$$;

grant execute on function public.fornecedores_setor, public.contratos_parecidos, public.desconto_historico, public.meu_papel,
  public.definir_papel, public.listar_usuarios to authenticated;
select 'ok4';
