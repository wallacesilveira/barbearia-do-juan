-- =====================================================================
-- Barbearia do Juan — vendas avulsas (produto vendido no balcão, sem agendamento)
-- Banco que já existe: cole este arquivo em Supabase > SQL Editor > New query > Run.
-- Pode rodar mais de uma vez sem problema. (O schema.sql completo já inclui tudo isto.)
-- =====================================================================

create table if not exists vendas_avulsas (
  id bigint generated always as identity primary key,
  data date not null default (now() at time zone 'America/Sao_Paulo')::date,
  cliente_id bigint references clientes(id) on delete set null,
  cliente_nome text not null default '',
  valor_total numeric(10,2) not null check (valor_total >= 0),
  forma text not null check (forma in ('dinheiro','pix','cartao','outro')),
  status text not null default 'ativa' check (status in ('ativa','cancelada')),
  criado_em timestamptz not null default now(),
  cancelada_em timestamptz
);
create index if not exists idx_vendas_avulsas_data on vendas_avulsas (data, status);
create table if not exists vendas_avulsas_itens (
  id bigint generated always as identity primary key,
  venda_id bigint not null references vendas_avulsas(id) on delete cascade,
  produto_id bigint references produtos(id) on delete set null,
  nome text not null,
  quantidade int not null check (quantidade > 0),
  preco_unitario numeric(10,2) not null check (preco_unitario >= 0),
  valor_total numeric(10,2) not null check (valor_total >= 0)
);
create index if not exists idx_vendas_avulsas_itens on vendas_avulsas_itens (venda_id, id);

alter table vendas_avulsas enable row level security;
alter table vendas_avulsas_itens enable row level security;
drop policy if exists adm_vendas_avulsas on vendas_avulsas;
create policy adm_vendas_avulsas on vendas_avulsas for all using (is_admin()) with check (is_admin());
drop policy if exists adm_vendas_avulsas_itens on vendas_avulsas_itens;
create policy adm_vendas_avulsas_itens on vendas_avulsas_itens for all using (is_admin()) with check (is_admin());
grant select, insert, update, delete on vendas_avulsas, vendas_avulsas_itens to authenticated;
revoke all on vendas_avulsas, vendas_avulsas_itens from anon;

-- Dinheiro que entrou na gaveta no dia: pagamentos de comandas + vendas avulsas.
create or replace function public.dinheiro_do_dia(p_data date) returns numeric
language sql security definer stable set search_path = public as $$
  select coalesce((select sum(valor) from recebimentos_agendamento
                    where forma = 'dinheiro' and timezone('America/Sao_Paulo', recebido_em)::date = p_data), 0)
       + coalesce((select sum(valor_total) from vendas_avulsas
                    where forma = 'dinheiro' and status = 'ativa' and data = p_data), 0);
$$;
revoke all on function public.dinheiro_do_dia(date) from public, anon, authenticated;

create or replace function public.venda_avulsa_json(p_id bigint) returns jsonb
language sql security definer stable set search_path = public as $$
  select to_jsonb(v) || jsonb_build_object('itens', coalesce((
           select jsonb_agg(jsonb_build_object('produto_id', i.produto_id, 'nome', i.nome, 'quantidade', i.quantidade,
                                               'preco_unitario', i.preco_unitario, 'valor_total', i.valor_total) order by i.id)
             from vendas_avulsas_itens i where i.venda_id = v.id), '[]'::jsonb))
    from vendas_avulsas v where v.id = p_id;
$$;
revoke all on function public.venda_avulsa_json(bigint) from public, anon, authenticated;

create or replace function public.listar_vendas_avulsas(p_data date) returns jsonb
language plpgsql security definer stable set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'NAO_AUTORIZADO' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(public.venda_avulsa_json(id) order by id desc) from vendas_avulsas where data = p_data), '[]'::jsonb);
end;
$$;

