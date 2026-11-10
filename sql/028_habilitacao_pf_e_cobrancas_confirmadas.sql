-- 028: amplia o cadastro de habilitação para PF e exige confirmação administrativa
-- antes de transformar dados de resultado/contrato/empenho em cobranças.

-- Habilitação: tornar o cadastro um registro por pessoa jurídica ou física.
alter table public.hab_empresas add column if not exists id uuid default gen_random_uuid();
update public.hab_empresas set id = gen_random_uuid() where id is null;
alter table public.hab_empresas alter column id set default gen_random_uuid();
alter table public.hab_empresas alter column id set not null;
alter table public.hab_empresas drop constraint if exists hab_empresas_pkey;
alter table public.hab_empresas add constraint hab_empresas_pkey primary key (id);
alter table public.hab_empresas alter column pessoa_juridica_id drop not null;
alter table public.hab_empresas add column if not exists pessoa_fisica_id uuid references public.pessoas_fisicas(id) on delete cascade;
alter table public.hab_empresas drop constraint if exists hab_empresas_natureza_check;
alter table public.hab_empresas add constraint hab_empresas_natureza_check
  check (natureza in ('mei','ei','ltda','sa','coop','ss','assoc','pf'));
alter table public.hab_empresas drop constraint if exists hab_empresas_um_titular;
alter table public.hab_empresas add constraint hab_empresas_um_titular
  check (num_nonnulls(pessoa_juridica_id, pessoa_fisica_id) = 1);
create unique index if not exists hab_empresa_pj_unica on public.hab_empresas (pessoa_juridica_id) where pessoa_juridica_id is not null;
create unique index if not exists hab_empresa_pf_unica on public.hab_empresas (pessoa_fisica_id) where pessoa_fisica_id is not null;

alter table public.hab_documentos alter column pessoa_juridica_id drop not null;
alter table public.hab_documentos add column if not exists pessoa_fisica_id uuid references public.pessoas_fisicas(id) on delete cascade;
alter table public.hab_documentos drop constraint if exists hab_documentos_um_titular;
alter table public.hab_documentos add constraint hab_documentos_um_titular
  check (num_nonnulls(pessoa_juridica_id, pessoa_fisica_id) = 1);
create index if not exists hab_doc_pf on public.hab_documentos (pessoa_fisica_id, codigo, criado_em desc) where pessoa_fisica_id is not null;

drop policy if exists hab_empresas_esc on public.hab_empresas;
create policy hab_empresas_esc on public.hab_empresas for all to authenticated
  using (public.pode_editar_org(organizacao_id))
  with check (public.pode_editar_org(organizacao_id) and (
    (pessoa_juridica_id is not null and organizacao_id = (select organizacao_id from public.pessoas_juridicas where id = pessoa_juridica_id)) or
    (pessoa_fisica_id is not null and organizacao_id = (select organizacao_id from public.pessoas_fisicas where id = pessoa_fisica_id))
  ));
drop policy if exists hab_documentos_esc on public.hab_documentos;
create policy hab_documentos_esc on public.hab_documentos for all to authenticated
  using (public.pode_editar_org(organizacao_id))
  with check (public.pode_editar_org(organizacao_id) and (
    (pessoa_juridica_id is not null and organizacao_id = (select organizacao_id from public.pessoas_juridicas where id = pessoa_juridica_id)) or
    (pessoa_fisica_id is not null and organizacao_id = (select organizacao_id from public.pessoas_fisicas where id = pessoa_fisica_id))
  ));

-- A pessoa física participa do SICAF com CPF; o restante da lista depende do edital.
update public.hab_catalogo set naturezas = array_remove(naturezas, 'pf') where codigo = 'identidade';
alter table public.hab_catalogo add column if not exists obrigatorio_pf boolean;
update public.hab_catalogo set obrigatorio_pf = false where 'pf' = any(naturezas);
insert into public.hab_catalogo
  (codigo, nome, grupo, nivel_sicaf, base_legal, naturezas, obrigatorio, validade_dias, link, como_obter, sicaf_automatico, ordem)
