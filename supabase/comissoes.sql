-- =====================================================================
-- Barbearia do Juan — comissões, aluguel de cadeira, vales e fechamento por barbeiro
-- Contratos com histórico (dono, comissão com fixo opcional, aluguel recebendo pelo caixa ou direto),
-- vales e pagamentos de barbeiro no caixa, e o fechamento do período.
-- Banco que já existe: rode ANTES barbeiros.sql, movimentos-caixa.sql, caixa-fechado.sql e falta.sql;
-- depois cole este arquivo em Supabase > SQL Editor > New query > Run. Pode rodar mais de uma vez.
-- (O schema.sql completo já inclui tudo isto.)
-- ATENÇÃO: se rodar de novo depois algum daqueles arquivos, rode este outra vez em seguida
-- (eles atualizam as mesmas funções do caixa).
-- =====================================================================

-- Contratos dos barbeiros (histórico): cada atendimento é calculado pelo contrato que valia na data dele.
create table if not exists profissional_contratos (
  id bigint generated always as identity primary key,
  profissional_id bigint not null references profissionais(id) on delete cascade,
  vigente_desde date not null,
  tipo text not null check (tipo in ('dono','comissao','aluguel')),
  comissao_servicos numeric(5,2) not null default 0 check (comissao_servicos between 0 and 100),
  comissao_produtos numeric(5,2) not null default 0 check (comissao_produtos between 0 and 100),
  valor_fixo numeric(10,2) not null default 0 check (valor_fixo >= 0),
  aluguel_valor numeric(10,2) not null default 0 check (aluguel_valor >= 0),
  aluguel_periodo text not null default 'mes' check (aluguel_periodo in ('semana','mes')),
  recebimento text not null default 'caixa' check (recebimento in ('caixa','barbeiro')),
  criado_em timestamptz not null default now(),
  unique (profissional_id, vigente_desde)
);
-- contrato inicial: o primeiro barbeiro é o dono; os outros, comissão (vale para todo o histórico)
insert into profissional_contratos (profissional_id, vigente_desde, tipo, comissao_servicos, comissao_produtos)
select p.id, '2000-01-01', case when p.id = (select id from profissionais order by ordem, id limit 1) then 'dono' else 'comissao' end,
       p.comissao_servicos, p.comissao_produtos
  from profissionais p
 where not exists (select 1 from profissional_contratos);

-- Fechamentos de comissão/aluguel: o extrato do período e o valor pago (ou recebido) do barbeiro.
create table if not exists fechamentos (
  id bigint generated always as identity primary key,
  profissional_id bigint not null references profissionais(id),
  de date not null,
  ate date not null check (ate >= de),
  atendimentos int not null default 0,
  servicos numeric(10,2) not null default 0,
  produtos numeric(10,2) not null default 0,
  parte numeric(10,2) not null default 0,
  fixo numeric(10,2) not null default 0,
  aluguel numeric(10,2) not null default 0,
  recebido_profissional numeric(10,2) not null default 0,
  vales numeric(10,2) not null default 0,
  total numeric(10,2) not null,
  forma text not null default 'dinheiro' check (forma in ('dinheiro','pix','cartao','outro')),
  observacao text not null default '',
  criado_em timestamptz not null default now()
);
create index if not exists idx_fechamentos_prof on fechamentos (profissional_id, de, ate);

-- quem recebeu cada pagamento (o barbeiro de aluguel pode receber direto)
alter table recebimentos_agendamento add column if not exists recebido_por text not null default 'barbearia';
alter table recebimentos_agendamento drop constraint if exists recebimentos_agendamento_recebido_por_check;
alter table recebimentos_agendamento add constraint recebimentos_agendamento_recebido_por_check check (recebido_por in ('barbearia','profissional'));
-- lançamentos de caixa ligados a barbeiro: vale (adiantamento), repasse (pagamento) e acerto (o barbeiro paga)
alter table movimentos_caixa add column if not exists profissional_id bigint references profissionais(id);
alter table movimentos_caixa add column if not exists fechamento_id bigint references fechamentos(id) on delete set null;
do $$
declare r record;
begin
  for r in select conname from pg_constraint
            where conrelid = 'public.movimentos_caixa'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%tipo%' loop
    execute format('alter table movimentos_caixa drop constraint %I', r.conname);
  end loop;
