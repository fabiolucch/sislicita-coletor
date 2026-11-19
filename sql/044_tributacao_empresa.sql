-- 044 — perfil tributário e metas padrão da empresa (usados para pré-preencher a análise de viabilidade)
alter table public.pessoas_juridicas add column if not exists tributacao jsonb not null default '{}'::jsonb;
comment on column public.pessoas_juridicas.tributacao is 'Perfil tributário e metas padrão da empresa para a análise de viabilidade: regime, anexo, faixa, fator_r, atividade, icms, iss, margens, prazos e caixa padrão, com a origem de cada valor.';
