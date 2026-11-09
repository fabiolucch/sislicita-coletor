-- 022: cadastro PF/PJ, convites com papéis, verificação de titularidade e fechamento da escrita nas tabelas compartilhadas.
-- O envio de e-mail (confirmação, recuperação de senha) é do Supabase Auth; aqui ficam as regras de negócio no banco.

-- A. tabelas compartilhadas (editais, PCA, catálogo, preços...) passam a ser SÓ LEITURA para usuários; escrita é do coletor (service_role)
do $h$
declare t text; pol record;
begin
  foreach t in array array['oportunidades','oportunidade_itens','pca_planos','pca_itens','catalogo','contratos_pncp','resultados_compras','vencedores','prospects','coleta_estado','coletas_log','ia_uso','edital_analise','edital_textos','edital_emb','usuarios_papeis'] loop
    continue when to_regclass('public.' || t) is null;
    continue when (select relkind from pg_class where oid = ('public.' || t)::regclass) <> 'r';
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', pol.policyname, t);
    end loop;
    execute format('alter table public.%I enable row level security', t);
    if t = 'usuarios_papeis' then
      execute format('create policy %I on public.%I for select to authenticated using (public.eh_admin_plataforma())', t || '_ler', t);
    else
      execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_ler', t);
    end if;
    execute format('revoke insert, update, delete on public.%I from authenticated, anon', t);
  end loop;
end $h$;

-- única escrita de usuário em tabela compartilhada: a análise de edital feita pela IA (só melhora, nunca troca análise do edital por uma do objeto)
create or replace function public.salvar_analise(p_op bigint, p_dados jsonb, p_risco int, p_resumo text, p_fonte text) returns void
language plpgsql security definer set search_path = public as $$
declare ex text;
begin
  if auth.uid() is null or public.org_atual() is null then raise exception 'sem organizacao ativa'; end if;
  if not exists (select 1 from oportunidades where id = p_op) then raise exception 'edital nao encontrado'; end if;
  if p_fonte not in ('edital','objeto') then raise exception 'fonte invalida'; end if;
  select fonte into ex from edital_analise where oportunidade_id = p_op;
  if ex = 'edital' and p_fonte <> 'edital' then return; end if;
  insert into edital_analise (oportunidade_id, dados, risco, resumo, fonte, analisado_em)
  values (p_op, p_dados, least(greatest(coalesce(p_risco, 0), 0), 100), left(coalesce(p_resumo, ''), 700), p_fonte, now())
  on conflict (oportunidade_id) do update set dados = excluded.dados, risco = excluded.risco, resumo = excluded.resumo, fonte = excluded.fonte, analisado_em = now();
end $$;
revoke execute on function public.salvar_analise(bigint, jsonb, int, text, text) from public, anon;
grant execute on function public.salvar_analise(bigint, jsonb, int, text, text) to authenticated;