end $$;
alter table movimentos_caixa add constraint movimentos_caixa_tipo_check check (tipo in ('sangria','despesa','reforco','vale','repasse','acerto'));
create index if not exists idx_movimentos_caixa_prof on movimentos_caixa (profissional_id, fechamento_id);

alter table profissional_contratos enable row level security;
alter table fechamentos enable row level security;
drop policy if exists adm_profissional_contratos on profissional_contratos;
create policy adm_profissional_contratos on profissional_contratos for all using (is_admin()) with check (is_admin());
drop policy if exists adm_fechamentos on fechamentos;
create policy adm_fechamentos on fechamentos for all using (is_admin()) with check (is_admin());
grant select, insert, update, delete on profissional_contratos, fechamentos to authenticated;
revoke all on profissional_contratos, fechamentos from anon;

-- Quem fica com o pagamento do cliente: o barbeiro de aluguel que recebe direto, ou a barbearia.
create or replace function public.recebido_por(p_profissional_id bigint) returns text
language sql security definer stable set search_path = public as $$
  select coalesce((
    select case when c.tipo = 'aluguel' and c.recebimento = 'barbeiro' then 'profissional' else 'barbearia' end
      from profissional_contratos c
     where c.profissional_id = p_profissional_id and c.vigente_desde <= (now() at time zone 'America/Sao_Paulo')::date
     order by c.vigente_desde desc limit 1), 'barbearia');
$$;
revoke all on function public.recebido_por(bigint) from public, anon, authenticated;

create or replace function public.dinheiro_do_dia(p_data date) returns numeric
language sql security definer stable set search_path = public as $$
  select coalesce((select sum(valor) from recebimentos_agendamento
                    where forma = 'dinheiro' and recebido_por = 'barbearia' and timezone('America/Sao_Paulo', recebido_em)::date = p_data), 0)
       + coalesce((select sum(valor_total) from vendas_avulsas
                    where forma = 'dinheiro' and status = 'ativa' and data = p_data), 0);
$$;

create or replace function public.conta_gaveta(p_data date) returns jsonb
language plpgsql security definer stable set search_path = public as $$
declare
  v_abertura numeric(10,2);
  v_recebido numeric(10,2) := public.dinheiro_do_dia(p_data);
  v_devolvido numeric(10,2) := public.devolvido_do_dia(p_data);
  v_sangrias numeric(10,2);
  v_despesas numeric(10,2);
  v_reforcos numeric(10,2);
  v_repasses numeric(10,2);
  v_acertos numeric(10,2);
  v_movs jsonb;
begin
  select valor_abertura into v_abertura from caixas_diarios where data = p_data;
  select coalesce(sum(m.valor) filter (where m.tipo = 'sangria'), 0),
         coalesce(sum(m.valor) filter (where m.tipo = 'despesa' and m.forma = 'dinheiro'), 0),
         coalesce(sum(m.valor) filter (where m.tipo = 'reforco'), 0),
         coalesce(sum(m.valor) filter (where m.tipo in ('vale','repasse') and m.forma = 'dinheiro'), 0),
         coalesce(sum(m.valor) filter (where m.tipo = 'acerto' and m.forma = 'dinheiro'), 0),
         coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'tipo', m.tipo, 'valor', m.valor, 'forma', m.forma, 'descricao', m.descricao,
                                               'criado_em', m.criado_em, 'profissional_id', m.profissional_id, 'fechamento_id', m.fechamento_id,
                                               'profissional_nome', p.nome) order by m.id), '[]'::jsonb)
    into v_sangrias, v_despesas, v_reforcos, v_repasses, v_acertos, v_movs
    from movimentos_caixa m left join profissionais p on p.id = m.profissional_id where m.data = p_data;
  return jsonb_build_object(
    'recebido_dinheiro', v_recebido,
    'devolvido_dinheiro', v_devolvido,
    'sangrias', v_sangrias,
    'despesas_dinheiro', v_despesas,
    'reforcos', v_reforcos,
    'repasses_dinheiro', v_repasses,
    'acertos_dinheiro', v_acertos,
    'saidas_dinheiro', v_devolvido + v_sangrias + v_despesas + v_repasses,
    'valor_esperado', v_abertura + v_recebido + v_reforcos + v_acertos - v_devolvido - v_sangrias - v_despesas - v_repasses,
    'movimentos', v_movs);
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
  v_despesas numeric(10,2);
  v_repasses numeric(10,2);
  v_acertos numeric(10,2);
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
     where recebido_por = 'barbearia' and timezone('America/Sao_Paulo', recebido_em)::date between v_p.de and v_p.ate;
    v_recebido := (v_formas->>'dinheiro')::numeric + (v_formas->>'pix')::numeric + (v_formas->>'cartao')::numeric + (v_formas->>'outro')::numeric;

    select coalesce(sum(valor), 0) into v_despesas
      from movimentos_caixa where tipo = 'despesa' and data between v_p.de and v_p.ate;
    -- pagamentos a barbeiros (vales e repasses) e acertos que eles pagaram (aluguel, produtos)
    select coalesce(sum(valor) filter (where tipo in ('vale','repasse')), 0), coalesce(sum(valor) filter (where tipo = 'acerto'), 0)
      into v_repasses, v_acertos from movimentos_caixa where data between v_p.de and v_p.ate;

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
      'despesas', v_despesas, 'repasses', v_repasses, 'acertos', v_acertos,
      'saldo', v_recebido + v_acertos - v_despesas - v_repasses,
      'por_forma', v_formas,
      'servicos_mais_vendidos', v_ranking));
  end loop;
  return v_resumo;