values
  ('pf_sicaf_nivel1', 'Comprovante de credenciamento da pessoa física no SICAF (Nível I)',
   'credenciamento', 1, 'Perguntas frequentes oficiais do Compras.gov.br', '{pf}', true, null,
   'https://www.gov.br/compras/pt-br/acesso-a-informacao/perguntas-frequentes/perguntas-frequentes/pregao-eletronico-fornecedor',
   'O fornecedor pessoa física usa o CPF e precisa estar credenciado no Nível I para participar nos sistemas que utilizam o SICAF. Confirme sempre as condições do edital.', false, 10)
on conflict (codigo) do update set nome=excluded.nome, grupo=excluded.grupo, nivel_sicaf=excluded.nivel_sicaf,
  base_legal=excluded.base_legal, naturezas=excluded.naturezas, obrigatorio=excluded.obrigatorio,
  validade_dias=excluded.validade_dias, link=excluded.link, como_obter=excluded.como_obter,
  sicaf_automatico=excluded.sicaf_automatico, ordem=excluded.ordem;
update public.hab_catalogo set obrigatorio_pf = true where codigo = 'pf_sicaf_nivel1';

drop function if exists public.hab_vencimentos(int);
create function public.hab_vencimentos(p_dias int default 15)
returns table (pessoa_juridica_id uuid, pessoa_fisica_id uuid, tipo_pessoa text, empresa text, identificacao text,
  codigo text, documento text, valido_ate date, dias int)
language sql stable security invoker set search_path = public as $$
  with ultimos as (
    select distinct on (d.pessoa_juridica_id, d.pessoa_fisica_id, d.codigo) d.*
    from public.hab_documentos d
    where d.valido_ate is not null and d.valido_ate <= current_date + p_dias
    order by d.pessoa_juridica_id, d.pessoa_fisica_id, d.codigo, d.criado_em desc
  )
  select d.pessoa_juridica_id, d.pessoa_fisica_id,
    case when d.pessoa_fisica_id is not null then 'pf' else 'pj' end,
    coalesce(pj.razao_social, pf.nome), coalesce(pj.cnpj, pf.cpf), d.codigo, c.nome,
    d.valido_ate, (d.valido_ate - current_date)::int
  from ultimos d join public.hab_catalogo c on c.codigo = d.codigo
  left join public.pessoas_juridicas pj on pj.id = d.pessoa_juridica_id
  left join public.pessoas_fisicas pf on pf.id = d.pessoa_fisica_id
  order by d.valido_ate;
$$;
revoke execute on function public.hab_vencimentos(int) from public, anon;
grant execute on function public.hab_vencimentos(int) to authenticated;

-- Confirmações financeiras: status, contrato e empenhos informados pelo cliente não
-- geram cobrança até que a plataforma confira e confirme os fatos.
update public.assessorias set situacao = 'solicitada', comissao_pct = null, taxa_perda = null, taxa_exito = null
where situacao = 'proposta' and proposta_snapshot is null;
alter table public.processos add column if not exists resultado_assessoria_confirmado text
  check (resultado_assessoria_confirmado in ('ganho','perdido','desistiu'));
alter table public.processos add column if not exists resultado_assessoria_confirmado_por uuid references auth.users(id) on delete set null;
alter table public.processos add column if not exists resultado_assessoria_confirmado_em timestamptz;
alter table public.processos add column if not exists contrato_assessoria_confirmado_por uuid references auth.users(id) on delete set null;
alter table public.processos add column if not exists contrato_assessoria_confirmado_em timestamptz;
alter table public.processo_empenhos add column if not exists assessoria_confirmado_por uuid references auth.users(id) on delete set null;
alter table public.processo_empenhos add column if not exists assessoria_confirmado_em timestamptz;

