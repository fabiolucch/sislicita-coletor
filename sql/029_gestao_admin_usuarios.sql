-- 029: painel administrativo multiusuário, suspensão reversível e auditoria de permissões.
-- Não apaga auth.users nem dados do cliente. A desativação pode ser revertida pelo administrador da plataforma.

alter table public.perfis_usuario
  add column if not exists bloqueado boolean not null default false,
  add column if not exists bloqueado_em timestamptz,
  add column if not exists bloqueado_por uuid references auth.users(id) on delete set null;

-- O usuário pode editar apenas os campos de perfil próprios; nunca pode liberar a própria conta.
revoke update on public.perfis_usuario from authenticated;
grant update (nome, telefone, org_ativa) on public.perfis_usuario to authenticated;

create table if not exists public.admin_usuarios_eventos (
  id bigint generated always as identity primary key,
  alvo_user_id uuid references auth.users(id) on delete set null,
  alvo_email text not null,
  organizacao_id uuid references public.organizacoes(id) on delete set null,
  acao text not null check (acao in ('nome_atualizado','acesso_alterado','vinculo_alterado','usuario_excluido')),
  dados jsonb not null default '{}'::jsonb,
  por uuid references auth.users(id) on delete set null,
  criado_em timestamptz not null default now()
);
alter table public.admin_usuarios_eventos enable row level security;
revoke all on public.admin_usuarios_eventos from public, anon, authenticated;
revoke all on sequence public.admin_usuarios_eventos_id_seq from public, anon, authenticated;

create or replace function public.usuario_ativo() returns boolean
language sql stable security definer set search_path = public, auth as $$
  select auth.uid() is not null and coalesce(
    (select not p.bloqueado from public.perfis_usuario p where p.user_id = auth.uid()), false);
$$;

create or replace function public.eh_admin_plataforma() returns boolean
language sql stable security definer set search_path = public as $$
  select public.usuario_ativo() and exists (
    select 1 from public.admins_plataforma where user_id = auth.uid());
$$;

create or replace function public.minhas_orgs() returns setof uuid
language sql stable security definer set search_path = public as $$
  select v.organizacao_id from public.vinculos_org v
  where public.usuario_ativo() and v.user_id = auth.uid() and v.situacao = 'ativo';
$$;

create or replace function public.papel_na_org(p uuid) returns text
language sql stable security definer set search_path = public as $$
  select v.papel from public.vinculos_org v
  where public.usuario_ativo() and v.user_id = auth.uid()
    and v.organizacao_id = p and v.situacao = 'ativo';
$$;

create or replace function public.org_atual() returns uuid
language sql stable security definer set search_path = public as $$
  select case when public.usuario_ativo() then coalesce(
    (select pu.org_ativa from public.perfis_usuario pu
      where pu.user_id = auth.uid() and pu.org_ativa in (select public.minhas_orgs())),
    (select v.organizacao_id from public.vinculos_org v
      where v.user_id = auth.uid() and v.situacao = 'ativo' order by v.criado_em limit 1))
  else null end;
$$;

create or replace function public.meu_papel() returns text
language sql stable security definer set search_path = public as $$
  select case when public.usuario_ativo() then coalesce(
    (select up.papel from public.usuarios_papeis up where up.user_id = auth.uid()),
    case when not exists (select 1 from public.usuarios_papeis) then 'admin' else 'editor' end)
  else 'leitor' end;
$$;
create or replace function public.pode_editar() returns boolean
language sql stable security definer set search_path = public as $$
  select public.usuario_ativo() and public.meu_papel() in ('admin','editor');
$$;

-- Uma conta suspensa não pode criar outra organização para contornar a suspensão.
create or replace function public.bloqueados_nao_criam_org() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.usuario_ativo() then
    raise exception 'esta conta esta suspensa; contate o administrador da plataforma';
  end if;
  return new;
end $$;
drop trigger if exists t_org_usuario_ativo on public.organizacoes;
create trigger t_org_usuario_ativo before insert on public.organizacoes
  for each row execute function public.bloqueados_nao_criam_org();

