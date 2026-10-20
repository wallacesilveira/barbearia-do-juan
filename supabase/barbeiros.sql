-- =====================================================================
-- Barbearia do Juan — vários barbeiros (etapa 1: base)
-- Cria os barbeiros (o Juan é o primeiro e fica com todos os agendamentos que já existem),
-- liga agendamento e bloqueio ao barbeiro e passa a checar conflito por barbeiro.
-- Banco que já existe: rode ANTES remarcacoes.sql e depois cole este arquivo em
-- Supabase > SQL Editor > New query > Run. Pode rodar mais de uma vez sem problema.
-- (O schema.sql completo já inclui tudo isto.)
-- ATENÇÃO: se rodar este arquivo de novo depois do horarios-barbeiros.sql, rode o horarios-barbeiros.sql
-- outra vez em seguida (ele atualiza as mesmas funções de agendamento).
-- =====================================================================
create extension if not exists btree_gist;

-- Barbeiros. Agendamento sempre tem um; bloqueio sem barbeiro vale para a barbearia toda.
create table if not exists profissionais (
  id bigint generated always as identity primary key,
  nome text not null check (btrim(nome) <> ''),
  foto text not null default '',
  ativo boolean not null default true,
  ordem int not null default 0,
  comissao_servicos numeric(5,2) not null default 0 check (comissao_servicos between 0 and 100),
  comissao_produtos numeric(5,2) not null default 0 check (comissao_produtos between 0 and 100),
  criado_em timestamptz not null default now()
);
insert into profissionais (nome, ordem) select 'Juan', 1 where not exists (select 1 from profissionais);
alter table agendamentos add column if not exists profissional_id bigint references profissionais(id);
update agendamentos set profissional_id = (select id from profissionais order by ordem, id limit 1) where profissional_id is null;
alter table agendamentos alter column profissional_id set not null;
alter table bloqueios add column if not exists profissional_id bigint references profissionais(id) on delete cascade;
create index if not exists idx_agendamentos_prof on agendamentos (profissional_id, data, status);
-- dois clientes no mesmo horário só com barbeiros diferentes
alter table agendamentos drop constraint if exists agendamentos_sem_conflito;
alter table agendamentos add constraint agendamentos_sem_conflito
  exclude using gist (profissional_id with =, data with =, int4range(inicio_min, fim_min) with &&) where (status = 'confirmado');

-- Não deixa ficar sem barbeiro ativo nem desativar quem tem horário marcado.
create or replace function public.proteger_profissionais() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (tg_op = 'DELETE' and old.ativo) or (tg_op = 'UPDATE' and old.ativo and not new.ativo) then
    if not exists (select 1 from profissionais where ativo and id <> old.id) then
      raise exception 'ULTIMO_PROFISSIONAL' using errcode = '23514';
    end if;
  end if;
  if tg_op = 'UPDATE' and old.ativo and not new.ativo and exists (
       select 1 from agendamentos where profissional_id = old.id and status = 'confirmado'
          and data >= (now() at time zone 'America/Sao_Paulo')::date) then
    raise exception 'PROFISSIONAL_COM_AGENDA' using errcode = '23514';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
drop trigger if exists proteger_profissionais on profissionais;
create trigger proteger_profissionais before update or delete on profissionais
  for each row execute function public.proteger_profissionais();

alter table profissionais enable row level security;
drop policy if exists pub_profissionais on profissionais;
create policy pub_profissionais on profissionais for select using (ativo);
drop policy if exists adm_profissionais on profissionais;
create policy adm_profissionais on profissionais for all using (is_admin()) with check (is_admin());
grant select, insert, update, delete on profissionais to authenticated;
-- o site só lê nome e foto; comissão fica só para o painel
revoke all on profissionais from anon;
grant select (id, nome, foto, ordem, ativo) on profissionais to anon;

drop function if exists public.get_indisponiveis(date);
create or replace function public.get_indisponiveis(p_data date, p_profissional_id bigint default null)
returns table (ini int, fim int)
language sql security definer stable set search_path = public as $$
  with p as (select id from profissionais where ativo and (p_profissional_id is null or id = p_profissional_id) order by ordem, id limit 1)
  select a.inicio_min, a.fim_min from agendamentos a, p where a.data = p_data and a.status = 'confirmado' and a.profissional_id = p.id
  union all
  select b.inicio_min, b.fim_min from bloqueios b, p where b.data = p_data and (b.profissional_id is null or b.profissional_id = p.id);
