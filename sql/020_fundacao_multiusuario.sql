-- 020: fundação multiusuário (passo 1). Só estrutura nova + funções de acesso; nada existente é alterado.
-- Princípios: ids uuid estáveis, toda regra de acesso no banco (RLS/RPC), nada depende do site: o app futuro usa o mesmo backend.
-- Conceitos: organização = conta que contrata (consultoria ou cliente); usuário entra por vínculo com papel;
-- pessoa jurídica e pessoa física atendidas ficam em tabelas separadas, sempre dentro de uma organização.

create table if not exists public.organizacoes (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (length(trim(nome)) >= 2),
  tipo text not null default 'cliente' check (tipo in ('plataforma','cliente')),
  situacao text not null default 'ativa' check (situacao in ('ativa','suspensa','encerrada')),
  criado_por uuid references auth.users(id) on delete set null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

create table if not exists public.perfis_usuario (
  user_id uuid primary key references auth.users(id) on delete cascade,
  nome text, telefone text,
  org_ativa uuid references public.organizacoes(id) on delete set null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

create table if not exists public.vinculos_org (
  user_id uuid not null references auth.users(id) on delete cascade,
  organizacao_id uuid not null references public.organizacoes(id) on delete cascade,
  papel text not null default 'editor' check (papel in ('proprietario','admin','editor','leitor')),
  situacao text not null default 'ativo' check (situacao in ('ativo','convidado','pendente_verificacao','suspenso')),
  convidado_por uuid references auth.users(id) on delete set null,
  criado_em timestamptz not null default now(),
  primary key (user_id, organizacao_id)
);
create index if not exists vinculos_org_org on public.vinculos_org (organizacao_id);

create table if not exists public.admins_plataforma (
  user_id uuid primary key references auth.users(id) on delete cascade,
  criado_em timestamptz not null default now()
);

-- validação de documentos (CNPJ já aceita o formato alfanumérico, vigente desde julho de 2026)
create or replace function public.cnpj_valido(p text) returns boolean language plpgsql immutable as $$
declare d text := upper(regexp_replace(coalesce(p,''), '[^0-9A-Za-z]', '', 'g'));
  w1 int[] := '{5,4,3,2,9,8,7,6,5,4,3,2}'; w2 int[] := '{6,5,4,3,2,9,8,7,6,5,4,3,2}'; s int; r int; i int;
begin
  if d !~ '^[0-9A-Z]{12}[0-9]{2}$' or d ~ '^(.)\1{13}$' then return false; end if;
  s := 0; for i in 1..12 loop s := s + (ascii(substr(d,i,1)) - 48) * w1[i]; end loop;
  r := s % 11; r := case when r < 2 then 0 else 11 - r end;
  if r <> substr(d,13,1)::int then return false; end if;
  s := 0; for i in 1..13 loop s := s + (ascii(substr(d,i,1)) - 48) * w2[i]; end loop;
  r := s % 11; r := case when r < 2 then 0 else 11 - r end;
  return r = substr(d,14,1)::int;
end $$;

create or replace function public.cpf_valido(p text) returns boolean language plpgsql immutable as $$
declare d text := regexp_replace(coalesce(p,''), '\D', '', 'g'); s int; r int; i int;
begin
  if length(d) <> 11 or d ~ '^(\d)\1{10}$' then return false; end if;
  s := 0; for i in 1..9 loop s := s + substr(d,i,1)::int * (11 - i); end loop;
  r := (s * 10) % 11; if r = 10 then r := 0; end if;
  if r <> substr(d,10,1)::int then return false; end if;
  s := 0; for i in 1..10 loop s := s + substr(d,i,1)::int * (12 - i); end loop;
  r := (s * 10) % 11; if r = 10 then r := 0; end if;
  return r = substr(d,11,1)::int;
end $$;

-- pessoa jurídica e pessoa física atendidas (separadas)
create table if not exists public.pessoas_juridicas (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references public.organizacoes(id) on delete cascade,
  cnpj text not null check (public.cnpj_valido(cnpj)),
  razao_social text not null, nome_fantasia text, porte text, cnae_principal text,
  uf text, municipio text, email text, telefone text,
  propria boolean not null default false,       -- a própria empresa da organização (vs. cliente atendido)
  verificada_em timestamptz,                     -- só a plataforma preenche (passo 3)
  criado_em timestamptz not null default now(), atualizado_em timestamptz not null default now(),
  unique (organizacao_id, cnpj)
);
create table if not exists public.pessoas_fisicas (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references public.organizacoes(id) on delete cascade,
  cpf text not null check (public.cpf_valido(cpf)),
  nome text not null, uf text, municipio text, email text, telefone text,
  verificada_em timestamptz,
  criado_em timestamptz not null default now(), atualizado_em timestamptz not null default now(),
  unique (organizacao_id, cpf)
);
create index if not exists pj_org on public.pessoas_juridicas (organizacao_id);
create index if not exists pf_org on public.pessoas_fisicas (organizacao_id);

-- funções de acesso (usadas por RLS e pela API; valem igual para site e app)
create or replace function public.eh_admin_plataforma() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from admins_plataforma where user_id = auth.uid());
$$;
create or replace function public.minhas_orgs() returns setof uuid language sql stable security definer set search_path = public as $$
  select organizacao_id from vinculos_org where user_id = auth.uid() and situacao = 'ativo';
$$;
create or replace function public.papel_na_org(p uuid) returns text language sql stable security definer set search_path = public as $$
  select papel from vinculos_org where user_id = auth.uid() and organizacao_id = p and situacao = 'ativo';
$$;
create or replace function public.pode_ler_org(p uuid) returns boolean language sql stable security definer set search_path = public as $$
  select public.papel_na_org(p) is not null or public.eh_admin_plataforma();
$$;
create or replace function public.pode_editar_org(p uuid) returns boolean language sql stable security definer set search_path = public as $$
  select public.papel_na_org(p) in ('proprietario','admin','editor');
$$;
create or replace function public.pode_admin_org(p uuid) returns boolean language sql stable security definer set search_path = public as $$
  select public.papel_na_org(p) in ('proprietario','admin');
$$;
create or replace function public.org_atual() returns uuid language sql stable security definer set search_path = public as $$
  select coalesce(
    (select pu.org_ativa from perfis_usuario pu where pu.user_id = auth.uid() and pu.org_ativa in (select public.minhas_orgs())),
    (select organizacao_id from vinculos_org where user_id = auth.uid() and situacao = 'ativo' order by criado_em limit 1));
$$;

-- cria a organização e torna quem chamou o proprietário (o passo 3 acrescenta e-mail confirmado e verificação)
create or replace function public.criar_organizacao(p_nome text, p_tipo text default 'cliente') returns uuid
language plpgsql security definer set search_path = public as $$
declare o uuid;
begin
  if auth.uid() is null then raise exception 'nao autenticado'; end if;
  if p_tipo = 'plataforma' and not public.eh_admin_plataforma() then raise exception 'apenas a plataforma cria organizacao desse tipo'; end if;
  insert into organizacoes (nome, tipo, criado_por) values (trim(p_nome), coalesce(p_tipo,'cliente'), auth.uid()) returning id into o;
  insert into vinculos_org (user_id, organizacao_id, papel) values (auth.uid(), o, 'proprietario');
  update perfis_usuario set org_ativa = coalesce(org_ativa, o) where user_id = auth.uid();
  return o;
end $$;

create or replace function public.trocar_org_ativa(p uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  if p not in (select public.minhas_orgs()) then raise exception 'sem vinculo ativo com essa organizacao'; end if;
  update perfis_usuario set org_ativa = p, atualizado_em = now() where user_id = auth.uid();
end $$;

create or replace function public.listar_membros(p_org uuid) returns table (user_id uuid, email text, nome text, papel text, situacao text, desde timestamptz)
language sql stable security definer set search_path = public as $$
  select v.user_id, u.email::text, pu.nome, v.papel, v.situacao, v.criado_em
  from vinculos_org v join auth.users u on u.id = v.user_id left join perfis_usuario pu on pu.user_id = v.user_id
  where v.organizacao_id = p_org and (public.pode_admin_org(p_org) or public.eh_admin_plataforma())
  order by v.criado_em;
$$;

-- todo usuário novo ganha um perfil
create or replace function public.novo_usuario() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into perfis_usuario (user_id, nome) values (new.id, nullif(trim(coalesce(new.raw_user_meta_data->>'nome','')), '')) on conflict do nothing;
  return new;
end $$;
drop trigger if exists t_novo_usuario on auth.users;
create trigger t_novo_usuario after insert on auth.users for each row execute function public.novo_usuario();

-- só a plataforma pode marcar verificada_em
create or replace function public.proteger_verificada() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.verificada_em is not null and not public.eh_admin_plataforma() then new.verificada_em := null; end if;
  elsif new.verificada_em is distinct from old.verificada_em and not public.eh_admin_plataforma() then
    new.verificada_em := old.verificada_em;
  end if;
  new.atualizado_em := now();
  return new;
end $$;
drop trigger if exists t_pj_verificada on public.pessoas_juridicas;
create trigger t_pj_verificada before insert or update on public.pessoas_juridicas for each row execute function public.proteger_verificada();
drop trigger if exists t_pf_verificada on public.pessoas_fisicas;
create trigger t_pf_verificada before insert or update on public.pessoas_fisicas for each row execute function public.proteger_verificada();

-- RLS
alter table public.organizacoes enable row level security;
alter table public.perfis_usuario enable row level security;
alter table public.vinculos_org enable row level security;
alter table public.admins_plataforma enable row level security;
alter table public.pessoas_juridicas enable row level security;
alter table public.pessoas_fisicas enable row level security;

drop policy if exists org_ler on public.organizacoes;
create policy org_ler on public.organizacoes for select to authenticated using (public.pode_ler_org(id));
drop policy if exists org_editar on public.organizacoes;
create policy org_editar on public.organizacoes for update to authenticated using (public.pode_admin_org(id)) with check (public.pode_admin_org(id));

drop policy if exists pu_ler on public.perfis_usuario;
create policy pu_ler on public.perfis_usuario for select to authenticated using (user_id = auth.uid() or public.eh_admin_plataforma());
drop policy if exists pu_editar on public.perfis_usuario;
create policy pu_editar on public.perfis_usuario for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists vo_ler on public.vinculos_org;
create policy vo_ler on public.vinculos_org for select to authenticated using (user_id = auth.uid() or public.pode_admin_org(organizacao_id) or public.eh_admin_plataforma());
-- sem política de escrita: vínculos só mudam por funções (convite, papéis) nos próximos passos

drop policy if exists ap_ler on public.admins_plataforma;
create policy ap_ler on public.admins_plataforma for select to authenticated using (user_id = auth.uid());

drop policy if exists pj_ler on public.pessoas_juridicas;
create policy pj_ler on public.pessoas_juridicas for select to authenticated using (public.pode_ler_org(organizacao_id));
drop policy if exists pj_esc on public.pessoas_juridicas;
create policy pj_esc on public.pessoas_juridicas for all to authenticated using (public.pode_editar_org(organizacao_id)) with check (public.pode_editar_org(organizacao_id));
drop policy if exists pf_ler on public.pessoas_fisicas;
create policy pf_ler on public.pessoas_fisicas for select to authenticated using (public.pode_ler_org(organizacao_id));
drop policy if exists pf_esc on public.pessoas_fisicas;
create policy pf_esc on public.pessoas_fisicas for all to authenticated using (public.pode_editar_org(organizacao_id)) with check (public.pode_editar_org(organizacao_id));

revoke all on public.organizacoes, public.perfis_usuario, public.vinculos_org, public.admins_plataforma, public.pessoas_juridicas, public.pessoas_fisicas from anon;
grant select, update on public.organizacoes, public.perfis_usuario to authenticated;
grant select on public.vinculos_org, public.admins_plataforma to authenticated;
grant select, insert, update, delete on public.pessoas_juridicas, public.pessoas_fisicas to authenticated;
revoke execute on function public.criar_organizacao(text,text), public.trocar_org_ativa(uuid), public.listar_membros(uuid) from public, anon;
grant execute on function public.criar_organizacao(text,text), public.trocar_org_ativa(uuid), public.listar_membros(uuid), public.minhas_orgs(), public.papel_na_org(uuid), public.pode_ler_org(uuid), public.pode_editar_org(uuid), public.pode_admin_org(uuid), public.org_atual(), public.eh_admin_plataforma() to authenticated;

-- migração dos dados atuais: uma organização da plataforma, usuários existentes vinculados conforme o papel de hoje
do $mig$
declare o uuid; primeiro uuid;
begin
  if exists (select 1 from organizacoes where tipo = 'plataforma') then return; end if;
  insert into perfis_usuario (user_id) select id from auth.users on conflict do nothing;
  insert into organizacoes (nome, tipo) values ('Organização principal', 'plataforma') returning id into o;
  insert into vinculos_org (user_id, organizacao_id, papel)
  select u.id, o, coalesce(p.papel, case when not exists (select 1 from usuarios_papeis) then 'admin' else 'editor' end)
  from auth.users u left join usuarios_papeis p on p.user_id = u.id;
  select user_id into primeiro from vinculos_org where organizacao_id = o and papel = 'admin' order by criado_em, user_id limit 1;
  if primeiro is not null then update vinculos_org set papel = 'proprietario' where user_id = primeiro and organizacao_id = o; end if;
  insert into admins_plataforma (user_id) select user_id from vinculos_org where organizacao_id = o and papel in ('admin','proprietario') on conflict do nothing;
  update perfis_usuario set org_ativa = o where org_ativa is null;
  -- empresas já cadastradas com CNPJ válido passam a ser pessoas jurídicas da organização principal
  insert into pessoas_juridicas (organizacao_id, cnpj, razao_social, email, telefone, uf, propria)
  select o, upper(regexp_replace(e.cnpj, '[^0-9A-Za-z]', '', 'g')), e.nome, e.email, e.telefone, e.uf, coalesce(e.propria, false)
  from empresas e where public.cnpj_valido(e.cnpj)
  on conflict (organizacao_id, cnpj) do nothing;
end $mig$;
