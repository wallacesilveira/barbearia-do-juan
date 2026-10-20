-- =====================================================================
-- Barbearia do Juan — dinheiro não entra com o caixa de hoje já fechado
-- (pagamento de comanda e venda avulsa). Pix, cartão e outro continuam liberados.
-- Banco que já existe: cole este arquivo em Supabase > SQL Editor > New query > Run.
-- Pode rodar mais de uma vez sem problema. (O schema.sql completo já inclui tudo isto.)
-- =====================================================================

-- Dinheiro não entra numa gaveta já conferida: com o caixa de hoje fechado, só pix/cartão/outro.
create or replace function public.exigir_caixa_nao_fechado() returns void
language plpgsql security definer stable set search_path = public as $$
begin
  if exists (select 1 from caixas_diarios where data = (now() at time zone 'America/Sao_Paulo')::date and status = 'fechado') then
    raise exception 'CAIXA_FECHADO_DINHEIRO' using errcode = '23505';
  end if;
end;
$$;
revoke all on function public.exigir_caixa_nao_fechado() from public, anon, authenticated;

create or replace function public.registrar_recebimento(p_agendamento_id bigint, p_valor numeric, p_forma text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_ag agendamentos%rowtype;
  v_pago numeric;
  v_recebimento recebimentos_agendamento%rowtype;
begin
  if not public.is_admin() then raise exception 'NAO_AUTORIZADO' using errcode = '42501'; end if;
  if p_valor is null or p_valor <= 0 or p_valor <> round(p_valor, 2)
     or p_forma not in ('dinheiro','pix','cartao','outro') then
    raise exception 'RECEBIMENTO_INVALIDO' using errcode = '22023';
  end if;
  select * into v_ag from agendamentos where id = p_agendamento_id and status = 'confirmado' for update;
  if not found then raise exception 'AGENDAMENTO_NAO_ENCONTRADO' using errcode = 'P0002'; end if;
  select coalesce(sum(valor), 0) into v_pago from recebimentos_agendamento where agendamento_id = p_agendamento_id;
  if p_valor > v_ag.valor_total - v_pago then raise exception 'RECEBIMENTO_EXCEDE_SALDO' using errcode = '22023'; end if;
  if p_forma = 'dinheiro' then perform public.exigir_caixa_nao_fechado(); end if;
  insert into recebimentos_agendamento (agendamento_id, valor, forma)
    values (p_agendamento_id, p_valor, p_forma) returning * into v_recebimento;
  return to_jsonb(v_recebimento);
end;
$$;

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
  if p_forma = 'dinheiro' then perform public.exigir_caixa_nao_fechado(); end if;
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

