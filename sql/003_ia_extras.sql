-- SISLICITA - v3: itens, textos e analise de editais, briefing, PCA por IA, aprendizado, docs da empresa
create table if not exists public.oportunidade_itens (
  oportunidade_id bigint not null references public.oportunidades(id) on delete cascade,
  numero_item int not null,
  descricao text, tipo text, quantidade numeric, unidade text,
  valor_unitario numeric, valor_total numeric, criterio text, beneficio text,
  sigiloso boolean, situacao text,
  primary key (oportunidade_id, numero_item)
);
alter table public.oportunidades add column if not exists itens_em timestamptz;
alter table public.oportunidades add column if not exists analise_em timestamptz;

create table if not exists public.edital_textos (
  oportunidade_id bigint primary key references public.oportunidades(id) on delete cascade,
  arquivo text, paginas int, texto text, extraido_em timestamptz not null default now()
);
create table if not exists public.edital_analise (
  oportunidade_id bigint primary key references public.oportunidades(id) on delete cascade,
  dados jsonb, risco int, resumo text, fonte text, analisado_em timestamptz not null default now()
);
create table if not exists public.avaliacoes_pca (
  perfil_id uuid not null references public.perfis_busca(id) on delete cascade,
  pca_item_id bigint not null references public.pca_itens(id) on delete cascade,
  score int, justificativa text, avaliado_em timestamptz not null default now(),
  primary key (perfil_id, pca_item_id)
);
create table if not exists public.briefings (
  id bigserial primary key,
  perfil_id uuid references public.perfis_busca(id) on delete cascade,
  gerado_em timestamptz not null default now(),
  titulo text, resumo text, destaques jsonb, alertas jsonb
);
create table if not exists public.empresa_docs (
  id bigserial primary key,
  empresa_id bigint not null references public.empresas(id) on delete cascade,
  tipo text not null, numero text, validade date, observacao text,
  criado_em timestamptz not null default now()
);
alter table public.perfis_busca add column if not exists prompt_sugerido text;
alter table public.perfis_busca add column if not exists prompt_sugerido_motivo text;
alter table public.perfis_busca add column if not exists prompt_sugerido_em timestamptz;
alter table public.processos add column if not exists checklist jsonb;
alter table public.processos add column if not exists checklist_em timestamptz;

do $$
declare t text;
begin
  foreach t in array array['oportunidade_itens','edital_textos','edital_analise','avaliacoes_pca','briefings','empresa_docs'] loop
    execute format('alter table public.%I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname='public' and tablename=t and policyname='auth_all') then
      execute format('create policy auth_all on public.%I for all to authenticated using (true) with check (true)', t);
    end if;
  end loop;
end $$;

-- Supabase Pro: guarda editais encerrados por 365 dias (historico de precos e concorrencia)
create or replace function public.limpar_antigos() returns integer language plpgsql security definer set search_path to 'public' as $$
declare n int;
begin
  delete from public.oportunidades o
  where o.data_fim_proposta < now() - interval '365 days'
    and not exists (select 1 from public.radar r where r.oportunidade_id = o.id and r.status not in ('novo','descartado'));
  get diagnostics n = row_count;
  return n;
end $$;
