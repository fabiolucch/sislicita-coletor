-- Favoritos: editais que o usuario marcou com estrela (aba Favoritos no Radar).
create table if not exists public.favoritos (
  oportunidade_id bigint primary key references public.oportunidades(id) on delete cascade,
  criado_em timestamptz not null default now()
);
alter table public.favoritos enable row level security;
drop policy if exists favoritos_rw on public.favoritos;
create policy favoritos_rw on public.favoritos for all to authenticated using (true) with check (true);
grant select, insert, delete on public.favoritos to authenticated;
