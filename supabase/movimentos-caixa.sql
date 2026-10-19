-- =====================================================================
-- Barbearia do Juan — sangria, despesas e reforço no caixa do dia
-- Banco que já existe: rode ANTES o estornos.sql e depois cole este arquivo em
-- Supabase > SQL Editor > New query > Run. Pode rodar mais de uma vez sem problema.
-- (O schema.sql completo já inclui tudo isto.)
-- =====================================================================

create table if not exists movimentos_caixa (
  id bigint generated always as identity primary key,
  data date not null default (now() at time zone 'America/Sao_Paulo')::date,
  tipo text not null check (tipo in ('sangria','despesa','reforco')),
  valor numeric(10,2) not null check (valor > 0),
  forma text not null default 'dinheiro' check (forma in ('dinheiro','pix','cartao','outro')),
  descricao text not null default '',
  criado_em timestamptz not null default now()
);
create index if not exists idx_movimentos_caixa_data on movimentos_caixa (data);

alter table movimentos_caixa enable row level security;
drop policy if exists adm_movimentos_caixa on movimentos_caixa;
create policy adm_movimentos_caixa on movimentos_caixa for all using (is_admin()) with check (is_admin());
grant select, insert, update, delete on movimentos_caixa to authenticated;
revoke all on movimentos_caixa from anon;

-- Conta da gaveta: troco + entradas em dinheiro + reforços − devoluções − sangrias − despesas em dinheiro.
create or replace function public.conta_gaveta(p_data date) returns jsonb
language plpgsql security definer stable set search_path = public as $$
declare
  v_abertura numeric(10,2);
  v_recebido numeric(10,2) := public.dinheiro_do_dia(p_data);
  v_devolvido numeric(10,2) := public.devolvido_do_dia(p_data);
  v_sangrias numeric(10,2);
  v_despesas numeric(10,2);
  v_reforcos numeric(10,2);
  v_movs jsonb;
begin
  select valor_abertura into v_abertura from caixas_diarios where data = p_data;
  select coalesce(sum(valor) filter (where tipo = 'sangria'), 0),
         coalesce(sum(valor) filter (where tipo = 'despesa' and forma = 'dinheiro'), 0),
         coalesce(sum(valor) filter (where tipo = 'reforco'), 0),
         coalesce(jsonb_agg(jsonb_build_object('id', id, 'tipo', tipo, 'valor', valor, 'forma', forma,
                                               'descricao', descricao, 'criado_em', criado_em) order by id), '[]'::jsonb)
    into v_sangrias, v_despesas, v_reforcos, v_movs
    from movimentos_caixa where data = p_data;
  return jsonb_build_object(
    'recebido_dinheiro', v_recebido,
    'devolvido_dinheiro', v_devolvido,
    'sangrias', v_sangrias,
    'despesas_dinheiro', v_despesas,
    'reforcos', v_reforcos,
    'saidas_dinheiro', v_devolvido + v_sangrias + v_despesas,
    'valor_esperado', v_abertura + v_recebido + v_reforcos - v_devolvido - v_sangrias - v_despesas,
    'movimentos', v_movs);
end;
$$;
revoke all on function public.conta_gaveta(date) from public, anon, authenticated;

