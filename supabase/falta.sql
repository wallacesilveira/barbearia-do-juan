-- =====================================================================
-- Barbearia do Juan — marcar falta (cliente não apareceu)
-- Banco que já existe: rode ANTES o estornos.sql e depois cole este arquivo em
-- Supabase > SQL Editor > New query > Run. Pode rodar mais de uma vez sem problema.
-- (O schema.sql completo já inclui tudo isto.)
-- =====================================================================

-- contato do cliente (e-mail e aniversário): o resumo de clientes abaixo lê essas colunas
alter table clientes add column if not exists email text not null default '';
alter table clientes add column if not exists aniversario date;

-- novo status 'falta': não conta como visita nem faturamento e não ocupa a agenda
do $$
declare r record;
begin
  -- remove a regra antiga de status, qualquer que seja o nome dela
  for r in select conname from pg_constraint
            where conrelid = 'public.agendamentos'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%status%' loop
    execute format('alter table agendamentos drop constraint %I', r.conname);
  end loop;
end $$;
alter table agendamentos add constraint agendamentos_status_check check (status in ('confirmado','cancelado','falta'));

-- Encerra um agendamento confirmado (cancelado ou falta): produtos voltam ao estoque e,
-- com p_devolver = true, devolve ao cliente o que ele pagou (um estorno por forma, no caixa de hoje).
create or replace function public.encerrar_agendamento(p_agendamento_id bigint, p_devolver boolean, p_status text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_ag agendamentos%rowtype;
  v_it record;
  v_devolvidos int := 0;
  v_estornado numeric(10,2) := 0;
  v_agora timestamp := now() at time zone 'America/Sao_Paulo';
begin
  if not public.is_admin() then raise exception 'NAO_AUTORIZADO' using errcode = '42501'; end if;
  if p_status not in ('cancelado','falta') then raise exception 'DADOS_INVALIDOS' using errcode = '22023'; end if;
  select * into v_ag from agendamentos where id = p_agendamento_id for update;
  if not found then raise exception 'AGENDAMENTO_NAO_ENCONTRADO' using errcode = 'P0002'; end if;
  if p_status = 'falta' then
    if v_ag.status <> 'confirmado' then raise exception 'AGENDAMENTO_CANCELADO' using errcode = '22023'; end if;
    if v_ag.data > v_agora::date or (v_ag.data = v_agora::date
       and v_ag.inicio_min > extract(hour from v_agora)::int * 60 + extract(minute from v_agora)::int) then
      raise exception 'AINDA_NAO_COMECOU' using errcode = '22023';
    end if;
  end if;
  if v_ag.status = 'confirmado' then
    update agendamentos set status = p_status where id = p_agendamento_id;
    if coalesce(p_devolver, false) then
      if exists (select 1 from recebimentos_agendamento where agendamento_id = p_agendamento_id and forma = 'dinheiro')
         and exists (select 1 from caixas_diarios where data = v_agora::date and status = 'fechado') then
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
        values (v_it.produto_id, v_it.quantidade, 'entrada',
                'Devolução: agendamento ' || v_ag.codigo || case when p_status = 'falta' then ' com falta' else ' cancelado' end, p_agendamento_id);
      v_devolvidos := v_devolvidos + v_it.quantidade;
    end loop;
  end if;
  return jsonb_build_object('ok', true, 'produtos_devolvidos', v_devolvidos, 'valor_estornado', v_estornado);
end;
$$;
revoke all on function public.encerrar_agendamento(bigint, boolean, text) from public, anon, authenticated;

-- Cancela e devolve ao estoque os produtos vendidos na comanda.
-- p_devolver = true: devolve ao cliente o que ele pagou (um estorno por forma, no caixa de hoje).
create or replace function public.cancelar_agendamento(p_agendamento_id bigint, p_devolver boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  return public.encerrar_agendamento(p_agendamento_id, p_devolver, 'cancelado');
end;
$$;

-- Marca falta: só depois que o horário começou.
create or replace function public.marcar_falta(p_agendamento_id bigint, p_devolver boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  return public.encerrar_agendamento(p_agendamento_id, p_devolver, 'falta');
end;
$$;
revoke all on function public.marcar_falta(bigint, boolean) from public, anon;
grant execute on function public.marcar_falta(bigint, boolean) to authenticated;

-- Clientes: visita = agendamento confirmado cuja data já chegou. Inclui faltas e movimento por dia da semana.
create or replace function public.clientes_resumo() returns jsonb
language plpgsql security definer stable set search_path = public as $$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_clientes jsonb;
  v_semana jsonb;
begin
  if not public.is_admin() then raise exception 'NAO_AUTORIZADO' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.visitas desc, x.total_gasto desc, lower(x.nome)), '[]'::jsonb) into v_clientes
    from (select c.id, c.nome, c.whatsapp, c.email, c.aniversario, c.criado_em,
                 count(a.id) filter (where a.status = 'confirmado' and a.data <= v_hoje) as visitas,
                 count(a.id) filter (where a.status = 'confirmado' and a.data > v_hoje) as futuros,
                 coalesce(sum(a.valor_total) filter (where a.status = 'confirmado' and a.data <= v_hoje), 0) as total_gasto,
                 max(a.data) filter (where a.status = 'confirmado' and a.data <= v_hoje) as ultima_visita,
                 min(a.data) filter (where a.status = 'confirmado' and a.data > v_hoje) as proxima_visita,
                 count(a.id) filter (where a.status = 'falta') as faltas
            from clientes c left join agendamentos a on a.cliente_id = c.id
           group by c.id) x;
  select jsonb_agg(jsonb_build_object('dia', d, 'agendamentos',
           (select count(*) from agendamentos a where a.status = 'confirmado' and a.data <= v_hoje and extract(dow from a.data)::int = d)) order by d)
    into v_semana from generate_series(0, 6) d;
  return jsonb_build_object('clientes', v_clientes, 'semana', v_semana,
    'abertos', (select coalesce(jsonb_agg(dia_semana), '[]'::jsonb) from horarios_funcionamento where ativo));
end;
$$;