create or replace function public.admin_listar_usuarios()
returns table (
  user_id uuid, email text, nome text, criado_em timestamptz,
  ultimo_acesso timestamptz, bloqueado boolean, organizacoes jsonb
)
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if not public.eh_admin_plataforma() then raise exception 'apenas a plataforma lista usuarios'; end if;
  return query
  select u.id, u.email::text, pu.nome, u.created_at, u.last_sign_in_at,
    coalesce(pu.bloqueado,false),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',o.id,'nome',o.nome,'papel',v.papel,'situacao',v.situacao,
        'plano',a.plano,'plano_situacao',a.situacao,'teste_ate',a.teste_ate,
        'efetivo',public.plano_efetivo(o.id)
      ) order by o.nome)
      from public.vinculos_org v
      join public.organizacoes o on o.id=v.organizacao_id and o.tipo='cliente'
      left join public.assinaturas a on a.organizacao_id=o.id
      where v.user_id=u.id
    ),'[]'::jsonb)
  from auth.users u
  left join public.perfis_usuario pu on pu.user_id=u.id
  order by u.created_at desc;
end $$;

create or replace function public.admin_editar_nome_usuario(p_user uuid,p_nome text) returns void
language plpgsql security definer set search_path = public, auth as $$
declare em text;
begin
  if not public.eh_admin_plataforma() then raise exception 'apenas a plataforma edita usuarios'; end if;
  if nullif(trim(p_nome),'') is null or length(trim(p_nome))>120 then raise exception 'informe um nome de ate 120 caracteres'; end if;
  select email::text into em from auth.users where id=p_user;
  if em is null then raise exception 'usuario nao encontrado'; end if;
  insert into public.perfis_usuario(user_id,nome) values(p_user,trim(p_nome))
  on conflict(user_id) do update set nome=excluded.nome,atualizado_em=now();
  insert into public.admin_usuarios_eventos(alvo_user_id,alvo_email,acao,dados,por)
  values(p_user,em,'nome_atualizado',jsonb_build_object('nome',trim(p_nome)),auth.uid());
end $$;

create or replace function public.admin_definir_acesso_usuario(p_user uuid,p_ativo boolean) returns void
language plpgsql security definer set search_path = public, auth as $$
declare em text; ja_bloqueado boolean;
begin
  if not public.eh_admin_plataforma() then raise exception 'apenas a plataforma altera o acesso'; end if;
  if p_user=auth.uid() and not p_ativo then raise exception 'nao e permitido suspender a propria conta'; end if;
  select u.email::text,coalesce(p.bloqueado,false) into em,ja_bloqueado
    from auth.users u left join public.perfis_usuario p on p.user_id=u.id where u.id=p_user;
  if em is null then raise exception 'usuario nao encontrado'; end if;
  if not p_ativo and exists(select 1 from public.admins_plataforma where user_id=p_user)
     and not exists(select 1 from public.admins_plataforma a left join public.perfis_usuario p on p.user_id=a.user_id
       where a.user_id<>p_user and not coalesce(p.bloqueado,false)) then
    raise exception 'a plataforma precisa manter ao menos um administrador ativo';
  end if;
  insert into public.perfis_usuario(user_id,bloqueado,bloqueado_em,bloqueado_por)
  values(p_user,not p_ativo,case when p_ativo then null else now() end,case when p_ativo then null else auth.uid() end)
  on conflict(user_id) do update set bloqueado=not p_ativo,
    bloqueado_em=case when p_ativo then null else now() end,
    bloqueado_por=case when p_ativo then null else auth.uid() end,
    atualizado_em=now();
  if ja_bloqueado is distinct from (not p_ativo) then
    insert into public.admin_usuarios_eventos(alvo_user_id,alvo_email,acao,dados,por)
    values(p_user,em,'acesso_alterado',jsonb_build_object('ativo',p_ativo),auth.uid());
  end if;
end $$;