$$;

drop function if exists public.criar_agendamento(date, int, bigint[], text, text);
create or replace function public.criar_agendamento(
  p_data date, p_inicio_min int, p_servico_ids bigint[], p_nome text, p_whatsapp text, p_profissional_id bigint default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_nome text := regexp_replace(btrim(coalesce(p_nome, '')), '\s+', ' ', 'g');
  v_wa text := regexp_replace(coalesce(p_whatsapp, ''), '\D', '', 'g');
  v_ids bigint[];
  v_restante bigint[];
  v_dur int := 0;
  v_total numeric := 0;
  v_consulta boolean := false;
  v_combos text[] := '{}';
  v_qtd int;
  c record;
  s record;
  h record;
  v_cfg jsonb;
  v_agora timestamp := now() at time zone 'America/Sao_Paulo';
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_agora_min int := extract(hour from (now() at time zone 'America/Sao_Paulo'))::int * 60
                     + extract(minute from (now() at time zone 'America/Sao_Paulo'))::int;
  v_antec int; v_dias int; v_fim int;
  v_al_ini int; v_al_fim int;
  v_cliente bigint; v_ag bigint; v_codigo text; v_tent int := 0;
  v_servicos jsonb;
  v_prof bigint;
begin
  if length(v_nome) < 3 or length(v_nome) > 80 or length(v_wa) < 10 or length(v_wa) > 13
     or p_data is null or p_inicio_min is null then
    return jsonb_build_object('ok', false, 'erro', 'DADOS_INVALIDOS');
  end if;

  select array_agg(distinct x) into v_ids from unnest(coalesce(p_servico_ids, '{}')) x;
  select count(*) into v_qtd from servicos where id = any(coalesce(v_ids, '{}')) and ativo;
  if v_ids is null or v_qtd <> array_length(v_ids, 1) then
    return jsonb_build_object('ok', false, 'erro', 'SERVICO_INVALIDO');
  end if;

  -- preço/duração calculados no banco (combo substitui a soma quando todos os serviços estão presentes)
  v_restante := v_ids;
  for c in
    select cb.id, cb.nome, cb.preco, cb.duracao_min,
           (select count(*) from combo_servicos x where x.combo_id = cb.id) qtd
      from combos cb
     where cb.ativo and exists (select 1 from combo_servicos x where x.combo_id = cb.id)
     order by qtd desc, cb.id
  loop
    if not exists (select 1 from combo_servicos x where x.combo_id = c.id and x.servico_id <> all (v_restante)) then
      v_total := v_total + c.preco;
      v_dur := v_dur + coalesce(c.duracao_min,
        (select sum(sv.duracao_min) from servicos sv join combo_servicos x on x.servico_id = sv.id where x.combo_id = c.id));
      v_combos := v_combos || c.nome;
      v_restante := array(select r from unnest(v_restante) r
                           where r not in (select x.servico_id from combo_servicos x where x.combo_id = c.id));
    end if;
  end loop;
  for s in select * from servicos where id = any (v_restante) loop
    v_dur := v_dur + s.duracao_min;
    if s.preco is null then v_consulta := true; else v_total := v_total + s.preco; end if;
  end loop;
  v_fim := p_inicio_min + v_dur;

  select coalesce(jsonb_object_agg(chave, valor), '{}') into v_cfg from configuracoes;
  v_antec := coalesce(nullif(v_cfg->>'antecedencia_min', '')::int, 0);
  v_dias := coalesce(nullif(v_cfg->>'dias_agenda', '')::int, 60);

  -- serializa reservas do mesmo dia; junto com a restrição de exclusão, impede dupla reserva
  perform pg_advisory_xact_lock(hashtext('agendamento:' || p_data::text));
  select id into v_prof from profissionais where ativo and (p_profissional_id is null or id = p_profissional_id) order by ordem, id limit 1;
  if v_prof is null then return jsonb_build_object('ok', false, 'erro', 'PROFISSIONAL_INVALIDO'); end if;

  select * into h from horarios_funcionamento where dia_semana = extract(dow from p_data)::int;
  if not found or not h.ativo then return jsonb_build_object('ok', false, 'erro', 'FECHADO'); end if;
  if p_inicio_min < h.inicio_min or v_fim > h.fim_min then
    return jsonb_build_object('ok', false, 'erro', 'FORA_DO_EXPEDIENTE');
  end if;
  if p_data < v_hoje or (p_data = v_hoje and p_inicio_min < v_agora_min + v_antec) then
    return jsonb_build_object('ok', false, 'erro', 'PASSADO');
  end if;
  if p_data > v_hoje + v_dias then return jsonb_build_object('ok', false, 'erro', 'MUITO_LONGE'); end if;

  if coalesce(v_cfg->>'almoco_ativo', '0') = '1' then
    v_al_ini := split_part(v_cfg->>'almoco_inicio', ':', 1)::int * 60 + split_part(v_cfg->>'almoco_inicio', ':', 2)::int;
    v_al_fim := split_part(v_cfg->>'almoco_fim', ':', 1)::int * 60 + split_part(v_cfg->>'almoco_fim', ':', 2)::int;
    if p_inicio_min < v_al_fim and v_al_ini < v_fim then return jsonb_build_object('ok', false, 'erro', 'ALMOCO'); end if;
  end if;

  if exists (select 1 from bloqueios where data = p_data and (profissional_id is null or profissional_id = v_prof)
              and p_inicio_min < fim_min and inicio_min < v_fim) then
    return jsonb_build_object('ok', false, 'erro', 'BLOQUEADO');
  end if;
  if exists (select 1 from agendamentos where data = p_data and status = 'confirmado' and profissional_id = v_prof
              and p_inicio_min < fim_min and inicio_min < v_fim) then
    return jsonb_build_object('ok', false, 'erro', 'HORARIO_OCUPADO');
  end if;

  select id into v_cliente from clientes where whatsapp = v_wa limit 1;
  if v_cliente is null then
    insert into clientes (nome, whatsapp) values (v_nome, v_wa) returning id into v_cliente;
  else
    update clientes set nome = v_nome where id = v_cliente;
  end if;

  loop
    v_codigo := 'BJ-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
    begin
      insert into agendamentos (codigo, cliente_id, data, inicio_min, fim_min, duracao_min, valor_total, combos_aplicados, valor_consulta, profissional_id)
      values (v_codigo, v_cliente, p_data, p_inicio_min, v_fim, v_dur, v_total, array_to_string(v_combos, ', '), v_consulta, v_prof)
      returning id into v_ag;
      exit;
    exception
      when exclusion_violation then
        return jsonb_build_object('ok', false, 'erro', 'HORARIO_OCUPADO');
      when unique_violation then
        v_tent := v_tent + 1;
        if v_tent > 5 then raise; end if;
    end;
  end loop;

  insert into agendamento_servicos (agendamento_id, servico_id, nome, duracao_min, preco)
  select v_ag, sv.id, sv.nome, sv.duracao_min, sv.preco from servicos sv where sv.id = any (v_ids) order by sv.ordem, sv.id;

  insert into alertas (tipo, agendamento_id, titulo, mensagem)
  select 'novo_agendamento', v_ag, 'Novo agendamento: ' || v_nome,
         to_char(p_data, 'DD/MM/YYYY') || ' às ' || lpad((p_inicio_min / 60)::text, 2, '0') || ':' || lpad((p_inicio_min % 60)::text, 2, '0')
         || ' · ' || string_agg(sv.nome, ' + ' order by sv.ordem, sv.id)
    from servicos sv where sv.id = any (v_ids);

  select jsonb_agg(jsonb_build_object('nome', nome, 'duracao_min', duracao_min, 'preco', preco) order by id)
    into v_servicos from agendamento_servicos where agendamento_id = v_ag;

  return jsonb_build_object('ok', true, 'agendamento', jsonb_build_object(
    'codigo', v_codigo, 'data', p_data, 'inicio_min', p_inicio_min, 'fim_min', v_fim, 'duracao_min', v_dur,
    'valor_total', v_total, 'valor_consulta', v_consulta, 'combos_aplicados', array_to_string(v_combos, ', '),
    'status', 'confirmado', 'profissional', (select jsonb_build_object('id', id, 'nome', nome) from profissionais where id = v_prof),
    'cliente', jsonb_build_object('nome', v_nome, 'whatsapp', v_wa),
    'servicos', coalesce(v_servicos, '[]'::jsonb)));
end;
$$;

drop function if exists public.criar_agendamento_admin(date, int, bigint[], text, text);
create or replace function public.criar_agendamento_admin(
  p_data date, p_inicio_min int, p_servico_ids bigint[], p_nome text, p_whatsapp text default '', p_profissional_id bigint default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_nome text := regexp_replace(btrim(coalesce(p_nome, '')), '\s+', ' ', 'g');
  v_wa text := regexp_replace(coalesce(p_whatsapp, ''), '\D', '', 'g');
  v_ids bigint[];
  v_restante bigint[];
  v_dur int := 0;
  v_total numeric := 0;
  v_consulta boolean := false;
  v_combos text[] := '{}';
  v_qtd int;
  c record;
  s record;
  h record;
  v_cfg jsonb;
  v_fim int;
  v_al_ini int; v_al_fim int;
  v_cliente bigint; v_ag bigint; v_codigo text;
  v_servicos jsonb;
  v_prof bigint;
begin
  if not public.is_admin() then raise exception 'NAO_AUTORIZADO' using errcode = '42501'; end if;
  if length(v_nome) < 1 or length(v_nome) > 80 or (v_wa <> '' and length(v_wa) not between 10 and 13)
     or p_data is null or p_inicio_min is null then
    return jsonb_build_object('ok', false, 'erro', 'DADOS_INVALIDOS');
  end if;

  select array_agg(distinct x) into v_ids from unnest(coalesce(p_servico_ids, '{}')) x;
  select count(*) into v_qtd from servicos where id = any(coalesce(v_ids, '{}')) and ativo;
  if v_ids is null or v_qtd <> array_length(v_ids, 1) then
    return jsonb_build_object('ok', false, 'erro', 'SERVICO_INVALIDO');
  end if;

  v_restante := v_ids;
  for c in
    select cb.id, cb.nome, cb.preco, cb.duracao_min,
           (select count(*) from combo_servicos x where x.combo_id = cb.id) qtd
      from combos cb
     where cb.ativo and exists (select 1 from combo_servicos x where x.combo_id = cb.id)
     order by qtd desc, cb.id
  loop
    if not exists (select 1 from combo_servicos x where x.combo_id = c.id and x.servico_id <> all (v_restante)) then
      v_total := v_total + c.preco;
      v_dur := v_dur + coalesce(c.duracao_min,
        (select sum(sv.duracao_min) from servicos sv join combo_servicos x on x.servico_id = sv.id where x.combo_id = c.id));
      v_combos := v_combos || c.nome;
      v_restante := array(select r from unnest(v_restante) r
                           where r not in (select x.servico_id from combo_servicos x where x.combo_id = c.id));
    end if;
  end loop;
  for s in select * from servicos where id = any (v_restante) loop
    v_dur := v_dur + s.duracao_min;
    if s.preco is null then v_consulta := true; else v_total := v_total + s.preco; end if;
  end loop;
  v_fim := p_inicio_min + v_dur;

  select coalesce(jsonb_object_agg(chave, valor), '{}') into v_cfg from configuracoes;
  perform pg_advisory_xact_lock(hashtext('agendamento:' || p_data::text));
  select id into v_prof from profissionais where ativo and (p_profissional_id is null or id = p_profissional_id) order by ordem, id limit 1;
  if v_prof is null then return jsonb_build_object('ok', false, 'erro', 'PROFISSIONAL_INVALIDO'); end if;
  select * into h from horarios_funcionamento where dia_semana = extract(dow from p_data)::int;
  if not found or not h.ativo then return jsonb_build_object('ok', false, 'erro', 'FECHADO'); end if;
  if p_inicio_min < h.inicio_min or v_fim > h.fim_min then
    return jsonb_build_object('ok', false, 'erro', 'FORA_DO_EXPEDIENTE');
  end if;
  if coalesce(v_cfg->>'almoco_ativo', '0') = '1' then
    v_al_ini := split_part(v_cfg->>'almoco_inicio', ':', 1)::int * 60 + split_part(v_cfg->>'almoco_inicio', ':', 2)::int;
    v_al_fim := split_part(v_cfg->>'almoco_fim', ':', 1)::int * 60 + split_part(v_cfg->>'almoco_fim', ':', 2)::int;
    if p_inicio_min < v_al_fim and v_al_ini < v_fim then return jsonb_build_object('ok', false, 'erro', 'ALMOCO'); end if;
  end if;
  if exists (select 1 from bloqueios where data = p_data and (profissional_id is null or profissional_id = v_prof)
              and p_inicio_min < fim_min and inicio_min < v_fim) then
    return jsonb_build_object('ok', false, 'erro', 'BLOQUEADO');
  end if;
  if exists (select 1 from agendamentos where data = p_data and status = 'confirmado' and profissional_id = v_prof
              and p_inicio_min < fim_min and inicio_min < v_fim) then
    return jsonb_build_object('ok', false, 'erro', 'HORARIO_OCUPADO');
  end if;

  if v_wa <> '' then select id into v_cliente from clientes where whatsapp = v_wa limit 1;
  else select id into v_cliente from clientes where whatsapp = '' and lower(nome) = lower(v_nome) order by id limit 1; end if;
  if v_cliente is null then
    insert into clientes (nome, whatsapp) values (v_nome, v_wa) returning id into v_cliente;
  else
    update clientes set nome = v_nome where id = v_cliente;
  end if;
  v_codigo := 'BJ-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
  insert into agendamentos (codigo, cliente_id, data, inicio_min, fim_min, duracao_min, valor_total, combos_aplicados, valor_consulta, profissional_id)
    values (v_codigo, v_cliente, p_data, p_inicio_min, v_fim, v_dur, v_total, array_to_string(v_combos, ', '), v_consulta, v_prof)
    returning id into v_ag;
  insert into agendamento_servicos (agendamento_id, servico_id, nome, duracao_min, preco)
    select v_ag, sv.id, sv.nome, sv.duracao_min, sv.preco from servicos sv where sv.id = any (v_ids) order by sv.ordem, sv.id;
  select jsonb_agg(jsonb_build_object('nome', nome, 'duracao_min', duracao_min, 'preco', preco) order by id)
    into v_servicos from agendamento_servicos where agendamento_id = v_ag;
  return jsonb_build_object('ok', true, 'agendamento', jsonb_build_object(
    'codigo', v_codigo, 'data', p_data, 'inicio_min', p_inicio_min, 'fim_min', v_fim, 'duracao_min', v_dur,
    'valor_total', v_total, 'valor_consulta', v_consulta, 'combos_aplicados', array_to_string(v_combos, ', '),
    'status', 'confirmado', 'profissional', (select jsonb_build_object('id', id, 'nome', nome) from profissionais where id = v_prof),
    'cliente', jsonb_build_object('nome', v_nome, 'whatsapp', v_wa),
    'servicos', coalesce(v_servicos, '[]'::jsonb)));
end;
$$;

drop function if exists public.reagendar_agendamento(bigint, date, int);
create or replace function public.reagendar_agendamento(p_id bigint, p_data date, p_inicio_min int, p_profissional_id bigint default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_ag agendamentos%rowtype;
  h record;
  v_cfg jsonb;
  v_fim int;
  v_al_ini int; v_al_fim int;
  v_prof bigint;
begin
  if not public.is_admin() then raise exception 'NAO_AUTORIZADO' using errcode = '42501'; end if;
  if p_id is null or p_data is null or p_inicio_min is null then
    return jsonb_build_object('ok', false, 'erro', 'DADOS_INVALIDOS');
  end if;
  perform pg_advisory_xact_lock(hashtext('agendamento:' || p_data::text));
  select * into v_ag from agendamentos where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'erro', 'AGENDAMENTO_NAO_ENCONTRADO'); end if;
  if v_ag.status <> 'confirmado' then return jsonb_build_object('ok', false, 'erro', 'AGENDAMENTO_CANCELADO'); end if;
  -- sem barbeiro informado, continua com o mesmo
  select id into v_prof from profissionais where ativo and id = coalesce(p_profissional_id, v_ag.profissional_id);
  if v_prof is null then return jsonb_build_object('ok', false, 'erro', 'PROFISSIONAL_INVALIDO'); end if;
  if v_ag.data = p_data and v_ag.inicio_min = p_inicio_min and v_ag.profissional_id = v_prof then return jsonb_build_object('ok', false, 'erro', 'MESMO_HORARIO'); end if;
  v_fim := p_inicio_min + v_ag.duracao_min;

  select coalesce(jsonb_object_agg(chave, valor), '{}') into v_cfg from configuracoes;
  select * into h from horarios_funcionamento where dia_semana = extract(dow from p_data)::int;
  if not found or not h.ativo then return jsonb_build_object('ok', false, 'erro', 'FECHADO'); end if;
  if p_inicio_min < h.inicio_min or v_fim > h.fim_min then
    return jsonb_build_object('ok', false, 'erro', 'FORA_DO_EXPEDIENTE');
  end if;
  if coalesce(v_cfg->>'almoco_ativo', '0') = '1' then
    v_al_ini := split_part(v_cfg->>'almoco_inicio', ':', 1)::int * 60 + split_part(v_cfg->>'almoco_inicio', ':', 2)::int;
    v_al_fim := split_part(v_cfg->>'almoco_fim', ':', 1)::int * 60 + split_part(v_cfg->>'almoco_fim', ':', 2)::int;
    if p_inicio_min < v_al_fim and v_al_ini < v_fim then return jsonb_build_object('ok', false, 'erro', 'ALMOCO'); end if;
  end if;
  if exists (select 1 from bloqueios where data = p_data and (profissional_id is null or profissional_id = v_prof)
              and p_inicio_min < fim_min and inicio_min < v_fim) then
    return jsonb_build_object('ok', false, 'erro', 'BLOQUEADO');
  end if;
  -- o próprio horário atual não conta como ocupado
  if exists (select 1 from agendamentos where data = p_data and status = 'confirmado' and id <> p_id and profissional_id = v_prof
              and p_inicio_min < fim_min and inicio_min < v_fim) then
    return jsonb_build_object('ok', false, 'erro', 'HORARIO_OCUPADO');
  end if;

  begin
    insert into remarcacoes (agendamento_id, data_anterior, inicio_anterior, data_nova, inicio_novo)
      values (p_id, v_ag.data, v_ag.inicio_min, p_data, p_inicio_min);
    -- o lembrete enviado era do horário antigo: volta a "não enviado"
    update agendamentos
       set data = p_data, inicio_min = p_inicio_min, fim_min = v_fim, profissional_id = v_prof,
           lembrete_enviado_em = null, lembrete_envios = 0, lembrete_aberto_em = null, lembrete_aberturas = 0
     where id = p_id returning * into v_ag;
  exception when exclusion_violation then
    return jsonb_build_object('ok', false, 'erro', 'HORARIO_OCUPADO');
  end;
  return jsonb_build_object('ok', true, 'agendamento', to_jsonb(v_ag));
end;
$$;

revoke all on function public.criar_agendamento(date, int, bigint[], text, text, bigint) from public;
revoke all on function public.criar_agendamento_admin(date, int, bigint[], text, text, bigint) from public;
revoke all on function public.get_indisponiveis(date, bigint) from public;
grant execute on function public.criar_agendamento(date, int, bigint[], text, text, bigint) to anon, authenticated;
grant execute on function public.criar_agendamento_admin(date, int, bigint[], text, text, bigint) to authenticated;
grant execute on function public.get_indisponiveis(date, bigint) to anon, authenticated;
revoke all on function public.reagendar_agendamento(bigint, date, int, bigint) from public, anon;
grant execute on function public.reagendar_agendamento(bigint, date, int, bigint) to authenticated;
