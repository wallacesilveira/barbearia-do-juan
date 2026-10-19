-- =====================================================================
-- Barbearia do Juan — estornos (devolução ao cancelar um agendamento já pago)
-- Banco que já existe: cole este arquivo em Supabase > SQL Editor > New query > Run.
-- Pode rodar mais de uma vez sem problema. (O schema.sql completo já inclui tudo isto.)
-- =====================================================================

create table if not exists estornos (
  id bigint generated always as identity primary key,
  agendamento_id bigint not null references agendamentos(id) on delete cascade,
  valor numeric(10,2) not null check (valor > 0),
  forma text not null check (forma in ('dinheiro','pix','cartao','outro')),
  criado_em timestamptz not null default now()
);
create index if not exists idx_estornos_ag on estornos (agendamento_id);

alter table estornos enable row level security;
drop policy if exists adm_estornos on estornos;
create policy adm_estornos on estornos for all using (is_admin()) with check (is_admin());
grant select, insert, update, delete on estornos to authenticated;
revoke all on estornos from anon;

-- Dinheiro devolvido da gaveta no dia.
create or replace function public.devolvido_do_dia(p_data date) returns numeric
language sql security definer stable set search_path = public as $$
  select coalesce(sum(valor), 0) from estornos
   where forma = 'dinheiro' and timezone('America/Sao_Paulo', criado_em)::date = p_data;
$$;
revoke all on function public.devolvido_do_dia(date) from public, anon, authenticated;