create or replace function public.admin_definir_vinculo_usuario(
  p_user uuid,p_org uuid,p_papel text,p_situacao text
) returns void
language plpgsql security definer set search_path = public, auth as $$
declare em text; atual public.vinculos_org%rowtype;
begin
  if not public.eh_admin_plataforma() then raise exception 'apenas a plataforma altera vinculos'; end if;
  if p_papel not in ('proprietario','admin','editor','leitor') then raise exception 'papel invalido'; end if;
  if p_situacao not in ('ativo','suspenso') then raise exception 'situacao invalida'; end if;
  if not exists(select 1 from public.organizacoes where id=p_org and tipo='cliente') then raise exception 'organizacao nao encontrada'; end if;
  if p_situacao='ativo' and exists(select 1 from public.perfis_usuario where user_id=p_user and bloqueado) then
    raise exception 'reative a conta antes de conceder acesso a uma organizacao';
  end if;
  select email::text into em from auth.users where id=p_user;
  if em is null then raise exception 'usuario nao encontrado'; end if;
  select * into atual from public.vinculos_org where user_id=p_user and organizacao_id=p_org for update;
  if found and atual.papel='proprietario' and (p_papel<>'proprietario' or p_situacao<>'ativo')
    and not exists(select 1 from public.vinculos_org v where v.organizacao_id=p_org and v.user_id<>p_user and v.papel='proprietario' and v.situacao='ativo') then
    raise exception 'transfira a propriedade antes de suspender ou rebaixar o ultimo proprietario';
  end if;
  insert into public.vinculos_org(user_id,organizacao_id,papel,situacao,convidado_por)
  values(p_user,p_org,p_papel,p_situacao,auth.uid())
  on conflict(user_id,organizacao_id) do update set papel=excluded.papel,situacao=excluded.situacao;
  insert into public.admin_usuarios_eventos(alvo_user_id,alvo_email,organizacao_id,acao,dados,por)
  values(p_user,em,p_org,'vinculo_alterado',jsonb_build_object('papel',p_papel,'situacao',p_situacao),auth.uid());
end $$;

-- Exclusão permanente protegida por confirmação e checagens de propriedade/acesso.
create or replace function public.admin_excluir_usuario(p_user uuid,p_confirmacao text) returns void
language plpgsql security definer set search_path = public, auth as $$
declare em text;
begin
  if not public.eh_admin_plataforma() then raise exception 'apenas a plataforma exclui usuarios'; end if;
  if p_user=auth.uid() then raise exception 'nao e permitido excluir a propria conta'; end if;
  select email::text into em from auth.users where id=p_user;
  if em is null then raise exception 'usuario nao encontrado'; end if;
  if lower(trim(coalesce(p_confirmacao,'')))<>lower(em) then raise exception 'a confirmacao deve repetir o e-mail exato do usuario'; end if;
  if exists(select 1 from public.admins_plataforma a left join public.perfis_usuario p on p.user_id=a.user_id
    where a.user_id=p_user and not coalesce(p.bloqueado,false))
    and not exists(select 1 from public.admins_plataforma a left join public.perfis_usuario p on p.user_id=a.user_id
      where a.user_id<>p_user and not coalesce(p.bloqueado,false)) then
    raise exception 'a plataforma precisa manter ao menos um administrador ativo';
  end if;
  if exists(select 1 from public.vinculos_org v where v.user_id=p_user and (
    (v.papel='proprietario' and not exists(select 1 from public.vinculos_org x
      where x.organizacao_id=v.organizacao_id and x.user_id<>p_user and x.papel='proprietario' and x.situacao='ativo'))
    or (v.situacao='ativo' and not exists(select 1 from public.vinculos_org x
      where x.organizacao_id=v.organizacao_id and x.user_id<>p_user and x.situacao='ativo')))) then
    raise exception 'transfira a propriedade e garanta outro membro ativo em cada organizacao antes da exclusao';
  end if;
  insert into public.admin_usuarios_eventos(alvo_user_id,alvo_email,acao,dados,por)
    values(p_user,em,'usuario_excluido',jsonb_build_object('email_confirmado',true),auth.uid());
  delete from auth.users where id=p_user;
end $$;

revoke execute on function public.usuario_ativo(),public.admin_listar_usuarios(),
  public.admin_editar_nome_usuario(uuid,text),public.admin_definir_acesso_usuario(uuid,boolean),
  public.admin_definir_vinculo_usuario(uuid,uuid,text,text),public.admin_excluir_usuario(uuid,text) from public,anon;
grant execute on function public.usuario_ativo() to authenticated,service_role;
grant execute on function public.admin_listar_usuarios(),
  public.admin_editar_nome_usuario(uuid,text),public.admin_definir_acesso_usuario(uuid,boolean),
  public.admin_definir_vinculo_usuario(uuid,uuid,text,text),public.admin_excluir_usuario(uuid,text) to authenticated,service_role;