create or replace function public.caixa_diario_resumo(p_data date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_caixa caixas_diarios%rowtype;
begin
  if not public.is_admin() then raise exception 'NAO_AUTORIZADO' using errcode = '42501'; end if;
  if p_data is null then raise exception 'DATA_INVALIDA' using errcode = '22023'; end if;
  select * into v_caixa from caixas_diarios where data = p_data;
  return public.conta_gaveta(p_data) || jsonb_build_object(
    'data', p_data,
    'status', coalesce(v_caixa.status, 'nao_aberto'),
    'valor_abertura', v_caixa.valor_abertura,
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
  v_esperado := (public.conta_gaveta(p_data)->>'valor_esperado')::numeric;
  update caixas_diarios
     set valor_contado = round(p_valor_contado, 2), diferenca = round(p_valor_contado, 2) - v_esperado,
         status = 'fechado', fechado_em = now()
   where data = p_data;
  return public.caixa_diario_resumo(p_data);
end;
$$;

-- Lança sangria, despesa ou reforço no caixa de hoje.
create or replace function public.registrar_movimento_caixa(p_tipo text, p_valor numeric, p_forma text default 'dinheiro', p_descricao text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_forma text := case when p_tipo = 'despesa' then coalesce(p_forma, 'dinheiro') else 'dinheiro' end;
  v_desc text := left(btrim(coalesce(p_descricao, '')), 120);
  v_caixa caixas_diarios%rowtype;
begin
  if not public.is_admin() then raise exception 'NAO_AUTORIZADO' using errcode = '42501'; end if;
  if p_tipo is null or p_tipo not in ('sangria','despesa','reforco') or v_forma not in ('dinheiro','pix','cartao','outro')
     or p_valor is null or p_valor <= 0 or p_valor <> round(p_valor, 2) then
    raise exception 'DADOS_INVALIDOS' using errcode = '22023';
  end if;
  if p_tipo = 'despesa' and v_desc = '' then raise exception 'DESCRICAO_OBRIGATORIA' using errcode = '22023'; end if;
  if v_forma = 'dinheiro' then
    select * into v_caixa from caixas_diarios where data = v_hoje for update;
    if not found then raise exception 'CAIXA_NAO_ABERTO' using errcode = 'P0002'; end if;
    if v_caixa.status = 'fechado' then raise exception 'CAIXA_JA_FECHADO' using errcode = '23505'; end if;
    if p_tipo <> 'reforco' and p_valor > (public.conta_gaveta(v_hoje)->>'valor_esperado')::numeric then
      raise exception 'SALDO_GAVETA_INSUFICIENTE' using errcode = '22023';
    end if;
  end if;
  insert into movimentos_caixa (data, tipo, valor, forma, descricao) values (v_hoje, p_tipo, p_valor, v_forma, v_desc);
  return public.caixa_diario_resumo(v_hoje);
end;
$$;

create or replace function public.excluir_movimento_caixa(p_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_mv movimentos_caixa%rowtype;
begin
  if not public.is_admin() then raise exception 'NAO_AUTORIZADO' using errcode = '42501'; end if;
  select * into v_mv from movimentos_caixa where id = p_id for update;
  if not found then raise exception 'MOVIMENTO_NAO_ENCONTRADO' using errcode = 'P0002'; end if;
  if exists (select 1 from caixas_diarios where data = v_mv.data and status = 'fechado') then
    raise exception 'CAIXA_JA_FECHADO' using errcode = '23505';
  end if;
  delete from movimentos_caixa where id = p_id;
  return public.caixa_diario_resumo(v_mv.data);
end;
$$;
revoke all on function public.registrar_movimento_caixa(text, numeric, text, text) from public, anon;
revoke all on function public.excluir_movimento_caixa(bigint) from public, anon;
grant execute on function public.registrar_movimento_caixa(text, numeric, text, text) to authenticated;
grant execute on function public.excluir_movimento_caixa(bigint) to authenticated;

create or replace function public.caixa_resumo() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_p record;
  v_r record;
  v_av record;
  v_es record;
  v_despesas numeric(10,2);
  v_recebido numeric(10,2);
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
    v_recebido := (v_formas->>'dinheiro')::numeric + (v_formas->>'pix')::numeric + (v_formas->>'cartao')::numeric + (v_formas->>'outro')::numeric;

    select coalesce(sum(valor), 0) into v_despesas
      from movimentos_caixa where tipo = 'despesa' and data between v_p.de and v_p.ate;

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
      'recebido', v_recebido,
      'devolvido', v_es.total,
      'despesas', v_despesas,
      'saldo', v_recebido - v_despesas,
      'por_forma', v_formas,
      'servicos_mais_vendidos', v_ranking));
  end loop;
  return v_resumo;
end;
$$;
