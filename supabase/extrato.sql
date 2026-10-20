-- =====================================================================
-- Barbearia do Juan — extrato do caixa para exportar (CSV para o contador)
-- Banco que já existe: rode ANTES estornos.sql, movimentos-caixa.sql e falta.sql;
-- depois cole este arquivo em Supabase > SQL Editor > New query > Run.
-- Pode rodar mais de uma vez sem problema. (O schema.sql completo já inclui tudo isto.)
-- =====================================================================

-- Todo dinheiro que entrou ou saiu no período, pela data do movimento.
-- valor > 0 é entrada, valor < 0 é saída. quando = 'YYYY-MM-DD HH24:MI' (horário de São Paulo).
create or replace function public.extrato(p_de date, p_ate date) returns jsonb
language plpgsql security definer stable set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'NAO_AUTORIZADO' using errcode = '42501'; end if;
  if p_de is null or p_ate is null or p_de > p_ate then raise exception 'DATA_INVALIDA' using errcode = '22023'; end if;
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.quando)
      from (
        select to_char(timezone('America/Sao_Paulo', r.recebido_em), 'YYYY-MM-DD HH24:MI') as quando,
               'Pagamento de atendimento' as tipo, c.nome || ' · ' || a.codigo as descricao, r.forma, r.valor
          from recebimentos_agendamento r join agendamentos a on a.id = r.agendamento_id join clientes c on c.id = a.cliente_id
         where timezone('America/Sao_Paulo', r.recebido_em)::date between p_de and p_ate
        union all
        select to_char(timezone('America/Sao_Paulo', v.criado_em), 'YYYY-MM-DD HH24:MI'), 'Venda avulsa',
               concat_ws(' · ', nullif((select string_agg(case when i.quantidade > 1 then i.quantidade || '× ' else '' end || i.nome, ', ' order by i.id)
                                          from vendas_avulsas_itens i where i.venda_id = v.id), ''), nullif(v.cliente_nome, '')),
               v.forma, v.valor_total
          from vendas_avulsas v
         where v.status = 'ativa' and v.data between p_de and p_ate
        union all
        select to_char(timezone('America/Sao_Paulo', e.criado_em), 'YYYY-MM-DD HH24:MI'), 'Devolução ao cliente',
               c.nome || ' · ' || a.codigo || case when a.status = 'falta' then ' com falta' else ' cancelado' end, e.forma, -e.valor
          from estornos e join agendamentos a on a.id = e.agendamento_id join clientes c on c.id = a.cliente_id
         where timezone('America/Sao_Paulo', e.criado_em)::date between p_de and p_ate
        union all
        select to_char(timezone('America/Sao_Paulo', m.criado_em), 'YYYY-MM-DD HH24:MI'),
               case m.tipo when 'despesa' then 'Despesa' when 'sangria' then 'Sangria (retirada da gaveta)' else 'Reforço de troco' end,
               m.descricao, m.forma, case when m.tipo = 'reforco' then m.valor else -m.valor end
          from movimentos_caixa m
         where m.data between p_de and p_ate
      ) x), '[]'::jsonb);
end;
$$;
revoke all on function public.extrato(date, date) from public, anon;
grant execute on function public.extrato(date, date) to authenticated;
