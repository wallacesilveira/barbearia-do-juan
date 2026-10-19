-- =====================================================================
-- Barbearia do Juan — reagendar (mudar data/horário sem cancelar)
-- Banco que já existe: cole este arquivo em Supabase > SQL Editor > New query > Run.
-- Pode rodar mais de uma vez sem problema. (O schema.sql completo já inclui tudo isto.)
-- =====================================================================

create table if not exists remarcacoes (
  id bigint generated always as identity primary key,
  agendamento_id bigint not null references agendamentos(id) on delete cascade,
  data_anterior date not null,
  inicio_anterior int not null,
  data_nova date not null,
  inicio_novo int not null,
  criado_em timestamptz not null default now()
);
create index if not exists idx_remarcacoes_ag on remarcacoes (agendamento_id);

alter table remarcacoes enable row level security;
drop policy if exists adm_remarcacoes on remarcacoes;
create policy adm_remarcacoes on remarcacoes for all using (is_admin()) with check (is_admin());
grant select, insert, update, delete on remarcacoes to authenticated;
revoke all on remarcacoes from anon;

-- Muda data/horário mantendo serviços, valores, pagamentos e produtos. Mesmas regras do agendamento pelo painel.
create or replace function public.reagendar_agendamento(p_id bigint, p_data date, p_inicio_min int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_ag agendamentos%rowtype;
  h record;
  v_cfg jsonb;
  v_fim int;
  v_al_ini int; v_al_fim int;
begin
  if not public.is_admin() then raise exception 'NAO_AUTORIZADO' using errcode = '42501'; end if;
  if p_id is null or p_data is null or p_inicio_min is null then
    return jsonb_build_object('ok', false, 'erro', 'DADOS_INVALIDOS');
  end if;
  perform pg_advisory_xact_lock(hashtext('agendamento:' || p_data::text));
  select * into v_ag from agendamentos where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'erro', 'AGENDAMENTO_NAO_ENCONTRADO'); end if;
  if v_ag.status <> 'confirmado' then return jsonb_build_object('ok', false, 'erro', 'AGENDAMENTO_CANCELADO'); end if;
  if v_ag.data = p_data and v_ag.inicio_min = p_inicio_min then return jsonb_build_object('ok', false, 'erro', 'MESMO_HORARIO'); end if;
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
  if exists (select 1 from bloqueios where data = p_data and p_inicio_min < fim_min and inicio_min < v_fim) then
    return jsonb_build_object('ok', false, 'erro', 'BLOQUEADO');
  end if;
  -- o próprio horário atual não conta como ocupado
  if exists (select 1 from agendamentos where data = p_data and status = 'confirmado' and id <> p_id
              and p_inicio_min < fim_min and inicio_min < v_fim) then
    return jsonb_build_object('ok', false, 'erro', 'HORARIO_OCUPADO');
  end if;

  begin
    insert into remarcacoes (agendamento_id, data_anterior, inicio_anterior, data_nova, inicio_novo)
      values (p_id, v_ag.data, v_ag.inicio_min, p_data, p_inicio_min);
    -- o lembrete enviado era do horário antigo: volta a "não enviado"
    update agendamentos
       set data = p_data, inicio_min = p_inicio_min, fim_min = v_fim,
           lembrete_enviado_em = null, lembrete_envios = 0, lembrete_aberto_em = null, lembrete_aberturas = 0
     where id = p_id returning * into v_ag;
  exception when exclusion_violation then
    return jsonb_build_object('ok', false, 'erro', 'HORARIO_OCUPADO');
  end;
  return jsonb_build_object('ok', true, 'agendamento', to_jsonb(v_ag));
end;
$$;
revoke all on function public.reagendar_agendamento(bigint, date, int) from public, anon;
grant execute on function public.reagendar_agendamento(bigint, date, int) to authenticated;