create or replace function public.caixa_diario_resumo(p_data date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_caixa caixas_diarios%rowtype;
  v_recebido numeric(10,2);
  v_devolvido numeric(10,2);
  v_esperado numeric(10,2);
begin
  if not public.is_admin() then raise exception 'NAO_AUTORIZADO' using errcode = '42501'; end if;
  if p_data is null then raise exception 'DATA_INVALIDA' using errcode = '22023'; end if;
  select * into v_caixa from caixas_diarios where data = p_data;
  v_recebido := public.dinheiro_do_dia(p_data);
  v_devolvido := public.devolvido_do_dia(p_data);
  if v_caixa.data is not null then v_esperado := v_caixa.valor_abertura + v_recebido - v_devolvido; end if;
  return jsonb_build_object(
    'data', p_data,
    'status', coalesce(v_caixa.status, 'nao_aberto'),
    'valor_abertura', v_caixa.valor_abertura,
    'recebido_dinheiro', v_recebido,
    'devolvido_dinheiro', v_devolvido,
    'valor_esperado', v_esperado,
    'valor_contado', v_caixa.valor_contado,
    'diferenca', v_caixa.diferenca,
    'observacao', coalesce(v_caixa.observacao, ''),
    'aberto_em', v_caixa.aberto_em,
    'fechado_em', v_caixa.fechado_em
  );
end;
$$;

create or replace function public.fechar_caixa_diario(p_data date, p_valor_contado numeric) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_caixa caixas_diarios%rowtype;
  v_esperado numeric(10,2);
begin
  if not public.is_admin() then raise exception 'NAO_AUTORIZADO' using errcode = '42501'; end if;
  if p_data is null or p_valor_contado is null or p_valor_contado < 0 then
    raise exception 'DADOS_INVALIDOS' using errcode = '22023';
  end if;
  select * into v_caixa from caixas_diarios where data = p_data for update;
  if not found then raise exception 'CAIXA_NAO_ABERTO' using errcode = 'P0002'; end if;
  if v_caixa.status <> 'aberto' then raise exception 'CAIXA_JA_FECHADO' using errcode = '23505'; end if;
  v_esperado := v_caixa.valor_abertura + public.dinheiro_do_dia(p_data) - public.devolvido_do_dia(p_data);
  update caixas_diarios
     set valor_contado = round(p_valor_contado, 2), diferenca = round(p_valor_contado, 2) - v_esperado,
         status = 'fechado', fechado_em = now()
   where data = p_data;
  return public.caixa_diario_resumo(p_data);
end;
$$;

create or replace function public.caixa_resumo() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_p record;
  v_r record;
  v_av record;
  v_es record;
  v_resumo jsonb := '{}'::jsonb;
  v_formas jsonb;
  v_ranking jsonb;
begin
  if not public.is_admin() then raise exception 'NAO_AUTORIZADO' using errcode = '42501'; end if;
  for v_p in
    select * from (values
      ('hoje', v_hoje, v_hoje),
      ('semana', date_trunc('week', v_hoje::timestamp)::date, (date_trunc('week', v_hoje::timestamp) + interval '6 days')::date),
      ('mes', date_trunc('month', v_hoje::timestamp)::date, (date_trunc('month', v_hoje::timestamp) + interval '1 month - 1 day')::date),
      ('ano', make_date(extract(year from v_hoje)::int, 1, 1), make_date(extract(year from v_hoje)::int, 12, 31)),
      ('total', '0001-01-01'::date, '9999-12-31'::date)
    ) as periodos(chave, de, ate)
  loop
    select count(*) as agendamentos,
           coalesce(sum(a.valor_total - a.valor_ajuste - a.valor_produtos), 0) as servicos,
           coalesce(sum(a.valor_produtos), 0) as produtos,
           coalesce(sum(greatest(a.valor_ajuste, 0)), 0) as adicionais,
           coalesce(sum(greatest(-a.valor_ajuste, 0)), 0) as descontos,
           coalesce(sum(a.valor_total), 0) as total,
           coalesce(sum((select sum(r.valor) from recebimentos_agendamento r where r.agendamento_id = a.id)), 0) as pago
      into v_r
      from agendamentos a
     where a.status = 'confirmado' and a.data between v_p.de and v_p.ate;

    -- vendas avulsas (balcão, sem agendamento) entram como produtos e já estão pagas
    select count(*) as vendas, coalesce(sum(valor_total), 0) as total,
           coalesce(sum(valor_total) filter (where forma = 'dinheiro'), 0) as dinheiro,
           coalesce(sum(valor_total) filter (where forma = 'pix'), 0) as pix,
           coalesce(sum(valor_total) filter (where forma = 'cartao'), 0) as cartao,
           coalesce(sum(valor_total) filter (where forma = 'outro'), 0) as outro
      into v_av
      from vendas_avulsas
     where status = 'ativa' and data between v_p.de and v_p.ate;

    -- devoluções de agendamentos cancelados saem da forma em que o cliente pagou
    select coalesce(sum(valor), 0) as total,
           coalesce(sum(valor) filter (where forma = 'dinheiro'), 0) as dinheiro,
           coalesce(sum(valor) filter (where forma = 'pix'), 0) as pix,
           coalesce(sum(valor) filter (where forma = 'cartao'), 0) as cartao,
           coalesce(sum(valor) filter (where forma = 'outro'), 0) as outro
      into v_es
      from estornos
     where timezone('America/Sao_Paulo', criado_em)::date between v_p.de and v_p.ate;

    select jsonb_build_object(
             'dinheiro', coalesce(sum(valor) filter (where forma = 'dinheiro'), 0) + v_av.dinheiro - v_es.dinheiro,
             'pix', coalesce(sum(valor) filter (where forma = 'pix'), 0) + v_av.pix - v_es.pix,
             'cartao', coalesce(sum(valor) filter (where forma = 'cartao'), 0) + v_av.cartao - v_es.cartao,
             'outro', coalesce(sum(valor) filter (where forma = 'outro'), 0) + v_av.outro - v_es.outro)
      into v_formas
      from recebimentos_agendamento
     where timezone('America/Sao_Paulo', recebido_em)::date between v_p.de and v_p.ate;

    select coalesce(jsonb_agg(jsonb_build_object('nome', x.nome, 'quantidade', x.quantidade, 'valor', x.valor)
                    order by x.quantidade desc, x.nome), '[]'::jsonb)
      into v_ranking
      from (select ags.nome, count(*) as quantidade, coalesce(sum(ags.preco), 0) as valor
              from agendamento_servicos ags join agendamentos a on a.id = ags.agendamento_id
             where a.status = 'confirmado' and a.data between v_p.de and v_p.ate
             group by ags.nome order by count(*) desc, ags.nome limit 5) x;

    v_resumo := v_resumo || jsonb_build_object(v_p.chave, jsonb_build_object(
      'de', v_p.de, 'ate', v_p.ate,
      'agendamentos', v_r.agendamentos, 'servicos', v_r.servicos, 'produtos', v_r.produtos + v_av.total,
      'vendas_avulsas', v_av.vendas, 'valor_avulsas', v_av.total,
      'adicionais', v_r.adicionais, 'descontos', v_r.descontos, 'total', v_r.total + v_av.total,
      'a_receber', greatest(v_r.total - v_r.pago, 0),
      'ticket_medio', case when v_r.agendamentos > 0 then round(v_r.total / v_r.agendamentos, 2) else 0 end,
      'recebido', (v_formas->>'dinheiro')::numeric + (v_formas->>'pix')::numeric + (v_formas->>'cartao')::numeric + (v_formas->>'outro')::numeric,
      'devolvido', v_es.total,
      'por_forma', v_formas,
      'servicos_mais_vendidos', v_ranking));
  end loop;
  return v_resumo;
end;
$$;

-- Cancela e devolve ao estoque os produtos vendidos na comanda.
-- p_devolver = true: devolve ao cliente o que ele pagou (um estorno por forma, no caixa de hoje).
drop function if exists public.cancelar_agendamento(bigint);
create or replace function public.cancelar_agendamento(p_agendamento_id bigint, p_devolver boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_ag agendamentos%rowtype;
  v_it record;
  v_devolvidos int := 0;
  v_estornado numeric(10,2) := 0;
begin
  if not public.is_admin() then raise exception 'NAO_AUTORIZADO' using errcode = '42501'; end if;
  select * into v_ag from agendamentos where id = p_agendamento_id for update;
  if not found then raise exception 'AGENDAMENTO_NAO_ENCONTRADO' using errcode = 'P0002'; end if;
  if v_ag.status = 'confirmado' then
    update agendamentos set status = 'cancelado' where id = p_agendamento_id;
    if coalesce(p_devolver, false) then
      if exists (select 1 from recebimentos_agendamento where agendamento_id = p_agendamento_id and forma = 'dinheiro')
         and exists (select 1 from caixas_diarios where data = (now() at time zone 'America/Sao_Paulo')::date and status = 'fechado') then
        raise exception 'CAIXA_JA_FECHADO' using errcode = '23505';
      end if;
      insert into estornos (agendamento_id, valor, forma)
        select p_agendamento_id, sum(valor), forma from recebimentos_agendamento
         where agendamento_id = p_agendamento_id group by forma;
      select coalesce(sum(valor), 0) into v_estornado from estornos where agendamento_id = p_agendamento_id;
    end if;
    for v_it in select produto_id, quantidade from agendamento_produtos where agendamento_id = p_agendamento_id and produto_id is not null loop
      update produtos set estoque = estoque + v_it.quantidade where id = v_it.produto_id;
      insert into movimentos_estoque (produto_id, quantidade, tipo, motivo, agendamento_id)
        values (v_it.produto_id, v_it.quantidade, 'entrada', 'Devolução: agendamento ' || v_ag.codigo || ' cancelado', p_agendamento_id);
      v_devolvidos := v_devolvidos + v_it.quantidade;
    end loop;
  end if;
  return jsonb_build_object('ok', true, 'produtos_devolvidos', v_devolvidos, 'valor_estornado', v_estornado);
end;
$$;
revoke all on function public.cancelar_agendamento(bigint, boolean) from public;
grant execute on function public.cancelar_agendamento(bigint, boolean) to authenticated;