end;
$$;

create or replace function public.registrar_recebimento(p_agendamento_id bigint, p_valor numeric, p_forma text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_ag agendamentos%rowtype;
  v_pago numeric;
  v_recebimento recebimentos_agendamento%rowtype;
  v_por text;
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
  -- barbeiro de aluguel que recebe direto: o dinheiro fica com ele, não entra na gaveta
  v_por := public.recebido_por(v_ag.profissional_id);
  if p_forma = 'dinheiro' and v_por = 'barbearia' then perform public.exigir_caixa_nao_fechado(); end if;
  insert into recebimentos_agendamento (agendamento_id, valor, forma, recebido_por)
    values (p_agendamento_id, p_valor, p_forma, v_por) returning * into v_recebimento;
  return to_jsonb(v_recebimento);
end;
$$;

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
      if exists (select 1 from recebimentos_agendamento where agendamento_id = p_agendamento_id and forma = 'dinheiro' and recebido_por = 'barbearia')
         and exists (select 1 from caixas_diarios where data = v_agora::date and status = 'fechado') then
        raise exception 'CAIXA_JA_FECHADO' using errcode = '23505';
      end if;
      insert into estornos (agendamento_id, valor, forma)
        select p_agendamento_id, sum(valor), forma from recebimentos_agendamento
         where agendamento_id = p_agendamento_id and recebido_por = 'barbearia' group by forma; -- o que o barbeiro recebeu direto, ele mesmo devolve
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
         where r.recebido_por = 'barbearia' and timezone('America/Sao_Paulo', r.recebido_em)::date between p_de and p_ate
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
               case m.tipo when 'despesa' then 'Despesa' when 'sangria' then 'Sangria (retirada da gaveta)' when 'reforco' then 'Reforço de troco'
                 when 'vale' then 'Vale para barbeiro' when 'repasse' then 'Repasse a barbeiro' else 'Acerto pago por barbeiro' end,
               concat_ws(' · ', p.nome, nullif(m.descricao, '')), m.forma, case when m.tipo in ('reforco','acerto') then m.valor else -m.valor end
          from movimentos_caixa m left join profissionais p on p.id = m.profissional_id
         where m.data between p_de and p_ate
      ) x), '[]'::jsonb);
end;
$$;

drop function if exists public.registrar_movimento_caixa(text, numeric, text, text);
-- Lança no caixa de hoje. Em dinheiro: exige o caixa aberto e, se for saída, que a gaveta tenha o valor.
-- Vale, repasse e acerto precisam de barbeiro. Uso interno (as funções públicas checam o administrador).
create or replace function public.lancar_movimento(p_tipo text, p_valor numeric, p_forma text, p_descricao text,
  p_profissional_id bigint default null, p_fechamento_id bigint default null) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_forma text := case when p_tipo in ('sangria','reforco') then 'dinheiro' else coalesce(p_forma, 'dinheiro') end;
  v_desc text := left(btrim(coalesce(p_descricao, '')), 120);
  v_caixa caixas_diarios%rowtype;
  v_id bigint;