-- vetor do edital (gerado pelo Worker com a chave do usuário): só insere se ainda não existir
create or replace function public.salvar_vetor_edital(p_op bigint, p_emb text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if auth.uid() is null or public.org_atual() is null then raise exception 'sem organizacao ativa'; end if;
  if not exists (select 1 from oportunidades where id = p_op) then raise exception 'edital nao encontrado'; end if;
  insert into edital_emb (oportunidade_id, emb) values (p_op, p_emb::extensions.halfvec(768)) on conflict (oportunidade_id) do nothing;
end $$;
revoke execute on function public.salvar_vetor_edital(bigint, text) from public, anon;
grant execute on function public.salvar_vetor_edital(bigint, text) to authenticated;

-- B. aceite de termos (LGPD) e convites
create table if not exists public.aceites_termos (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  versao text not null, em timestamptz not null default now()
);
create table if not exists public.convites (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references public.organizacoes(id) on delete cascade,
  email text not null check (email = lower(email)),
  papel text not null check (papel in ('admin','editor','leitor')),
  token_hash text not null unique,
  criado_por uuid references auth.users(id) on delete set null,
  criado_em timestamptz not null default now(),
  expira_em timestamptz not null default now() + interval '7 days',
  aceito_em timestamptz, aceito_por uuid references auth.users(id) on delete set null,
  revogado_em timestamptz
);
create index if not exists convites_org on public.convites (organizacao_id);
alter table public.aceites_termos enable row level security;
alter table public.convites enable row level security;
drop policy if exists aceites_ler on public.aceites_termos;
create policy aceites_ler on public.aceites_termos for select to authenticated using (user_id = auth.uid() or public.eh_admin_plataforma());
drop policy if exists convites_ler on public.convites;
create policy convites_ler on public.convites for select to authenticated using (public.pode_admin_org(organizacao_id) or public.eh_admin_plataforma());
revoke all on public.aceites_termos, public.convites from anon;
grant select on public.aceites_termos, public.convites to authenticated;

-- C. cadastro de conta (depois de criar o login e confirmar o e-mail)
create or replace function public.cadastrar_conta(p_tipo text, p_nome text, p_documento text, p_razao text default null, p_telefone text default null, p_termos text default null) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare o uuid; doc text; confirmado timestamptz;
begin
  if auth.uid() is null then raise exception 'nao autenticado'; end if;
  select email_confirmed_at into confirmado from auth.users where id = auth.uid();
  if confirmado is null then raise exception 'confirme o e-mail antes de cadastrar a conta'; end if;
  if p_tipo not in ('pf','pj') then raise exception 'tipo invalido'; end if;
  if coalesce(trim(p_nome), '') = '' then raise exception 'informe o nome'; end if;
  if coalesce(p_termos, '') = '' then raise exception 'aceite os termos de uso e a politica de privacidade'; end if;
  if (select count(*) from organizacoes where criado_por = auth.uid()) >= 3 then raise exception 'limite de contas por usuario atingido'; end if;
  if p_tipo = 'pj' then
    doc := upper(regexp_replace(coalesce(p_documento, ''), '[^0-9A-Za-z]', '', 'g'));
    if not public.cnpj_valido(doc) then raise exception 'CNPJ invalido'; end if;
    if exists (select 1 from pessoas_juridicas where cnpj = doc and verificada_em is not null) then
      raise exception 'este CNPJ ja tem responsavel verificado; peca um convite a ele';
    end if;
  else
    doc := regexp_replace(coalesce(p_documento, ''), '\D', '', 'g');
    if not public.cpf_valido(doc) then raise exception 'CPF invalido'; end if;
    if exists (select 1 from pessoas_fisicas where cpf = doc and verificada_em is not null) then
      raise exception 'este CPF ja tem conta verificada';
    end if;
  end if;
  insert into organizacoes (nome, tipo, criado_por) values (trim(p_nome), 'cliente', auth.uid()) returning id into o;
  insert into vinculos_org (user_id, organizacao_id, papel) values (auth.uid(), o, 'proprietario');
  if p_tipo = 'pj' then
    insert into pessoas_juridicas (organizacao_id, cnpj, razao_social, nome_fantasia, telefone, propria) values (o, doc, coalesce(nullif(trim(p_razao), ''), trim(p_nome)), trim(p_nome), p_telefone, true);
  else
    insert into pessoas_fisicas (organizacao_id, cpf, nome, telefone) values (o, doc, trim(p_nome), p_telefone);
  end if;
  insert into aceites_termos (user_id, versao) values (auth.uid(), p_termos);
  update perfis_usuario set org_ativa = o, telefone = coalesce(telefone, p_telefone), atualizado_em = now() where user_id = auth.uid();
  return o;
end $$;
revoke execute on function public.cadastrar_conta(text, text, text, text, text, text) from public, anon;
grant execute on function public.cadastrar_conta(text, text, text, text, text, text) to authenticated;

-- D. convites e gestão de membros (o link do convite é entregue ao convidador; o e-mail automático entra quando houver SMTP)
create or replace function public.criar_convite(p_org uuid, p_email text, p_papel text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare tk text; em text := lower(trim(p_email));
begin
  if not public.pode_admin_org(p_org) then raise exception 'apenas administradores da organizacao convidam'; end if;
  if p_papel not in ('admin','editor','leitor') then raise exception 'papel invalido'; end if;
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'e-mail invalido'; end if;
  if exists (select 1 from vinculos_org v join auth.users u on u.id = v.user_id where v.organizacao_id = p_org and lower(u.email) = em and v.situacao = 'ativo') then
    raise exception 'essa pessoa ja faz parte da organizacao';
  end if;
  if (select count(*) from convites where organizacao_id = p_org and aceito_em is null and revogado_em is null and expira_em > now()) >= 50 then
    raise exception 'convites pendentes demais; revogue alguns';
  end if;
  update convites set revogado_em = now() where organizacao_id = p_org and email = em and aceito_em is null and revogado_em is null;
  tk := encode(extensions.gen_random_bytes(24), 'hex');
  insert into convites (organizacao_id, email, papel, token_hash, criado_por) values (p_org, em, p_papel, encode(extensions.digest(tk, 'sha256'), 'hex'), auth.uid());
  return tk;
end $$;

create or replace function public.aceitar_convite(p_token text) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare c convites; em text; confirmado timestamptz;
begin
  if auth.uid() is null then raise exception 'nao autenticado'; end if;
  select lower(email), email_confirmed_at into em, confirmado from auth.users where id = auth.uid();
  if confirmado is null then raise exception 'confirme o e-mail antes de aceitar o convite'; end if;
  select * into c from convites where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex') for update;
  if not found or c.aceito_em is not null or c.revogado_em is not null or c.expira_em < now() then raise exception 'convite invalido ou expirado'; end if;
  if c.email <> em then raise exception 'este convite foi enviado para outro e-mail'; end if;
  insert into vinculos_org (user_id, organizacao_id, papel, situacao, convidado_por) values (auth.uid(), c.organizacao_id, c.papel, 'ativo', c.criado_por)
  on conflict (user_id, organizacao_id) do update set papel = case when vinculos_org.papel = 'proprietario' then 'proprietario' else excluded.papel end, situacao = 'ativo';
  update convites set aceito_em = now(), aceito_por = auth.uid() where id = c.id;
  update perfis_usuario set org_ativa = c.organizacao_id, atualizado_em = now() where user_id = auth.uid();
  return c.organizacao_id;
end $$;

create or replace function public.revogar_convite(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  update convites set revogado_em = now() where id = p_id and aceito_em is null and public.pode_admin_org(organizacao_id);
  if not found then raise exception 'convite nao encontrado'; end if;
end $$;

create or replace function public.alterar_papel_membro(p_org uuid, p_user uuid, p_papel text) returns void language plpgsql security definer set search_path = public as $$
declare atual text;
begin
  if not public.pode_admin_org(p_org) then raise exception 'apenas administradores'; end if;
  if p_papel not in ('proprietario','admin','editor','leitor') then raise exception 'papel invalido'; end if;
  select papel into atual from vinculos_org where user_id = p_user and organizacao_id = p_org;
  if atual is null then raise exception 'membro nao encontrado'; end if;
  if (atual = 'proprietario' or p_papel = 'proprietario') and public.papel_na_org(p_org) <> 'proprietario' then raise exception 'apenas o proprietario altera proprietarios'; end if;
  if atual = 'proprietario' and p_papel <> 'proprietario' and (select count(*) from vinculos_org where organizacao_id = p_org and papel = 'proprietario' and situacao = 'ativo') <= 1 then
    raise exception 'a organizacao precisa de ao menos um proprietario';
  end if;
  update vinculos_org set papel = p_papel where user_id = p_user and organizacao_id = p_org;
end $$;

create or replace function public.remover_membro(p_org uuid, p_user uuid) returns void language plpgsql security definer set search_path = public as $$
declare atual text;
begin
  if p_user <> auth.uid() and not public.pode_admin_org(p_org) then raise exception 'apenas administradores removem outros membros'; end if;
  select papel into atual from vinculos_org where user_id = p_user and organizacao_id = p_org;
  if atual is null then raise exception 'membro nao encontrado'; end if;
  if atual = 'proprietario' and (select count(*) from vinculos_org where organizacao_id = p_org and papel = 'proprietario' and situacao = 'ativo') <= 1 then
    raise exception 'a organizacao precisa de ao menos um proprietario';
  end if;
  if atual = 'proprietario' and p_user <> auth.uid() and public.papel_na_org(p_org) <> 'proprietario' then raise exception 'apenas o proprietario remove proprietarios'; end if;
  delete from vinculos_org where user_id = p_user and organizacao_id = p_org;
  update perfis_usuario set org_ativa = null where user_id = p_user and org_ativa = p_org;
end $$;

grant execute on function public.criar_convite(uuid, text, text), public.aceitar_convite(text), public.revogar_convite(uuid), public.alterar_papel_membro(uuid, uuid, text), public.remover_membro(uuid, uuid) to authenticated;
revoke execute on function public.criar_convite(uuid, text, text), public.aceitar_convite(text), public.revogar_convite(uuid), public.alterar_papel_membro(uuid, uuid, text), public.remover_membro(uuid, uuid) from public, anon;

-- E. verificação de titularidade (quem administra o cadastro de uma empresa/pessoa precisa ser comprovado pela plataforma)
create table if not exists public.verificacoes (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references public.organizacoes(id) on delete cascade,
  pessoa_tipo text not null check (pessoa_tipo in ('pj','pf')),
  pessoa_id uuid not null,
  solicitante uuid references auth.users(id) on delete set null,
  vinculo text not null check (vinculo in ('titular','socio_administrador','procurador','contador_assessor')),
  observacao text, documento_path text,
  situacao text not null default 'pendente' check (situacao in ('pendente','aprovada','recusada')),
  motivo_recusa text, decidido_por uuid references auth.users(id) on delete set null, decidido_em timestamptz,
  criado_em timestamptz not null default now()
);
create index if not exists verificacoes_org on public.verificacoes (organizacao_id);
alter table public.verificacoes enable row level security;
drop policy if exists verif_ler on public.verificacoes;
create policy verif_ler on public.verificacoes for select to authenticated using (public.pode_ler_org(organizacao_id));
revoke all on public.verificacoes from anon;
grant select on public.verificacoes to authenticated;

create or replace function public.solicitar_verificacao(p_tipo text, p_pessoa uuid, p_vinculo text, p_obs text, p_path text) returns uuid
language plpgsql security definer set search_path = public as $$
declare org uuid; v uuid;
begin
  if p_tipo = 'pj' then select organizacao_id into org from pessoas_juridicas where id = p_pessoa;
  elsif p_tipo = 'pf' then select organizacao_id into org from pessoas_fisicas where id = p_pessoa;
  else raise exception 'tipo invalido'; end if;
  if org is null then raise exception 'cadastro nao encontrado'; end if;
  if not public.pode_admin_org(org) then raise exception 'apenas administradores da organizacao solicitam verificacao'; end if;
  if p_path is not null and split_part(p_path, '/', 1) <> org::text then raise exception 'arquivo fora da pasta da organizacao'; end if;
  if exists (select 1 from verificacoes where pessoa_tipo = p_tipo and pessoa_id = p_pessoa and situacao = 'pendente') then raise exception 'ja existe uma verificacao pendente'; end if;
  insert into verificacoes (organizacao_id, pessoa_tipo, pessoa_id, solicitante, vinculo, observacao, documento_path)
  values (org, p_tipo, p_pessoa, auth.uid(), p_vinculo, left(p_obs, 1000), p_path) returning id into v;
  return v;
end $$;

create or replace function public.fila_verificacao() returns table (id uuid, organizacao text, pessoa_tipo text, pessoa text, documento text, vinculo text, observacao text, documento_path text, solicitante_email text, criado_em timestamptz)
language sql stable security definer set search_path = public as $$
  select v.id, o.nome, v.pessoa_tipo,
    case v.pessoa_tipo when 'pj' then (select razao_social from pessoas_juridicas where id = v.pessoa_id) else (select nome from pessoas_fisicas where id = v.pessoa_id) end,
    case v.pessoa_tipo when 'pj' then (select cnpj from pessoas_juridicas where id = v.pessoa_id) else (select cpf from pessoas_fisicas where id = v.pessoa_id) end,
    v.vinculo, v.observacao, v.documento_path, u.email::text, v.criado_em
  from verificacoes v join organizacoes o on o.id = v.organizacao_id left join auth.users u on u.id = v.solicitante
  where v.situacao = 'pendente' and public.eh_admin_plataforma() order by v.criado_em;
$$;

create or replace function public.decidir_verificacao(p_id uuid, p_aprovar boolean, p_motivo text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v verificacoes;
begin
  if not public.eh_admin_plataforma() then raise exception 'apenas a plataforma decide verificacoes'; end if;
  select * into v from verificacoes where id = p_id and situacao = 'pendente' for update;
  if not found then raise exception 'verificacao nao encontrada ou ja decidida'; end if;
  update verificacoes set situacao = case when p_aprovar then 'aprovada' else 'recusada' end, motivo_recusa = case when p_aprovar then null else left(p_motivo, 500) end, decidido_por = auth.uid(), decidido_em = now() where id = p_id;
  if p_aprovar then
    if v.pessoa_tipo = 'pj' then update pessoas_juridicas set verificada_em = now() where id = v.pessoa_id;
    else update pessoas_fisicas set verificada_em = now() where id = v.pessoa_id; end if;
  end if;
end $$;
grant execute on function public.solicitar_verificacao(text, uuid, text, text, text), public.fila_verificacao(), public.decidir_verificacao(uuid, boolean, text) to authenticated;
revoke execute on function public.solicitar_verificacao(text, uuid, text, text, text), public.fila_verificacao(), public.decidir_verificacao(uuid, boolean, text) from public, anon;

-- documentos da verificação: pasta privada, uma subpasta por organização
insert into storage.buckets (id, name, public) values ('verificacoes', 'verificacoes', false) on conflict (id) do nothing;
drop policy if exists verif_arq_ins on storage.objects;
create policy verif_arq_ins on storage.objects for insert to authenticated
  with check (bucket_id = 'verificacoes' and public.pode_admin_org(((storage.foldername(name))[1])::uuid));
drop policy if exists verif_arq_ler on storage.objects;
create policy verif_arq_ler on storage.objects for select to authenticated
  using (bucket_id = 'verificacoes' and (public.pode_admin_org(((storage.foldername(name))[1])::uuid) or public.eh_admin_plataforma()));

-- uma pessoa jurídica/física verificada é única na plataforma (impede duas organizações donas do mesmo CNPJ/CPF)
create unique index if not exists pj_cnpj_verificado on public.pessoas_juridicas (cnpj) where verificada_em is not null;
create unique index if not exists pf_cpf_verificado on public.pessoas_fisicas (cpf) where verificada_em is not null;

grant execute on function public.eh_admin_plataforma(), public.org_atual() to authenticated;