create or replace function public._proteger_confirmacoes_assessoria()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    if tg_table_name = 'processos' and
       (new.status is distinct from old.status or new.contrato_assinado_em is distinct from old.contrato_assinado_em
        or new.contrato_numero is distinct from old.contrato_numero) and
       exists (select 1 from public.assessoria_cobrancas c join public.assessorias a on a.id = c.assessoria_id
               where a.processo_id = old.id and c.situacao <> 'cancelada') then
      raise exception 'cancele as cobrancas ativas da assessoria antes de corrigir estes dados';
    elsif tg_table_name = 'processo_empenhos' and
       (new.numero is distinct from old.numero or new.data is distinct from old.data or new.valor is distinct from old.valor) and
       exists (select 1 from public.assessoria_cobrancas c where c.empenho_id = old.id and c.situacao <> 'cancelada') then
      raise exception 'cancele a cobranca ativa do empenho antes de corrigi-lo';
    end if;
  end if;
  if not public.eh_admin_plataforma() then
    if tg_table_name = 'processos' then
      if tg_op = 'INSERT' then
        if new.resultado_assessoria_confirmado is not null or new.resultado_assessoria_confirmado_por is not null
           or new.resultado_assessoria_confirmado_em is not null or new.contrato_assessoria_confirmado_por is not null
           or new.contrato_assessoria_confirmado_em is not null then
          raise exception 'somente a plataforma confirma dados financeiros da assessoria';
        end if;
      elsif new.resultado_assessoria_confirmado is distinct from old.resultado_assessoria_confirmado
         or new.resultado_assessoria_confirmado_por is distinct from old.resultado_assessoria_confirmado_por
         or new.resultado_assessoria_confirmado_em is distinct from old.resultado_assessoria_confirmado_em
         or new.contrato_assessoria_confirmado_por is distinct from old.contrato_assessoria_confirmado_por
         or new.contrato_assessoria_confirmado_em is distinct from old.contrato_assessoria_confirmado_em then
        raise exception 'somente a plataforma confirma dados financeiros da assessoria';
      end if;
    elsif tg_table_name = 'processo_empenhos' then
      if tg_op = 'INSERT' then
        if new.assessoria_confirmado_por is not null or new.assessoria_confirmado_em is not null then
          raise exception 'somente a plataforma confirma empenhos para cobrança';
        end if;
      elsif new.assessoria_confirmado_por is distinct from old.assessoria_confirmado_por
         or new.assessoria_confirmado_em is distinct from old.assessoria_confirmado_em then
        raise exception 'somente a plataforma confirma empenhos para cobrança';
      end if;
    end if;
  end if;
  if tg_op = 'UPDATE' and tg_table_name = 'processos' then
    if new.status is distinct from old.status then
      new.resultado_assessoria_confirmado := null;
      new.resultado_assessoria_confirmado_por := null;
      new.resultado_assessoria_confirmado_em := null;
    end if;
    if new.contrato_assinado_em is distinct from old.contrato_assinado_em or new.contrato_numero is distinct from old.contrato_numero then
      new.contrato_assessoria_confirmado_por := null;
      new.contrato_assessoria_confirmado_em := null;
    end if;
  elsif tg_op = 'UPDATE' and tg_table_name = 'processo_empenhos' then
    if new.numero is distinct from old.numero or new.data is distinct from old.data or new.valor is distinct from old.valor then
      new.assessoria_confirmado_por := null;
      new.assessoria_confirmado_em := null;
    end if;
  end if;
  return new;
end
$$;
drop trigger if exists t_proteger_confirmacoes_processo on public.processos;
create trigger t_proteger_confirmacoes_processo before insert or update on public.processos
  for each row execute function public._proteger_confirmacoes_assessoria();
drop trigger if exists t_proteger_confirmacoes_empenho on public.processo_empenhos;
create trigger t_proteger_confirmacoes_empenho before insert or update on public.processo_empenhos
  for each row execute function public._proteger_confirmacoes_assessoria();

create or replace function public._gerar_cobrancas(p_processo bigint) returns void
language plpgsql security definer set search_path = public as $$
declare a public.assessorias; p public.processos; ativas boolean;
begin
  select * into a from public.assessorias where processo_id = p_processo and situacao = 'aceita';
  if not found then return; end if;
  select * into p from public.processos where id = p_processo;
  select coalesce(taxas_fixas_ativas, false) into ativas from public.assessoria_parametros where id = 1;
  if p.resultado_assessoria_confirmado = 'perdido' and coalesce(a.taxa_perda, 0) > 0 and coalesce(ativas,false) then
    insert into public.assessoria_cobrancas (organizacao_id, assessoria_id, tipo, valor, observacao)
    values (a.organizacao_id, a.id, 'taxa_perda', a.taxa_perda, 'Resultado confirmado pela plataforma como perdido') on conflict do nothing;
  elsif p.resultado_assessoria_confirmado = 'ganho' and coalesce(a.taxa_exito, 0) > 0 and coalesce(ativas,false) then
    insert into public.assessoria_cobrancas (organizacao_id, assessoria_id, tipo, valor, observacao)
    values (a.organizacao_id, a.id, 'taxa_exito', a.taxa_exito, 'Resultado confirmado pela plataforma como ganho') on conflict do nothing;
  end if;
  if p.contrato_assessoria_confirmado_em is not null and coalesce(a.comissao_pct, 0) > 0 then
    insert into public.assessoria_cobrancas (organizacao_id, assessoria_id, tipo, empenho_id, base_valor, pct, valor, observacao)
    select a.organizacao_id, a.id, 'comissao_empenho', e.id, e.valor, a.comissao_pct,
      round(e.valor * a.comissao_pct / 100, 2), 'Empenho ' || e.numero || ' confirmado pela plataforma'
    from public.processo_empenhos e
    where e.processo_id = p_processo and e.assessoria_confirmado_em is not null
      and e.data >= p.contrato_assinado_em
      and not exists (select 1 from public.assessoria_cobrancas c where c.empenho_id = e.id and c.situacao <> 'cancelada');
  end if;
