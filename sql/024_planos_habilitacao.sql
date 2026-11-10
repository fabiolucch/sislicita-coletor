-- 024: planos (Gratuito, Básico, Premium) com regras aplicadas no banco, e módulo de habilitação (SICAF + certidões).
-- Pagamento ainda não integrado: a assinatura guarda provedor/referência para quando houver gateway (cartão/Pix).

-- A. planos e assinaturas -------------------------------------------------------------------------
create table if not exists public.planos (
  codigo text primary key,
  nome text not null,
  descricao text,
  preco_mensal numeric(10,2),
  recursos text[] not null default '{}',
  ordem int not null default 0,
  ativo boolean not null default true
);
insert into public.planos (codigo, nome, descricao, preco_mensal, recursos, ordem) values
  ('gratuito', 'Gratuito', 'Dados públicos de editais, PCA e preços, sem IA e sem perfil de busca.', 0, '{dados_publicos}', 1),
  ('basico', 'Básico', 'Dados públicos com leitura por IA, Radar, perfis de busca e acompanhamento das licitações da empresa.', null, '{dados_publicos,ia,radar,perfis,processos}', 2),
  ('premium', 'Premium', 'Tudo do Básico, mais habilitação (SICAF e certidões) e assessoria para participar, mediante comissão.', null, '{dados_publicos,ia,radar,perfis,processos,habilitacao,assessoria}', 3)
on conflict (codigo) do update set nome = excluded.nome, descricao = excluded.descricao, recursos = excluded.recursos, ordem = excluded.ordem;

