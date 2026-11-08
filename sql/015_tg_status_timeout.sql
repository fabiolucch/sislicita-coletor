-- tg_status estourava o statement_timeout padrão do papel anon (contagens em tabela grande) e o bot respondia "Não consegui ler a situação".
alter function public.tg_status(text) set statement_timeout = '25s';
select 'ok15';