begin
  if p_tipo is null or p_tipo not in ('sangria','despesa','reforco','vale','repasse','acerto') or v_forma not in ('dinheiro','pix','cartao','outro')
     or p_valor is null or p_valor <= 0 or p_valor <> round(p_valor, 2) then
    raise exception 'DADOS_INVALIDOS' using errcode = '22023';
  end if;
  if p_tipo = 'despesa' and v_desc = '' then raise exception 'DESCRICAO_OBRIGATORIA' using errcode = '22023'; end if;
  if p_tipo in ('vale','repasse','acerto') and not exists (select 1 from profissionais where id = p_profissional_id) then
    raise exception 'PROFISSIONAL_INVALIDO' using errcode = '22023';
  end if;
  if v_forma = 'dinheiro' then
    select * into v_caixa from caixas_diarios where data = v_hoje for update;
    if not found then raise exception 'CAIXA_NAO_ABERTO' using errcode = 'P0002'; end if;
    if v_caixa.status = 'fechado' then raise exception 'CAIXA_JA_FECHADO' using errcode = '23505'; end if;
    if p_tipo not in ('reforco','acerto') and p_valor > (public.conta_gaveta(v_hoje)->>'valor_esperado')::numeric then
      raise exception 'SALDO_GAVETA_INSUFICIENTE' using errcode = '22023';
    end if;
  end if;
  insert into movimentos_caixa (data, tipo, valor, forma, descricao, profissional_id, fechamento_id)
    values (v_hoje, p_tipo, p_valor, v_forma, v_desc, case when p_tipo in ('vale','repasse','acerto') then p_profissional_id end, p_fechamento_id)
    returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.lancar_movimento(text, numeric, text, text, bigint, bigint) from public, anon, authenticated;

create or replace function public.registrar_movimento_caixa(p_tipo text, p_valor numeric, p_forma text default 'dinheiro', p_descricao text default '',
  p_profissional_id bigint default null) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'NAO_AUTORIZADO' using errcode = '42501'; end if;
  -- repasse e acerto só nascem do fechamento de um barbeiro
  if p_tipo is null or p_tipo not in ('sangria','despesa','reforco','vale') then raise exception 'DADOS_INVALIDOS' using errcode = '22023'; end if;
  perform public.lancar_movimento(p_tipo, p_valor, p_forma, p_descricao, p_profissional_id);
  return public.caixa_diario_resumo((now() at time zone 'America/Sao_Paulo')::date);
end;
$$;