create table if not exists public.assinaturas (
  organizacao_id uuid primary key references public.organizacoes(id) on delete cascade,
  plano text not null references public.planos(codigo),
  situacao text not null default 'teste' check (situacao in ('teste','ativa','pendente','inadimplente','cancelada')),
  teste_ate timestamptz,
  periodo_fim timestamptz,
  provedor text, provedor_ref text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create table if not exists public.assinaturas_eventos (
  id bigserial primary key,
  organizacao_id uuid not null references public.organizacoes(id) on delete cascade,
  tipo text not null, dados jsonb, por uuid references auth.users(id) on delete set null,
  em timestamptz not null default now()
);
create table if not exists public.solicitacoes_plano (
  id bigserial primary key,
  organizacao_id uuid not null references public.organizacoes(id) on delete cascade,
  plano text not null references public.planos(codigo),
  solicitante uuid references auth.users(id) on delete set null,
  observacao text,
  situacao text not null default 'aberta' check (situacao in ('aberta','atendida','cancelada')),
  criado_em timestamptz not null default now()
);
alter table public.planos enable row level security;
alter table public.assinaturas enable row level security;
alter table public.assinaturas_eventos enable row level security;
alter table public.solicitacoes_plano enable row level security;
drop policy if exists planos_ler on public.planos;
create policy planos_ler on public.planos for select to authenticated, anon using (ativo);
drop policy if exists assin_ler on public.assinaturas;
create policy assin_ler on public.assinaturas for select to authenticated using (public.pode_ler_org(organizacao_id));
drop policy if exists assin_ev_ler on public.assinaturas_eventos;
create policy assin_ev_ler on public.assinaturas_eventos for select to authenticated using (public.eh_admin_plataforma());
drop policy if exists solic_ler on public.solicitacoes_plano;
create policy solic_ler on public.solicitacoes_plano for select to authenticated using (public.pode_ler_org(organizacao_id));
revoke insert, update, delete on public.planos, public.assinaturas, public.assinaturas_eventos, public.solicitacoes_plano from authenticated, anon;
grant select on public.planos to authenticated, anon;
grant select on public.assinaturas, public.assinaturas_eventos, public.solicitacoes_plano to authenticated;

-- plano que vale agora para a organização (teste vencido ou assinatura parada voltam ao Gratuito)
create or replace function public.plano_efetivo(p_org uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
    when (select tipo from organizacoes where id = p_org) = 'plataforma' then 'plataforma'
    else coalesce((
      select case
        when a.situacao = 'teste' and a.teste_ate > now() then a.plano
        when a.situacao = 'ativa' and (a.periodo_fim is null or a.periodo_fim > now() - interval '3 days') then a.plano
        else null end
      from assinaturas a where a.organizacao_id = p_org), 'gratuito') end;
$$;

create or replace function public.tem_recurso_org(p_org uuid, p_recurso text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(coalesce(auth.role(), '') = 'service_role' or session_user in ('postgres','supabase_admin')
    or public.eh_admin_plataforma()
    or (select case when public.plano_efetivo(p_org) = 'plataforma' then true
                    else p_recurso = any(coalesce((select recursos from planos where codigo = public.plano_efetivo(p_org)), '{}')) end), false);
$$;
create or replace function public.tem_recurso(p_recurso text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.tem_recurso_org(public.org_atual(), p_recurso);
$$;

create or replace function public.meu_plano() returns jsonb
language sql stable security definer set search_path = public as $$
  with o as (select public.org_atual() id), e as (select public.plano_efetivo((select id from o)) p)
  select jsonb_build_object(
    'plano', (select p from e),
    'nome', coalesce((select nome from planos where codigo = (select p from e)), 'Plataforma'),
    'recursos', case when (select p from e) = 'plataforma' or public.eh_admin_plataforma() then to_jsonb(array['*'])
                     else to_jsonb(coalesce((select recursos from planos where codigo = (select p from e)), '{}')) end,
    'contratado', (select plano from assinaturas where organizacao_id = (select id from o)),
    'situacao', (select situacao from assinaturas where organizacao_id = (select id from o)),
    'teste_ate', (select teste_ate from assinaturas where organizacao_id = (select id from o)),
    'solicitado', (select plano from solicitacoes_plano where organizacao_id = (select id from o) and situacao = 'aberta' order by criado_em desc limit 1));
$$;

-- toda organização cliente nova começa com 7 dias de teste do Básico
create or replace function public._assinatura_inicial() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.tipo = 'cliente' then
    insert into assinaturas (organizacao_id, plano, situacao, teste_ate) values (new.id, 'basico', 'teste', now() + interval '7 days') on conflict do nothing;
    insert into assinaturas_eventos (organizacao_id, tipo, dados) values (new.id, 'teste_iniciado', jsonb_build_object('plano','basico','dias',7));
  end if;
  return new;
end $$;
drop trigger if exists t_assinatura_inicial on public.organizacoes;
create trigger t_assinatura_inicial after insert on public.organizacoes for each row execute function public._assinatura_inicial();
insert into public.assinaturas (organizacao_id, plano, situacao, teste_ate)
  select id, 'basico', 'teste', now() + interval '7 days' from public.organizacoes o
  where o.tipo = 'cliente' and not exists (select 1 from public.assinaturas a where a.organizacao_id = o.id);

create or replace function public.solicitar_plano(p_plano text, p_obs text default null) returns void
language plpgsql security definer set search_path = public as $$
declare o uuid := public.org_atual();
begin
  if o is null or not public.pode_admin_org(o) then raise exception 'apenas administradores da organizacao pedem troca de plano'; end if;
  if not exists (select 1 from planos where codigo = p_plano and ativo) then raise exception 'plano invalido'; end if;
  update solicitacoes_plano set situacao = 'cancelada' where organizacao_id = o and situacao = 'aberta';
  insert into solicitacoes_plano (organizacao_id, plano, solicitante, observacao) values (o, p_plano, auth.uid(), left(p_obs, 500));
end $$;

-- só a plataforma muda plano (até existir o gateway de pagamento)
create or replace function public.definir_plano(p_org uuid, p_plano text, p_situacao text, p_teste_ate timestamptz default null, p_periodo_fim timestamptz default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.eh_admin_plataforma() then raise exception 'apenas a plataforma altera planos'; end if;
  if not exists (select 1 from planos where codigo = p_plano) then raise exception 'plano invalido'; end if;
  if p_situacao not in ('teste','ativa','pendente','inadimplente','cancelada') then raise exception 'situacao invalida'; end if;
  insert into assinaturas (organizacao_id, plano, situacao, teste_ate, periodo_fim) values (p_org, p_plano, p_situacao, p_teste_ate, p_periodo_fim)
  on conflict (organizacao_id) do update set plano = excluded.plano, situacao = excluded.situacao, teste_ate = excluded.teste_ate, periodo_fim = excluded.periodo_fim, atualizado_em = now();
  insert into assinaturas_eventos (organizacao_id, tipo, dados, por) values (p_org, 'plano_definido',
    jsonb_build_object('plano', p_plano, 'situacao', p_situacao, 'teste_ate', p_teste_ate, 'periodo_fim', p_periodo_fim), auth.uid());
  update solicitacoes_plano set situacao = 'atendida' where organizacao_id = p_org and situacao = 'aberta' and plano = p_plano;
end $$;

create or replace function public.listar_clientes() returns table (id uuid, nome text, criado_em timestamptz, membros bigint, plano text, situacao text, teste_ate timestamptz, efetivo text, solicitado text)
language sql stable security definer set search_path = public as $$
  select o.id, o.nome, o.criado_em, (select count(*) from vinculos_org v where v.organizacao_id = o.id and v.situacao = 'ativo'),
    a.plano, a.situacao, a.teste_ate, public.plano_efetivo(o.id),
    (select s.plano from solicitacoes_plano s where s.organizacao_id = o.id and s.situacao = 'aberta' order by s.criado_em desc limit 1)
  from organizacoes o left join assinaturas a on a.organizacao_id = o.id
  where o.tipo = 'cliente' and public.eh_admin_plataforma() order by o.criado_em desc;
$$;

revoke execute on function public.plano_efetivo(uuid), public.tem_recurso_org(uuid, text), public.tem_recurso(text), public.meu_plano(), public.solicitar_plano(text, text), public.definir_plano(uuid, text, text, timestamptz, timestamptz), public.listar_clientes() from public, anon;
grant execute on function public.plano_efetivo(uuid), public.tem_recurso_org(uuid, text), public.tem_recurso(text), public.meu_plano(), public.solicitar_plano(text, text), public.definir_plano(uuid, text, text, timestamptz, timestamptz), public.listar_clientes() to authenticated, service_role;

-- B. regras por plano aplicadas no banco (políticas restritivas somam-se às de isolamento) ----------
drop policy if exists plano_perfis_ins on public.perfis_busca;
create policy plano_perfis_ins on public.perfis_busca as restrictive for insert to authenticated with check (public.tem_recurso_org(organizacao_id, 'perfis'));
drop policy if exists plano_perfis_upd on public.perfis_busca;
create policy plano_perfis_upd on public.perfis_busca as restrictive for update to authenticated using (public.tem_recurso_org(organizacao_id, 'perfis'));
drop policy if exists plano_radar on public.radar;
create policy plano_radar on public.radar as restrictive for all to authenticated using ((select public.tem_recurso('radar')));
do $t$ begin
  if to_regclass('public.triagem') is not null then
    execute 'drop policy if exists plano_triagem on public.triagem';
    execute 'create policy plano_triagem on public.triagem as restrictive for select to authenticated using ((select public.tem_recurso(''radar'')))';
  end if;
end $t$;
drop policy if exists plano_processos_ins on public.processos;
create policy plano_processos_ins on public.processos as restrictive for insert to authenticated with check (public.tem_recurso_org(organizacao_id, 'processos'));

-- triagem/composição de perfil (funções pesadas) também respeitam o plano
create or replace function public._perfil_ok(p uuid) returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(coalesce(auth.role(), '') = 'service_role' or session_user in ('postgres', 'supabase_admin')
    or (public.pode_editar_org((select organizacao_id from perfis_busca where id = p))
        and public.tem_recurso_org((select organizacao_id from perfis_busca where id = p), 'perfis')), false);
$$;

-- C. habilitação: catálogo de documentos (Lei 14.133, arts. 62-70, e níveis do SICAF) --------------
create table if not exists public.hab_catalogo (
  codigo text primary key,
  nome text not null,
  grupo text not null check (grupo in ('credenciamento','juridica','fiscal','tecnica','economica','declaracoes','impedimentos','sicaf')),
  nivel_sicaf smallint,
  base_legal text,
  naturezas text[] not null,
  obrigatorio boolean not null default true,
  validade_dias int,
  link text,
  como_obter text,
  sicaf_automatico boolean not null default false,
  ordem int not null default 0
);
alter table public.hab_catalogo enable row level security;
drop policy if exists hab_cat_ler on public.hab_catalogo;
create policy hab_cat_ler on public.hab_catalogo for select to authenticated using (true);
revoke insert, update, delete on public.hab_catalogo from authenticated, anon;
grant select on public.hab_catalogo to authenticated;

-- naturezas: mei, ei (empresário individual), ltda (inclui unipessoal e antigas EIRELI), sa, coop, ss (sociedade simples), assoc (associação/fundação), pf
insert into public.hab_catalogo (codigo, nome, grupo, nivel_sicaf, base_legal, naturezas, obrigatorio, validade_dias, link, como_obter, sicaf_automatico, ordem) values
 ('cnpj', 'Comprovante de inscrição no CNPJ', 'credenciamento', 1, 'Lei 14.133, art. 68, I', '{mei,ei,ltda,sa,coop,ss,assoc}', true, null,
  'https://solucoes.receita.fazenda.gov.br/Servicos/cnpjreva/Cnpjreva_Solicitacao.asp', 'Emitido na hora pelo site da Receita Federal. Confira se a situação cadastral está ATIVA e se os CNAEs cobrem o que você pretende vender.', false, 10),
 ('identidade', 'Documento de identidade dos sócios e administradores (e certidão de casamento/união estável, quando for o caso)', 'credenciamento', 1, 'Manual do SICAF, Nível I', '{mei,ei,ltda,sa,coop,ss,assoc,pf}', true, null,
  null, 'Digitalize RG/CNH de cada sócio e administrador. O SICAF pede também o CPF e o RG do cônjuge ou companheiro, quando houver.', false, 20),
 ('inscricao_fiscal', 'Prova de inscrição estadual e/ou municipal', 'credenciamento', 1, 'Lei 14.133, art. 68, II', '{mei,ei,ltda,sa,coop,ss,assoc}', true, null,
  'http://www.sintegra.gov.br/', 'Inscrição estadual (venda de bens / ICMS) pelo Sintegra; inscrição municipal (serviços / ISS) no cadastro da prefeitura da sede.', false, 30),
 ('ccmei', 'Certificado da Condição de Microempreendedor Individual (CCMEI)', 'juridica', 2, 'Lei 14.133, art. 66; Manual do SICAF', '{mei}', true, null,
  'https://www.gov.br/empresas-e-negocios/pt-br/empreendedor', 'Emitido no Portal do Empreendedor (gov.br).', false, 40),
 ('requerimento_empresario', 'Requerimento de Empresário registrado na Junta Comercial', 'juridica', 2, 'Lei 14.133, art. 66', '{ei}', true, null,
  null, 'Cópia do registro na Junta Comercial do seu estado.', false, 41),
 ('contrato_social', 'Contrato social consolidado e alterações, registrados', 'juridica', 2, 'Lei 14.133, art. 66', '{ltda,ss}', true, null,
  null, 'Última consolidação e alterações posteriores, registradas na Junta Comercial (sociedade empresária) ou no cartório (sociedade simples).', false, 42),
 ('estatuto_ata', 'Estatuto social e ata de eleição da diretoria atual, registrados', 'juridica', 2, 'Lei 14.133, art. 66', '{sa,coop,assoc}', true, null,
  null, 'Estatuto vigente e última ata de eleição dos administradores, registrados no órgão competente.', false, 43),
 ('certidao_simplificada', 'Certidão simplificada da Junta Comercial', 'juridica', null, 'Exigência comum em editais', '{ei,ltda,sa,coop}', false, 90,
  null, 'Emitida pela Junta Comercial do seu estado. Muitos editais pedem emissão recente (em geral até 90 dias).', false, 44),
 ('procuracao', 'Procuração ou ato de nomeação do representante', 'juridica', null, 'Exigência comum em editais', '{mei,ei,ltda,sa,coop,ss,assoc,pf}', false, null,
  null, 'Necessária quando quem assina ou opera a licitação não é sócio-administrador.', false, 45),
 ('cnd_federal', 'Certidão de débitos federais e Dívida Ativa da União (Receita/PGFN, inclui contribuições previdenciárias)', 'fiscal', 3, 'Lei 14.133, art. 68, III e IV', '{mei,ei,ltda,sa,coop,ss,assoc,pf}', true, 180,
  'https://servicos.receitafederal.gov.br/servico/certidoes/#/home', 'Emitida na hora informando o CNPJ (ou CPF). Certidão positiva com efeito de negativa também é aceita.', true, 50),
 ('crf_fgts', 'Certificado de Regularidade do FGTS (CRF)', 'fiscal', 3, 'Lei 14.133, art. 68, IV', '{mei,ei,ltda,sa,coop,ss,assoc}', true, 30,
  'https://consulta-crf.caixa.gov.br/consultacrf/pages/consultaEmpregador.jsf', 'Emitido pela Caixa informando o CNPJ. É a certidão de menor validade: renove todo mês.', true, 51),
 ('cndt', 'Certidão Negativa de Débitos Trabalhistas (CNDT)', 'fiscal', 3, 'Lei 14.133, art. 68, V', '{mei,ei,ltda,sa,coop,ss,assoc,pf}', true, 180,
  'https://cndt-certidao.tst.jus.br/inicio.faces', 'Emitida pelo TST informando o CNPJ (ou CPF).', true, 52),
 ('cnd_estadual', 'Certidão de regularidade fiscal estadual (sede)', 'fiscal', 4, 'Lei 14.133, art. 68, III', '{mei,ei,ltda,sa,coop,ss,assoc,pf}', true, null,
  'uf:estadual', 'Escolha o estado da sede e emita no site oficial da Secretaria da Fazenda. A validade varia por estado: informe a data que consta na certidão.', false, 53),
 ('cnd_municipal', 'Certidão de regularidade fiscal municipal (sede)', 'fiscal', 4, 'Lei 14.133, art. 68, III', '{mei,ei,ltda,sa,coop,ss,assoc,pf}', true, null,
  'https://www.google.com/search?q=certid%C3%A3o+negativa+de+d%C3%A9bitos+municipais+prefeitura+{MUNICIPIO}+{UF}', 'Emitida no site da prefeitura da sede. A validade varia por município: informe a data que consta na certidão.', false, 54),
 ('registro_conselho', 'Registro no conselho profissional (CREA, CRA, CRQ, CRF etc.), quando o objeto exigir', 'tecnica', 5, 'Lei 14.133, art. 67, V', '{mei,ei,ltda,sa,coop,ss,assoc,pf}', false, null,
  null, 'Só para atividades regulamentadas. Guarde a certidão de registro e quitação do conselho.', false, 60),
 ('atestados', 'Atestados de capacidade técnica', 'tecnica', 5, 'Lei 14.133, art. 67, II', '{mei,ei,ltda,sa,coop,ss,assoc,pf}', false, null,
  null, 'Peça atestados a clientes (públicos ou privados) após cada fornecimento. Eles valem para editais futuros com objeto semelhante.', false, 61),
 ('balanco', 'Balanço patrimonial, DRE e demonstrações contábeis dos 2 últimos exercícios', 'economica', 6, 'Lei 14.133, art. 69, I e § 6º', '{ei,ltda,sa,coop,ss,assoc}', true, null,
  null, 'Fornecido pelo contador. Empresa com menos de 2 anos apresenta só o último exercício. MEI é dispensado. Informe até quando vale (normalmente até o encerramento do exercício seguinte).', false, 70),
 ('falencia', 'Certidão negativa de falência (distribuidor da sede)', 'economica', 6, 'Lei 14.133, art. 69, II', '{ei,ltda,sa,coop,ss,assoc,mei}', true, 90,
  'uf:falencia', 'Escolha o estado da sede e emita no site oficial do Tribunal de Justiça. A validade costuma vir na própria certidão.', false, 71),
 ('decl_menor', 'Declaração de não emprego de menor (art. 7º, XXXIII, da Constituição)', 'declaracoes', null, 'Lei 14.133, art. 68, VI', '{mei,ei,ltda,sa,coop,ss,assoc}', true, null,
  null, 'Declaração assinada pelo representante legal. Em licitações eletrônicas costuma ser marcada no próprio sistema.', false, 80),
 ('decl_reserva_cargos', 'Declaração de cumprimento da reserva de cargos (PcD e reabilitados)', 'declaracoes', null, 'Lei 14.133, art. 63, IV', '{mei,ei,ltda,sa,coop,ss,assoc}', true, null,
  null, 'Declaração assinada pelo representante legal. Em licitações eletrônicas costuma ser marcada no próprio sistema.', false, 81),
 ('consulta_impedimentos', 'Consulta consolidada de impedimentos (TCU, CGU, CNJ: inidôneos, CEIS, CNEP, improbidade)', 'impedimentos', null, 'Verificação feita pelos órgãos antes de contratar', '{mei,ei,ltda,sa,coop,ss,assoc}', false, 30,
  'https://certidoes-apf.apps.tcu.gov.br/', 'Consulte antes de cada licitação para saber se há alguma sanção registrada contra a empresa.', false, 90),
 ('sicaf_relatorio', 'Relatório de situação do fornecedor no SICAF', 'sicaf', null, 'Lei 14.133, art. 87; IN SEGES 3/2018', '{mei,ei,ltda,sa,coop,ss,assoc,pf}', false, null,
  'https://www3.comprasnet.gov.br/sicaf-web/index.jsf', 'Depois de cadastrado, baixe o relatório do SICAF e informe a data de vencimento do cadastro.', false, 99)
on conflict (codigo) do update set nome = excluded.nome, grupo = excluded.grupo, nivel_sicaf = excluded.nivel_sicaf, base_legal = excluded.base_legal,
  naturezas = excluded.naturezas, obrigatorio = excluded.obrigatorio, validade_dias = excluded.validade_dias, link = excluded.link,
  como_obter = excluded.como_obter, sicaf_automatico = excluded.sicaf_automatico, ordem = excluded.ordem;


-- links oficiais por UF (certidão estadual e de falência); editáveis sem publicar o site
create table if not exists public.hab_links_uf (
  uf text not null, tipo text not null check (tipo in ('estadual','estadual_divida_ativa','falencia')),
  url text not null, observacao text,
  primary key (uf, tipo)
);
alter table public.hab_links_uf enable row level security;
drop policy if exists hab_links_ler on public.hab_links_uf;
create policy hab_links_ler on public.hab_links_uf for select to authenticated using (true);
revoke insert, update, delete on public.hab_links_uf from authenticated, anon;
grant select on public.hab_links_uf to authenticated;
insert into public.hab_links_uf (uf, tipo, url, observacao) values
 ('AC','estadual','http://sefazonline.ac.gov.br/sefazonline/app.cndprincipal',null),
 ('AC','falencia','https://www.tjac.jus.br/','Site oficial do Tribunal de Justiça: procure o menu Certidões e escolha a certidão de falência e recuperação judicial.'),
 ('AL','estadual','https://contribuinte.sefaz.al.gov.br/certidao/#/emitir-certidao',null),
 ('AL','falencia','https://www.tjal.jus.br/','Site oficial do Tribunal de Justiça: procure o menu Certidões e escolha a certidão de falência e recuperação judicial.'),
 ('AM','estadual','http://sistemas.sefaz.am.gov.br/GAE/mnt/dividaAtiva/certidaoNegativa/emitirCertidaoNegativaNaoContPortal.do',null),
 ('AM','falencia','https://www.tjam.jus.br/','Site oficial do Tribunal de Justiça: procure o menu Certidões e escolha a certidão de falência e recuperação judicial.'),
 ('AP','estadual','https://www.sefaz.ap.gov.br/sate/seg/SEGf_AcessarFuncao.jsp?cdFuncao=DIA_060',null),
 ('AP','falencia','https://www.tjap.jus.br/','Site oficial do Tribunal de Justiça: procure o menu Certidões e escolha a certidão de falência e recuperação judicial.'),
 ('BA','estadual','https://servicos.sefaz.ba.gov.br/sistemas/DSCRE/Modulos/Publico/EmissaoCertidao.aspx',null),
 ('BA','falencia','https://portalcertidoes.tjba.jus.br/#/primeirograu',null),
 ('CE','estadual','https://consultapublica.sefaz.ce.gov.br/certidaonegativa/preparar-consultar',null),
 ('CE','falencia','https://www.tjce.jus.br/','Site oficial do Tribunal de Justiça: procure o menu Certidões e escolha a certidão de falência e recuperação judicial.'),
 ('DF','estadual','https://ww1.receita.fazenda.df.gov.br/cidadao/certidoes/Certidao',null),
 ('DF','falencia','https://www.tjdft.jus.br/','Site oficial do Tribunal de Justiça: procure o menu Certidões e escolha a certidão de falência e recuperação judicial.'),
 ('ES','estadual','https://s2-internet.sefaz.es.gov.br/certidao/cnd',null),
 ('ES','falencia','https://www.tjes.jus.br/','Site oficial do Tribunal de Justiça: procure o menu Certidões e escolha a certidão de falência e recuperação judicial.'),
 ('GO','estadual','http://www.sefaz.go.gov.br/Certidao/Emissao/',null),
 ('GO','falencia','https://www.tjgo.jus.br/','Site oficial do Tribunal de Justiça: procure o menu Certidões e escolha a certidão de falência e recuperação judicial.'),
 ('MA','estadual','https://sistemas1.sefaz.ma.gov.br/certidoes/jsp/emissaoCertidaoNegativa/emissaoCertidaoNegativa.jsf',null),
 ('MA','falencia','https://www.tjma.jus.br/','Site oficial do Tribunal de Justiça: procure o menu Certidões e escolha a certidão de falência e recuperação judicial.'),
 ('MG','estadual','https://cdt.fazenda.mg.gov.br/',null),
 ('MG','falencia','https://www.tjmg.jus.br/','Site oficial do Tribunal de Justiça: procure o menu Certidões e escolha a certidão de falência e recuperação judicial.'),
 ('MS','estadual','https://servicos.efazenda.ms.gov.br/pndfis/Home/Emissao',null),
 ('MS','falencia','https://esaj.tjms.jus.br/sco/abrirCadastro.do',null),
 ('MT','estadual','https://www.sefaz.mt.gov.br/cnd/certidao/servlet/ServletRotdAberto?origem=60',null),
 ('MT','falencia','https://sec.tjmt.jus.br/',null),
 ('PA','estadual','https://app.sefa.pa.gov.br/emissao-certidao/template.action',null),
 ('PA','falencia','https://www.tjpa.jus.br/','Site oficial do Tribunal de Justiça: procure o menu Certidões e escolha a certidão de falência e recuperação judicial.'),
 ('PB','estadual','https://www.sefaz.pb.gov.br/servirtual/certidoes/emissao-de-certidao-de-debitos-cidadao',null),
 ('PB','falencia','https://www.tjpb.jus.br/','Site oficial do Tribunal de Justiça: procure o menu Certidões e escolha a certidão de falência e recuperação judicial.'),
 ('PE','estadual','https://efisco.sefaz.pe.gov.br/sfi_trb_gpf/PREmitirCertidaoNegativaNarrativaDebitoFiscal',null),
 ('PE','falencia','https://www.tjpe.jus.br/','Site oficial do Tribunal de Justiça: procure o menu Certidões e escolha a certidão de falência e recuperação judicial.'),
 ('PI','estadual','https://siatweb.sefaz.pi.gov.br/portal-publico/',null),
 ('PI','falencia','https://www.tjpi.jus.br/','Site oficial do Tribunal de Justiça: procure o menu Certidões e escolha a certidão de falência e recuperação judicial.'),
 ('PR','estadual','https://cdwfazenda.paas.pr.gov.br/cdwportal/certidao/automatica',null),
 ('PR','falencia','https://www.tjpr.jus.br/','Site oficial do Tribunal de Justiça: procure o menu Certidões e escolha a certidão de falência e recuperação judicial.'),
 ('RJ','estadual','https://crf-unificada-web.fazenda.rj.gov.br/crf-unificada-web/#/',null),
 ('RJ','falencia','https://www.tjrj.jus.br/','Site oficial do Tribunal de Justiça: procure o menu Certidões e escolha a certidão de falência e recuperação judicial.'),
 ('RN','estadual','https://uvt2.set.rn.gov.br/#/services/certidao-negativa/emitir',null),
 ('RN','falencia','https://www.tjrn.jus.br/','Site oficial do Tribunal de Justiça: procure o menu Certidões e escolha a certidão de falência e recuperação judicial.'),
 ('RO','estadual','https://portalcontribuinte.sefin.ro.gov.br/Publico/certidaoNegativa.jsp',null),
 ('RO','falencia','https://www.tjro.jus.br/','Site oficial do Tribunal de Justiça: procure o menu Certidões e escolha a certidão de falência e recuperação judicial.'),
 ('RR','estadual','https://www.sefaz.rr.gov.br/empresa/certidao-negativa-de-debitos',null),
 ('RR','falencia','https://www.tjrr.jus.br/','Site oficial do Tribunal de Justiça: procure o menu Certidões e escolha a certidão de falência e recuperação judicial.'),
 ('RS','estadual','https://www.sefaz.rs.gov.br/sat/CertidaoSitFiscalSolic.aspx',null),
 ('RS','falencia','https://www.tjrs.jus.br/novo/processos-e-servicos/servicos-processuais/emissao-de-antecedentes-e-certidoes/','No RS a certidão sai como "Certidão Judicial Cível" (inclui falência e recuperação).'),
 ('SC','estadual','https://tributario.sef.sc.gov.br/tax.NET/Sat.CtaCte.Web/SolicitacaoCnd.aspx',null),
 ('SC','falencia','https://www.tjsc.jus.br/','Site oficial do Tribunal de Justiça: procure o menu Certidões e escolha a certidão de falência e recuperação judicial.'),
 ('SE','estadual','https://www.sefaz.se.gov.br/SitePages/emissao_certidao_negativa.aspx',null),
 ('SE','falencia','https://www.tjse.jus.br/','Site oficial do Tribunal de Justiça: procure o menu Certidões e escolha a certidão de falência e recuperação judicial.'),
 ('SP','estadual','https://www4.fazenda.sp.gov.br/SIDEB/CertidaoNegativaDebitos/EmitirECND',null),
 ('SP','falencia','https://esaj.tjsp.jus.br/sco/abrirCadastro.do','Escolha o modelo "Certidão Estadual de Falências, Concordatas e Recuperações Judiciais". Desde 2026 o TJSP orienta consultar também o eproc.'),
 ('TO','estadual','https://www.to.gov.br/sefaz/cnd-certidao-negativa-de-debitos/7h3xx8lr88vg',null),
 ('TO','falencia','https://www.tjto.jus.br/','Site oficial do Tribunal de Justiça: procure o menu Certidões e escolha a certidão de falência e recuperação judicial.'),
 ('SP','estadual_divida_ativa','https://www.dividaativa.pge.sp.gov.br/','Em SP a certidão de débitos inscritos em dívida ativa é emitida à parte, pela Procuradoria Geral do Estado.')
on conflict (uf, tipo) do update set url = excluded.url, observacao = excluded.observacao;

-- D. habilitação por empresa ---------------------------------------------------------------------
create table if not exists public.hab_empresas (
  pessoa_juridica_id uuid primary key references public.pessoas_juridicas(id) on delete cascade,
  organizacao_id uuid not null default public.org_atual() references public.organizacoes(id) on delete cascade,
  natureza text check (natureza in ('mei','ei','ltda','sa','coop','ss','assoc')),
  uf text, municipio text,
  etapas jsonb not null default '{}'::jsonb,
  sicaf_vencimento date,
  observacoes text,
  atualizado_em timestamptz not null default now()
);
create table if not exists public.hab_documentos (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null default public.org_atual() references public.organizacoes(id) on delete cascade,
  pessoa_juridica_id uuid not null references public.pessoas_juridicas(id) on delete cascade,
  codigo text not null references public.hab_catalogo(codigo),
  arquivo_path text, arquivo_nome text,
  emitido_em date, valido_ate date,
  observacao text,
  criado_por uuid default auth.uid() references auth.users(id) on delete set null,
  criado_em timestamptz not null default now()
);
create index if not exists hab_doc_pj on public.hab_documentos (pessoa_juridica_id, codigo, criado_em desc);
create index if not exists hab_doc_venc on public.hab_documentos (organizacao_id, valido_ate);
alter table public.hab_empresas enable row level security;
alter table public.hab_documentos enable row level security;
do $p$
declare t text;
begin
  foreach t in array array['hab_empresas','hab_documentos'] loop
    execute format('drop policy if exists %I on public.%I', t || '_ler', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.pode_ler_org(organizacao_id))', t || '_ler', t);
    execute format('drop policy if exists %I on public.%I', t || '_esc', t);
    execute format('create policy %I on public.%I for all to authenticated using (public.pode_editar_org(organizacao_id)) with check (public.pode_editar_org(organizacao_id) and organizacao_id = (select organizacao_id from public.pessoas_juridicas where id = pessoa_juridica_id))', t || '_esc', t);
    execute format('drop policy if exists %I on public.%I', t || '_plano', t);
    execute format('create policy %I on public.%I as restrictive for all to authenticated using (public.tem_recurso_org(organizacao_id, ''habilitacao''))', t || '_plano', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $p$;

-- documentos que vencem nos próximos N dias (para alertas e Início)
create or replace function public.hab_vencimentos(p_dias int default 15) returns table (pessoa_juridica_id uuid, empresa text, codigo text, documento text, valido_ate date, dias int)
language sql stable security invoker set search_path = public as $$
  select d.pessoa_juridica_id, pj.razao_social, d.codigo, c.nome, d.valido_ate, (d.valido_ate - current_date)::int
  from (select distinct on (pessoa_juridica_id, codigo) * from hab_documentos order by pessoa_juridica_id, codigo, criado_em desc) d
  join hab_catalogo c on c.codigo = d.codigo join pessoas_juridicas pj on pj.id = d.pessoa_juridica_id
  where d.valido_ate is not null and d.valido_ate <= current_date + p_dias
  order by d.valido_ate;
$$;
grant execute on function public.hab_vencimentos(int) to authenticated;

-- arquivos da habilitação: pasta privada por organização
insert into storage.buckets (id, name, public) values ('habilitacao', 'habilitacao', false) on conflict (id) do nothing;
drop policy if exists hab_arq_ins on storage.objects;
create policy hab_arq_ins on storage.objects for insert to authenticated
  with check (bucket_id = 'habilitacao' and public.pode_editar_org(((storage.foldername(name))[1])::uuid) and public.tem_recurso_org(((storage.foldername(name))[1])::uuid, 'habilitacao'));
drop policy if exists hab_arq_ler on storage.objects;
create policy hab_arq_ler on storage.objects for select to authenticated
  using (bucket_id = 'habilitacao' and public.pode_ler_org(((storage.foldername(name))[1])::uuid));
drop policy if exists hab_arq_del on storage.objects;
create policy hab_arq_del on storage.objects for delete to authenticated
  using (bucket_id = 'habilitacao' and public.pode_editar_org(((storage.foldername(name))[1])::uuid));