end
$$;

create or replace function public.confirmar_resultado_assessoria(p_processo bigint, p_resultado text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.eh_admin_plataforma() then raise exception 'apenas a plataforma confirma resultados'; end if;
  if p_resultado not in ('ganho','perdido','desistiu') then raise exception 'resultado invalido'; end if;
  if not exists (select 1 from public.assessorias where processo_id = p_processo and situacao = 'aceita') then
    raise exception 'nao existe assessoria aceita para este processo';
  end if;
  update public.processos set resultado_assessoria_confirmado = p_resultado,
    resultado_assessoria_confirmado_por = auth.uid(), resultado_assessoria_confirmado_em = now()
  where id = p_processo and status = p_resultado;
  if not found then raise exception 'o resultado informado precisa coincidir com o status atual do processo'; end if;
  perform public._gerar_cobrancas(p_processo);
end
$$;

create or replace function public.confirmar_contrato_assessoria(p_processo bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.eh_admin_plataforma() then raise exception 'apenas a plataforma confirma contratos'; end if;
  if not exists (select 1 from public.assessorias where processo_id = p_processo and situacao = 'aceita') then
    raise exception 'nao existe assessoria aceita para este processo';
  end if;
  update public.processos set contrato_assessoria_confirmado_por = auth.uid(), contrato_assessoria_confirmado_em = now()
  where id = p_processo and contrato_assinado_em is not null;
  if not found then raise exception 'informe a data de assinatura antes de confirmar'; end if;
  perform public._gerar_cobrancas(p_processo);
end
$$;

create or replace function public.confirmar_empenho_assessoria(p_empenho bigint)
returns void language plpgsql security definer set search_path = public as $$
declare v_processo bigint;
begin
  if not public.eh_admin_plataforma() then raise exception 'apenas a plataforma confirma empenhos'; end if;
  select processo_id into v_processo from public.processo_empenhos where id = p_empenho;
  if v_processo is null then raise exception 'empenho nao encontrado'; end if;
  if not exists (select 1 from public.assessorias where processo_id = v_processo and situacao = 'aceita') then
    raise exception 'nao existe assessoria aceita para este processo';
  end if;
  if not exists (select 1 from public.processos where id = v_processo and contrato_assessoria_confirmado_em is not null) then
    raise exception 'confirme o contrato antes de confirmar empenhos';
  end if;
  update public.processo_empenhos set assessoria_confirmado_por = auth.uid(), assessoria_confirmado_em = now() where id = p_empenho;
  perform public._gerar_cobrancas(v_processo);
end
$$;

create or replace function public.atualizar_cobranca(p_id bigint, p_situacao text, p_pago_em date default null, p_obs text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.eh_admin_plataforma() then raise exception 'apenas a plataforma'; end if;
  if p_situacao not in ('aberta','paga','cancelada') then raise exception 'situacao invalida'; end if;
  update public.assessoria_cobrancas set
    situacao = p_situacao,
    pago_em = case when p_situacao = 'paga' then coalesce(p_pago_em, current_date) else null end,
    observacao = coalesce(p_obs, observacao)
  where id = p_id;
end
$$;

revoke execute on function public.confirmar_resultado_assessoria(bigint,text),
  public.confirmar_contrato_assessoria(bigint), public.confirmar_empenho_assessoria(bigint) from public, anon;
grant execute on function public.confirmar_resultado_assessoria(bigint,text),
  public.confirmar_contrato_assessoria(bigint), public.confirmar_empenho_assessoria(bigint) to authenticated;