revoke all on function public.registrar_movimento_caixa(text, numeric, text, text, bigint) from public, anon;
grant execute on function public.registrar_movimento_caixa(text, numeric, text, text, bigint) to authenticated;
create or replace function public.excluir_movimento_caixa(p_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_mv movimentos_caixa%rowtype;
begin
  if not public.is_admin() then raise exception 'NAO_AUTORIZADO' using errcode = '42501'; end if;
  select * into v_mv from movimentos_caixa where id = p_id for update;
  if not found then raise exception 'MOVIMENTO_NAO_ENCONTRADO' using errcode = 'P0002'; end if;
  if v_mv.fechamento_id is not null then raise exception 'MOVIMENTO_FECHADO' using errcode = '23505'; end if;
  if exists (select 1 from caixas_diarios where data = v_mv.data and status = 'fechado') then
    raise exception 'CAIXA_JA_FECHADO' using errcode = '23505';
  end if;
  delete from movimentos_caixa where id = p_id;
  return public.caixa_diario_resumo(v_mv.data);
end;
$$;

-- Fecha o período de um barbeiro: guarda o extrato calculado no painel (js/comissoes.js), dá baixa nos vales
-- e lança no caixa o repasse (total > 0) ou o acerto que ele paga (total < 0).
create or replace function public.registrar_fechamento(p_dados jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_prof profissionais%rowtype;
  v_de date := (p_dados->>'de')::date;
  v_ate date := (p_dados->>'ate')::date;
  v_total numeric(10,2) := round((p_dados->>'total')::numeric, 2);
  v_forma text := coalesce(p_dados->>'forma', 'dinheiro');
  v_ids bigint[];
  v_qtd int; v_soma numeric;
  v_fid bigint;
  v_periodo text;
  n numeric;
begin
  if not public.is_admin() then raise exception 'NAO_AUTORIZADO' using errcode = '42501'; end if;
  if v_de is null or v_ate is null or v_de > v_ate or v_total is null or v_forma not in ('dinheiro','pix','cartao','outro') then
    raise exception 'DADOS_INVALIDOS' using errcode = '22023';
  end if;
  select * into v_prof from profissionais where id = (p_dados->>'profissional_id')::bigint;
  if not found then raise exception 'PROFISSIONAL_INVALIDO' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(hashtext('fechamento:' || v_prof.id));
  if exists (select 1 from fechamentos where profissional_id = v_prof.id and de <= v_ate and v_de <= ate) then
    raise exception 'PERIODO_JA_FECHADO' using errcode = '23505';
  end if;
  -- os vales precisam ser exatamente os pendentes que o painel somou (evita fechar com conta desatualizada)
  select coalesce(array_agg(x::bigint), '{}') into v_ids from jsonb_array_elements_text(coalesce(p_dados->'vale_ids', '[]'::jsonb)) x;
  select count(*), coalesce(sum(valor), 0) into v_qtd, v_soma from movimentos_caixa
   where tipo = 'vale' and fechamento_id is null and profissional_id = v_prof.id and id = any (v_ids);
  if v_qtd <> coalesce(array_length(v_ids, 1), 0) or round(v_soma, 2) <> round(coalesce((p_dados->>'vales')::numeric, 0), 2) then
    raise exception 'DADOS_DESATUALIZADOS' using errcode = '40001';
  end if;
  insert into fechamentos (profissional_id, de, ate, atendimentos, servicos, produtos, parte, fixo, aluguel, recebido_profissional, vales, total, forma, observacao)
  values (v_prof.id, v_de, v_ate, greatest(coalesce((p_dados->>'atendimentos')::int, 0), 0),
          round(coalesce((p_dados->>'servicos')::numeric, 0), 2), round(coalesce((p_dados->>'produtos')::numeric, 0), 2),
          round(coalesce((p_dados->>'parte')::numeric, 0), 2), round(coalesce((p_dados->>'fixo')::numeric, 0), 2),
          round(coalesce((p_dados->>'aluguel')::numeric, 0), 2), round(coalesce((p_dados->>'recebido_profissional')::numeric, 0), 2),
          round(v_soma, 2), v_total, v_forma, left(btrim(coalesce(p_dados->>'observacao', '')), 200))
  returning id into v_fid;
  update movimentos_caixa set fechamento_id = v_fid where id = any (v_ids);
  v_periodo := to_char(v_de, 'DD/MM/YYYY') || ' a ' || to_char(v_ate, 'DD/MM/YYYY');
  if v_total > 0 then perform public.lancar_movimento('repasse', v_total, v_forma, 'Fechamento ' || v_periodo, v_prof.id, v_fid);
  elsif v_total < 0 then perform public.lancar_movimento('acerto', -v_total, v_forma, 'Fechamento ' || v_periodo, v_prof.id, v_fid);
  end if;
  return jsonb_build_object('ok', true, 'id', v_fid);
end;
$$;

-- Desfaz um fechamento lançado errado: tira o repasse/acerto do caixa e devolve os vales para pendentes.
create or replace function public.excluir_fechamento(p_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_mov movimentos_caixa%rowtype;
begin
  if not public.is_admin() then raise exception 'NAO_AUTORIZADO' using errcode = '42501'; end if;
  if not exists (select 1 from fechamentos where id = p_id) then raise exception 'FECHAMENTO_NAO_ENCONTRADO' using errcode = 'P0002'; end if;
  select * into v_mov from movimentos_caixa where fechamento_id = p_id and tipo in ('repasse','acerto') limit 1;
  if found and v_mov.forma = 'dinheiro' and exists (select 1 from caixas_diarios where data = v_mov.data and status = 'fechado') then
    raise exception 'CAIXA_JA_FECHADO' using errcode = '23505';
  end if;
  delete from movimentos_caixa where fechamento_id = p_id and tipo in ('repasse','acerto');
  update movimentos_caixa set fechamento_id = null where fechamento_id = p_id and tipo = 'vale';
  delete from fechamentos where id = p_id;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.registrar_fechamento(jsonb) from public, anon;
revoke all on function public.excluir_fechamento(bigint) from public, anon;
grant execute on function public.registrar_fechamento(jsonb) to authenticated;
grant execute on function public.excluir_fechamento(bigint) to authenticated;