-- p_itens: [{"produto_id": 1, "quantidade": 2}, ...]
create or replace function public.registrar_venda_avulsa(p_itens jsonb, p_forma text, p_cliente_id bigint default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_cliente clientes%rowtype;
  v_item record;
  v_produto produtos%rowtype;
  v_venda_id bigint;
  v_total numeric(10,2) := 0;
begin
  if not public.is_admin() then raise exception 'NAO_AUTORIZADO' using errcode = '42501'; end if;
  if p_forma is null or p_forma not in ('dinheiro','pix','cartao','outro')
     or p_itens is null or jsonb_typeof(p_itens) <> 'array' or jsonb_array_length(p_itens) = 0 or jsonb_array_length(p_itens) > 50 then
    raise exception 'DADOS_INVALIDOS' using errcode = '22023';
  end if;
  if p_cliente_id is not null then
    select * into v_cliente from clientes where id = p_cliente_id;
    if not found then raise exception 'CLIENTE_NAO_ENCONTRADO' using errcode = 'P0002'; end if;
  end if;
  insert into vendas_avulsas (cliente_id, cliente_nome, valor_total, forma)
    values (p_cliente_id, coalesce(v_cliente.nome, ''), 0, p_forma)
    returning id into v_venda_id;
  -- soma quantidades repetidas do mesmo produto antes de conferir o estoque
  for v_item in
    select (e->>'produto_id')::bigint as produto_id, sum((e->>'quantidade')::int) as quantidade
      from jsonb_array_elements(p_itens) e group by 1 order by 1
  loop
    if v_item.produto_id is null or v_item.quantidade is null or v_item.quantidade < 1 then
      raise exception 'DADOS_INVALIDOS' using errcode = '22023';
    end if;
    select * into v_produto from produtos where id = v_item.produto_id and ativo for update;
    if not found then raise exception 'PRODUTO_NAO_ENCONTRADO' using errcode = 'P0002'; end if;
    if v_produto.estoque < v_item.quantidade then raise exception 'ESTOQUE_INSUFICIENTE' using errcode = '22023'; end if;
    update produtos set estoque = estoque - v_item.quantidade where id = v_produto.id;
    insert into vendas_avulsas_itens (venda_id, produto_id, nome, quantidade, preco_unitario, valor_total)
      values (v_venda_id, v_produto.id, v_produto.nome, v_item.quantidade, v_produto.preco, round(v_produto.preco * v_item.quantidade, 2));
    insert into movimentos_estoque (produto_id, quantidade, tipo, motivo)
      values (v_produto.id, -v_item.quantidade, 'venda', 'Venda avulsa nº ' || v_venda_id);
    v_total := v_total + round(v_produto.preco * v_item.quantidade, 2);
    perform public.alerta_estoque(v_produto.id);
  end loop;
  update vendas_avulsas set valor_total = v_total where id = v_venda_id;
  return public.venda_avulsa_json(v_venda_id);
end;
$$;

create or replace function public.cancelar_venda_avulsa(p_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_venda vendas_avulsas%rowtype;
  v_item record;
  v_devolvidos int := 0;
begin
  if not public.is_admin() then raise exception 'NAO_AUTORIZADO' using errcode = '42501'; end if;
  select * into v_venda from vendas_avulsas where id = p_id for update;
  if not found then raise exception 'VENDA_NAO_ENCONTRADA' using errcode = 'P0002'; end if;
  if v_venda.status <> 'ativa' then raise exception 'VENDA_JA_CANCELADA' using errcode = '23505'; end if;
  if exists (select 1 from caixas_diarios where data = v_venda.data and status = 'fechado') then
    raise exception 'CAIXA_JA_FECHADO' using errcode = '23505';
  end if;
  update vendas_avulsas set status = 'cancelada', cancelada_em = now() where id = p_id;
  for v_item in select produto_id, quantidade from vendas_avulsas_itens where venda_id = p_id and produto_id is not null loop
    update produtos set estoque = estoque + v_item.quantidade where id = v_item.produto_id;
    insert into movimentos_estoque (produto_id, quantidade, tipo, motivo)
      values (v_item.produto_id, v_item.quantidade, 'entrada', 'Devolução: venda avulsa nº ' || p_id || ' cancelada');
    v_devolvidos := v_devolvidos + v_item.quantidade;
  end loop;
  return jsonb_build_object('ok', true, 'produtos_devolvidos', v_devolvidos);
end;
$$;
revoke all on function public.listar_vendas_avulsas(date) from public, anon;
revoke all on function public.registrar_venda_avulsa(jsonb, text, bigint) from public, anon;
revoke all on function public.cancelar_venda_avulsa(bigint) from public, anon;
grant execute on function public.listar_vendas_avulsas(date) to authenticated;
grant execute on function public.registrar_venda_avulsa(jsonb, text, bigint) to authenticated;
grant execute on function public.cancelar_venda_avulsa(bigint) to authenticated;

-- ------------------------------------------- caixa: passa a contar as vendas avulsas
create or replace function public.caixa_resumo() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_p record;
  v_r record;
  v_av record;
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

    select jsonb_build_object(
             'dinheiro', coalesce(sum(valor) filter (where forma = 'dinheiro'), 0) + v_av.dinheiro,
             'pix', coalesce(sum(valor) filter (where forma = 'pix'), 0) + v_av.pix,
             'cartao', coalesce(sum(valor) filter (where forma = 'cartao'), 0) + v_av.cartao,
             'outro', coalesce(sum(valor) filter (where forma = 'outro'), 0) + v_av.outro)
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
      'por_forma', v_formas,
      'servicos_mais_vendidos', v_ranking));
  end loop;
  return v_resumo;
end;
$$;

create or replace function public.caixa_diario_resumo(p_data date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_caixa caixas_diarios%rowtype;
  v_recebido numeric(10,2);
  v_esperado numeric(10,2);
begin
  if not public.is_admin() then raise exception 'NAO_AUTORIZADO' using errcode = '42501'; end if;
  if p_data is null then raise exception 'DATA_INVALIDA' using errcode = '22023'; end if;
  select * into v_caixa from caixas_diarios where data = p_data;
  v_recebido := public.dinheiro_do_dia(p_data);
  if v_caixa.data is not null then v_esperado := v_caixa.valor_abertura + v_recebido; end if;
  return jsonb_build_object(
    'data', p_data,
    'status', coalesce(v_caixa.status, 'nao_aberto'),
    'valor_abertura', v_caixa.valor_abertura,
    'recebido_dinheiro', v_recebido,
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
  v_esperado := v_caixa.valor_abertura + public.dinheiro_do_dia(p_data);
  update caixas_diarios
     set valor_contado = round(p_valor_contado, 2), diferenca = round(p_valor_contado, 2) - v_esperado,
         status = 'fechado', fechado_em = now()
   where data = p_data;
  return public.caixa_diario_resumo(p_data);
end;
$$;
