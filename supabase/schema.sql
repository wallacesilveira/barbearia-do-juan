-- =====================================================================
-- Barbearia do Juan — banco de dados (Supabase / PostgreSQL)
-- Cole este arquivo inteiro em: Supabase > SQL Editor > New query > Run
-- Horários são inteiros: minutos desde 00:00 (14:30 = 870).
-- =====================================================================
create extension if not exists btree_gist;

-- ------------------------------------------------------------ tabelas
create table if not exists configuracoes (chave text primary key, valor text not null default '');

create table if not exists servicos (
  id bigint generated always as identity primary key,
  nome text not null,
  descricao text default '',
  duracao_min int not null check (duracao_min between 5 and 600),
  preco numeric(10,2) check (preco is null or preco >= 0),   -- null = "sob consulta"
  foto text default '',
  ordem int default 0,
  ativo boolean not null default true
);
create table if not exists produtos (
  id bigint generated always as identity primary key,
  nome text not null,
  descricao text default '',
  preco numeric(10,2) not null check (preco >= 0),
  estoque int not null default 0 check (estoque >= 0),
  estoque_minimo int not null default 0 check (estoque_minimo >= 0),
  ativo boolean not null default true
);

create table if not exists combos (
  id bigint generated always as identity primary key,
  nome text not null,
  descricao text default '',
  preco numeric(10,2) not null check (preco >= 0),
  duracao_min int check (duracao_min is null or duracao_min between 5 and 900), -- null = soma dos serviços
  foto text default '',
  ordem int default 0,
  ativo boolean not null default true
);

create table if not exists combo_servicos (
  combo_id bigint not null references combos(id) on delete cascade,
  servico_id bigint not null references servicos(id) on delete cascade,
  primary key (combo_id, servico_id)
);

create table if not exists horarios_funcionamento (
  dia_semana int primary key check (dia_semana between 0 and 6),  -- 0 = domingo
  ativo boolean not null default true,
  inicio_min int not null,
  fim_min int not null,
  check (fim_min > inicio_min and inicio_min >= 0 and fim_min <= 1440)
);

create table if not exists bloqueios (
  id bigint generated always as identity primary key,
  data date not null,
  inicio_min int not null,
  fim_min int not null,
  motivo text default '',
  check (fim_min > inicio_min and inicio_min >= 0 and fim_min <= 1440)
);

create table if not exists galeria (
  id bigint generated always as identity primary key,
  foto text not null,
  legenda text default '',
  ordem int default 0,
  ativo boolean not null default true
);

create table if not exists clientes (
  id bigint generated always as identity primary key,
  nome text not null,
  whatsapp text not null,
  criado_em timestamptz not null default now()
);
alter table clientes add column if not exists email text not null default '';
alter table clientes add column if not exists aniversario date;

create table if not exists agendamentos (
  id bigint generated always as identity primary key,
  codigo text not null unique,
  cliente_id bigint not null references clientes(id),
  data date not null,
  inicio_min int not null,
  fim_min int not null,
  duracao_min int not null,
  valor_total numeric(10,2) not null,
  valor_produtos numeric(10,2) not null default 0,
  combos_aplicados text default '',
  valor_consulta boolean not null default false,
  status text not null default 'confirmado' check (status in ('confirmado','cancelado','falta')),
  criado_em timestamptz not null default now(),
  check (fim_min > inicio_min),
  -- Garantia final contra dupla reserva: o PRÓPRIO BANCO recusa dois agendamentos
  -- confirmados que se sobreponham no mesmo dia, mesmo se duas requisições chegarem juntas.
  constraint agendamentos_sem_conflito
    exclude using gist (data with =, int4range(inicio_min, fim_min) with &&) where (status = 'confirmado')
);
alter table agendamentos add column if not exists valor_ajuste numeric(10,2) not null default 0;
alter table agendamentos add column if not exists valor_produtos numeric(10,2) not null default 0;
alter table agendamentos add column if not exists lembrete_enviado_em timestamptz;
alter table agendamentos add column if not exists lembrete_envios int not null default 0;
alter table agendamentos add column if not exists lembrete_aberto_em timestamptz;
alter table agendamentos add column if not exists lembrete_aberturas int not null default 0;
create index if not exists idx_agendamentos_data on agendamentos (data, status);

create table if not exists agendamento_servicos (
  id bigint generated always as identity primary key,
  agendamento_id bigint not null references agendamentos(id) on delete cascade,
  servico_id bigint references servicos(id) on delete set null,
  nome text,
  duracao_min int,
  preco numeric(10,2)
);
create table if not exists agendamento_produtos (
  id bigint generated always as identity primary key,
  agendamento_id bigint not null references agendamentos(id) on delete cascade,
  produto_id bigint references produtos(id) on delete set null,
  nome text not null,
  quantidade int not null check (quantidade > 0),
  preco_unitario numeric(10,2) not null check (preco_unitario >= 0),
  valor_total numeric(10,2) not null check (valor_total >= 0)
);
create table if not exists movimentos_estoque (
  id bigint generated always as identity primary key,
  produto_id bigint not null references produtos(id) on delete restrict,
  quantidade int not null check (quantidade <> 0),
  tipo text not null check (tipo in ('entrada','ajuste','venda')),
  motivo text not null default '',
  agendamento_id bigint references agendamentos(id) on delete set null,
  criado_em timestamptz not null default now()
);
create table if not exists recebimentos_agendamento (
  id bigint generated always as identity primary key,
  agendamento_id bigint not null references agendamentos(id) on delete cascade,
  valor numeric(10,2) not null check (valor > 0),
  forma text not null check (forma in ('dinheiro','pix','cartao','outro')),
  recebido_em timestamptz not null default now()
);
create table if not exists caixas_diarios (
  data date primary key,
  valor_abertura numeric(10,2) not null check (valor_abertura >= 0),
  valor_contado numeric(10,2) check (valor_contado is null or valor_contado >= 0),
  diferenca numeric(10,2),
  observacao text not null default '',
  status text not null default 'aberto' check (status in ('aberto','fechado')),
  aberto_em timestamptz not null default now(),
  fechado_em timestamptz
);

-- Vendas avulsas: produto vendido no balcão, sem agendamento.
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

-- Estornos: devolução ao cliente quando um agendamento já pago é cancelado.
create table if not exists estornos (
  id bigint generated always as identity primary key,
  agendamento_id bigint not null references agendamentos(id) on delete cascade,
  valor numeric(10,2) not null check (valor > 0),
  forma text not null check (forma in ('dinheiro','pix','cartao','outro')),
  criado_em timestamptz not null default now()
);
create index if not exists idx_estornos_ag on estornos (agendamento_id);

-- Remarcações: histórico de mudanças de data/horário de um agendamento.
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

-- Movimentos do caixa do dia: sangria, despesa e reforço de troco.
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


-- Alertas do painel (novo agendamento pelo site, estoque baixo).
create table if not exists alertas (
  id bigint generated always as identity primary key,
  tipo text not null check (tipo in ('novo_agendamento','estoque_baixo')),
  agendamento_id bigint references agendamentos(id) on delete cascade,
  produto_id bigint references produtos(id) on delete cascade,
  titulo text not null,
  mensagem text not null default '',
  criado_em timestamptz not null default now(),
  lido_em timestamptz
);
create index if not exists idx_alertas_lido on alertas (lido_em, id);

-- Quem é administrador: usuários criados em Authentication > Users que estejam nesta tabela.
create table if not exists usuarios_admin (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text
);

-- ------------------------------------------------------------ segurança (RLS)
create or replace function public.is_admin() returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from usuarios_admin where user_id = auth.uid());
$$;

alter table configuracoes enable row level security;
alter table servicos enable row level security;
alter table produtos enable row level security;
alter table combos enable row level security;
alter table combo_servicos enable row level security;
alter table horarios_funcionamento enable row level security;
alter table bloqueios enable row level security;
alter table galeria enable row level security;
alter table clientes enable row level security;
alter table agendamentos enable row level security;
alter table agendamento_servicos enable row level security;
alter table agendamento_produtos enable row level security;
alter table movimentos_estoque enable row level security;
alter table recebimentos_agendamento enable row level security;
alter table caixas_diarios enable row level security;
alter table alertas enable row level security;
alter table usuarios_admin enable row level security;

alter table vendas_avulsas enable row level security;
alter table vendas_avulsas_itens enable row level security;
drop policy if exists adm_vendas_avulsas on vendas_avulsas;
create policy adm_vendas_avulsas on vendas_avulsas for all using (is_admin()) with check (is_admin());
drop policy if exists adm_vendas_avulsas_itens on vendas_avulsas_itens;
create policy adm_vendas_avulsas_itens on vendas_avulsas_itens for all using (is_admin()) with check (is_admin());
grant select, insert, update, delete on vendas_avulsas, vendas_avulsas_itens to authenticated;
revoke all on vendas_avulsas, vendas_avulsas_itens from anon;

alter table estornos enable row level security;
drop policy if exists adm_estornos on estornos;
create policy adm_estornos on estornos for all using (is_admin()) with check (is_admin());
grant select, insert, update, delete on estornos to authenticated;
revoke all on estornos from anon;

alter table remarcacoes enable row level security;
drop policy if exists adm_remarcacoes on remarcacoes;
create policy adm_remarcacoes on remarcacoes for all using (is_admin()) with check (is_admin());
grant select, insert, update, delete on remarcacoes to authenticated;
revoke all on remarcacoes from anon;

alter table movimentos_caixa enable row level security;
drop policy if exists adm_movimentos_caixa on movimentos_caixa;
create policy adm_movimentos_caixa on movimentos_caixa for all using (is_admin()) with check (is_admin());
grant select, insert, update, delete on movimentos_caixa to authenticated;
revoke all on movimentos_caixa from anon;


-- Público (site): só leitura do que o cliente precisa ver.
create policy pub_config on configuracoes for select using (true);
create policy pub_servicos on servicos for select using (ativo);
create policy pub_combos on combos for select using (ativo);
create policy pub_combo_servicos on combo_servicos for select using (true);
create policy pub_horarios on horarios_funcionamento for select using (true);
create policy pub_galeria on galeria for select using (ativo);

-- Administrador: tudo. Clientes/agendamentos/bloqueios são SOMENTE do admin
-- (o visitante nunca lê dados de outros clientes; ele só usa as funções abaixo).
create policy adm_config on configuracoes for all using (is_admin()) with check (is_admin());
create policy adm_servicos on servicos for all using (is_admin()) with check (is_admin());
create policy adm_produtos on produtos for all using (is_admin()) with check (is_admin());
create policy adm_combos on combos for all using (is_admin()) with check (is_admin());
create policy adm_combo_servicos on combo_servicos for all using (is_admin()) with check (is_admin());
create policy adm_horarios on horarios_funcionamento for all using (is_admin()) with check (is_admin());
create policy adm_bloqueios on bloqueios for all using (is_admin()) with check (is_admin());
create policy adm_galeria on galeria for all using (is_admin()) with check (is_admin());
create policy adm_clientes on clientes for all using (is_admin()) with check (is_admin());
create policy adm_agendamentos on agendamentos for all using (is_admin()) with check (is_admin());
create policy adm_ag_servicos on agendamento_servicos for all using (is_admin()) with check (is_admin());
create policy adm_ag_produtos on agendamento_produtos for all using (is_admin()) with check (is_admin());
create policy adm_movimentos_estoque on movimentos_estoque for all using (is_admin()) with check (is_admin());
create policy adm_recebimentos on recebimentos_agendamento for all using (is_admin()) with check (is_admin());
create policy adm_caixas_diarios on caixas_diarios for all using (is_admin()) with check (is_admin());
drop policy if exists adm_alertas on alertas;
create policy adm_alertas on alertas for all using (is_admin()) with check (is_admin());
create policy proprio_admin on usuarios_admin for select using (user_id = auth.uid());

grant usage on schema public to anon, authenticated;
grant select on configuracoes, servicos, combos, combo_servicos, horarios_funcionamento, galeria to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
revoke all on clientes, agendamentos, agendamento_servicos, agendamento_produtos, movimentos_estoque, recebimentos_agendamento, caixas_diarios, alertas, bloqueios, usuarios_admin from anon;

-- ------------------------------------------------------------ funções públicas
-- Intervalos ocupados de um dia (agendamentos + bloqueios), SEM nenhum dado pessoal.
create or replace function public.get_indisponiveis(p_data date)
returns table (ini int, fim int)
language sql security definer stable set search_path = public as $$
  select a.inicio_min, a.fim_min from agendamentos a where a.data = p_data and a.status = 'confirmado'
  union all
  select b.inicio_min, b.fim_min from bloqueios b where b.data = p_data;
$$;

-- Cria o agendamento. TODA a regra é revalidada aqui: serviços, preço, duração,
-- expediente, almoço, bloqueios e conflito. Devolve { ok, erro | agendamento }.
create or replace function public.criar_agendamento(
  p_data date, p_inicio_min int, p_servico_ids bigint[], p_nome text, p_whatsapp text
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

  if exists (select 1 from bloqueios where data = p_data and p_inicio_min < fim_min and inicio_min < v_fim) then
    return jsonb_build_object('ok', false, 'erro', 'BLOQUEADO');
  end if;
  if exists (select 1 from agendamentos where data = p_data and status = 'confirmado'
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
      insert into agendamentos (codigo, cliente_id, data, inicio_min, fim_min, duracao_min, valor_total, combos_aplicados, valor_consulta)
      values (v_codigo, v_cliente, p_data, p_inicio_min, v_fim, v_dur, v_total, array_to_string(v_combos, ', '), v_consulta)
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
    'status', 'confirmado', 'cliente', jsonb_build_object('nome', v_nome, 'whatsapp', v_wa),
    'servicos', coalesce(v_servicos, '[]'::jsonb)));
end;
$$;

create or replace function public.criar_agendamento_admin(
  p_data date, p_inicio_min int, p_servico_ids bigint[], p_nome text, p_whatsapp text default ''
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
  if exists (select 1 from agendamentos where data = p_data and status = 'confirmado'
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
  insert into agendamentos (codigo, cliente_id, data, inicio_min, fim_min, duracao_min, valor_total, combos_aplicados, valor_consulta)
    values (v_codigo, v_cliente, p_data, p_inicio_min, v_fim, v_dur, v_total, array_to_string(v_combos, ', '), v_consulta)
    returning id into v_ag;
  insert into agendamento_servicos (agendamento_id, servico_id, nome, duracao_min, preco)
    select v_ag, sv.id, sv.nome, sv.duracao_min, sv.preco from servicos sv where sv.id = any (v_ids) order by sv.ordem, sv.id;
  select jsonb_agg(jsonb_build_object('nome', nome, 'duracao_min', duracao_min, 'preco', preco) order by id)
    into v_servicos from agendamento_servicos where agendamento_id = v_ag;
  return jsonb_build_object('ok', true, 'agendamento', jsonb_build_object(
    'codigo', v_codigo, 'data', p_data, 'inicio_min', p_inicio_min, 'fim_min', v_fim, 'duracao_min', v_dur,
    'valor_total', v_total, 'valor_consulta', v_consulta, 'combos_aplicados', array_to_string(v_combos, ', '),
    'status', 'confirmado', 'cliente', jsonb_build_object('nome', v_nome, 'whatsapp', v_wa),
    'servicos', coalesce(v_servicos, '[]'::jsonb)));
end;
$$;

revoke all on function public.criar_agendamento(date, int, bigint[], text, text) from public;
revoke all on function public.criar_agendamento_admin(date, int, bigint[], text, text) from public;
revoke all on function public.get_indisponiveis(date) from public;
grant execute on function public.criar_agendamento(date, int, bigint[], text, text) to anon, authenticated;
grant execute on function public.criar_agendamento_admin(date, int, bigint[], text, text) to authenticated;
grant execute on function public.get_indisponiveis(date) to anon, authenticated;

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

create or replace function public.ajustar_agendamento(p_id bigint, p_valor numeric) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_ag agendamentos%rowtype;
  v_base numeric;
begin
  if not public.is_admin() then raise exception 'NAO_AUTORIZADO' using errcode = '42501'; end if;
  if p_valor is null or p_valor <> round(p_valor, 2) then raise exception 'AJUSTE_INVALIDO' using errcode = '22023'; end if;
  select * into v_ag from agendamentos where id = p_id for update;
  if not found then raise exception 'AGENDAMENTO_NAO_ENCONTRADO' using errcode = 'P0002'; end if;
  if v_ag.status <> 'confirmado' then raise exception 'AGENDAMENTO_CANCELADO' using errcode = '22023'; end if;
  v_base := v_ag.valor_total - v_ag.valor_ajuste;
  if v_base + p_valor < 0 then raise exception 'AJUSTE_EXCEDE_TOTAL' using errcode = '22023'; end if;
  if v_base + p_valor < (select coalesce(sum(valor), 0) from recebimentos_agendamento where agendamento_id = p_id) then
    raise exception 'AJUSTE_ABAIXO_DO_PAGO' using errcode = '22023';
  end if;
  update agendamentos set valor_ajuste = p_valor, valor_total = v_base + p_valor where id = p_id returning * into v_ag;
  return to_jsonb(v_ag);
end;
$$;
revoke all on function public.caixa_resumo() from public;
revoke all on function public.ajustar_agendamento(bigint, numeric) from public;
grant execute on function public.caixa_resumo() to authenticated;
grant execute on function public.ajustar_agendamento(bigint, numeric) to authenticated;

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
revoke all on function public.registrar_recebimento(bigint, numeric, text) from public;
grant execute on function public.registrar_recebimento(bigint, numeric, text) to authenticated;

-- Cria um alerta (uma vez, enquanto não lido) quando o produto chega ao estoque mínimo.
create or replace function public.alerta_estoque(p_produto_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_p produtos%rowtype;
begin
  select * into v_p from produtos where id = p_produto_id;
  if not found or v_p.estoque > v_p.estoque_minimo then return; end if;
  if exists (select 1 from alertas where tipo = 'estoque_baixo' and produto_id = v_p.id and lido_em is null) then return; end if;
  insert into alertas (tipo, produto_id, titulo, mensagem)
    values ('estoque_baixo', v_p.id, 'Estoque baixo: ' || v_p.nome,
            'Restam ' || v_p.estoque || ' unidade(s). Mínimo configurado: ' || v_p.estoque_minimo || '.');
end;
$$;
-- uso interno: só as outras funções chamam (o Supabase concede execute a anon/authenticated por padrão)
revoke all on function public.alerta_estoque(bigint) from public, anon, authenticated;

create or replace function public.movimentar_estoque(p_produto_id bigint, p_quantidade int, p_tipo text, p_motivo text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_produto produtos%rowtype;
  v_delta int;
begin
  if not public.is_admin() then raise exception 'NAO_AUTORIZADO' using errcode = '42501'; end if;
  if p_quantidade is null or p_quantidade < 1 or p_tipo not in ('entrada','ajuste') then
    raise exception 'MOVIMENTO_INVALIDO' using errcode = '22023';
  end if;
  v_delta := case when p_tipo = 'entrada' then p_quantidade else -p_quantidade end;
  select * into v_produto from produtos where id = p_produto_id for update;
  if not found then raise exception 'PRODUTO_NAO_ENCONTRADO' using errcode = 'P0002'; end if;
  if v_produto.estoque + v_delta < 0 then raise exception 'ESTOQUE_INSUFICIENTE' using errcode = '22023'; end if;
  update produtos set estoque = estoque + v_delta where id = p_produto_id returning * into v_produto;
  insert into movimentos_estoque (produto_id, quantidade, tipo, motivo)
    values (p_produto_id, v_delta, p_tipo, coalesce(nullif(btrim(p_motivo), ''), case when p_tipo = 'entrada' then 'Reposição' else 'Ajuste manual' end));
  if v_delta < 0 then perform public.alerta_estoque(p_produto_id); end if;
  return to_jsonb(v_produto);
end;
$$;

create or replace function public.vender_produto_agendamento(p_agendamento_id bigint, p_produto_id bigint, p_quantidade int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_ag agendamentos%rowtype;
  v_produto produtos%rowtype;
  v_total numeric(10,2);
begin
  if not public.is_admin() then raise exception 'NAO_AUTORIZADO' using errcode = '42501'; end if;
  if p_quantidade is null or p_quantidade < 1 then raise exception 'QUANTIDADE_INVALIDA' using errcode = '22023'; end if;
  select * into v_ag from agendamentos where id = p_agendamento_id and status = 'confirmado' for update;
  if not found then raise exception 'AGENDAMENTO_NAO_ENCONTRADO' using errcode = 'P0002'; end if;
  select * into v_produto from produtos where id = p_produto_id and ativo for update;
  if not found then raise exception 'PRODUTO_NAO_ENCONTRADO' using errcode = 'P0002'; end if;
  if v_produto.estoque < p_quantidade then raise exception 'ESTOQUE_INSUFICIENTE' using errcode = '22023'; end if;
  v_total := round(v_produto.preco * p_quantidade, 2);
  update produtos set estoque = estoque - p_quantidade where id = p_produto_id;
  insert into agendamento_produtos (agendamento_id, produto_id, nome, quantidade, preco_unitario, valor_total)
    values (p_agendamento_id, p_produto_id, v_produto.nome, p_quantidade, v_produto.preco, v_total);
  insert into movimentos_estoque (produto_id, quantidade, tipo, motivo, agendamento_id)
    values (p_produto_id, -p_quantidade, 'venda', 'Venda no agendamento ' || v_ag.codigo, p_agendamento_id);
  update agendamentos set valor_produtos = valor_produtos + v_total, valor_total = valor_total + v_total
    where id = p_agendamento_id returning * into v_ag;
  perform public.alerta_estoque(p_produto_id);
  return to_jsonb(v_ag);
end;
$$;
revoke all on function public.movimentar_estoque(bigint, int, text, text) from public;
revoke all on function public.vender_produto_agendamento(bigint, bigint, int) from public;
grant execute on function public.movimentar_estoque(bigint, int, text, text) to authenticated;
grant execute on function public.vender_produto_agendamento(bigint, bigint, int) to authenticated;

create or replace function public.criar_produto(
  p_nome text, p_descricao text, p_preco numeric, p_estoque_inicial int, p_estoque_minimo int, p_ativo boolean
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_produto produtos%rowtype;
begin
  if not public.is_admin() then raise exception 'NAO_AUTORIZADO' using errcode = '42501'; end if;
  if nullif(btrim(p_nome), '') is null or p_preco is null or p_preco < 0
     or p_estoque_inicial is null or p_estoque_inicial < 0
     or p_estoque_minimo is null or p_estoque_minimo < 0 then
    raise exception 'PRODUTO_INVALIDO' using errcode = '22023';
  end if;
  insert into produtos (nome, descricao, preco, estoque, estoque_minimo, ativo)
    values (btrim(p_nome), coalesce(p_descricao, ''), p_preco, p_estoque_inicial, p_estoque_minimo, coalesce(p_ativo, true))
    returning * into v_produto;
  if p_estoque_inicial > 0 then
    insert into movimentos_estoque (produto_id, quantidade, tipo, motivo)
      values (v_produto.id, p_estoque_inicial, 'entrada', 'Estoque inicial');
  end if;
  return to_jsonb(v_produto);
end;
$$;
revoke all on function public.criar_produto(text, text, numeric, int, int, boolean) from public;
grant execute on function public.criar_produto(text, text, numeric, int, int, boolean) to authenticated;

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

create or replace function public.abrir_caixa_diario(p_data date, p_valor_abertura numeric, p_observacao text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'NAO_AUTORIZADO' using errcode = '42501'; end if;
  if p_data is null or p_valor_abertura is null or p_valor_abertura < 0 then
    raise exception 'DADOS_INVALIDOS' using errcode = '22023';
  end if;
  insert into caixas_diarios (data, valor_abertura, observacao)
    values (p_data, round(p_valor_abertura, 2), left(coalesce(btrim(p_observacao), ''), 240))
    on conflict (data) do nothing;
  if not found then raise exception 'CAIXA_JA_ABERTO' using errcode = '23505'; end if;
  return public.caixa_diario_resumo(p_data);
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
revoke all on function public.caixa_diario_resumo(date) from public;
revoke all on function public.abrir_caixa_diario(date, numeric, text) from public;
revoke all on function public.fechar_caixa_diario(date, numeric) from public;
grant execute on function public.caixa_diario_resumo(date) to authenticated;
grant execute on function public.abrir_caixa_diario(date, numeric, text) to authenticated;
grant execute on function public.fechar_caixa_diario(date, numeric) to authenticated;

create or replace function public.marcar_lembrete_enviado(p_agendamento_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_ag agendamentos%rowtype;
begin
  if not public.is_admin() then raise exception 'NAO_AUTORIZADO' using errcode = '42501'; end if;
  update agendamentos
     set lembrete_enviado_em = now(), lembrete_envios = lembrete_envios + 1
   where id = p_agendamento_id and status = 'confirmado'
   returning * into v_ag;
  if not found then
    if exists (select 1 from agendamentos where id = p_agendamento_id) then
      raise exception 'AGENDAMENTO_CANCELADO' using errcode = '22023';
    end if;
    raise exception 'AGENDAMENTO_NAO_ENCONTRADO' using errcode = 'P0002';
  end if;
  return to_jsonb(v_ag);
end;
$$;
revoke all on function public.marcar_lembrete_enviado(bigint) from public;
grant execute on function public.marcar_lembrete_enviado(bigint) to authenticated;

create or replace function public.registrar_abertura_lembrete(p_agendamento_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_ag agendamentos%rowtype;
  v_agora timestamp := now() at time zone 'America/Sao_Paulo';
begin
  if not public.is_admin() then raise exception 'NAO_AUTORIZADO' using errcode = '42501'; end if;
  select * into v_ag from agendamentos where id = p_agendamento_id and status = 'confirmado' for update;
  if not found then raise exception 'AGENDAMENTO_NAO_ENCONTRADO' using errcode = 'P0002'; end if;
  if v_ag.data < v_agora::date or (v_ag.data = v_agora::date and v_ag.inicio_min <= extract(hour from v_agora)::int * 60 + extract(minute from v_agora)::int) then
    raise exception 'AGENDAMENTO_PASSADO' using errcode = '22023';
  end if;
  update agendamentos set lembrete_aberto_em = now(), lembrete_aberturas = lembrete_aberturas + 1
   where id = p_agendamento_id returning * into v_ag;
  return to_jsonb(v_ag);
end;
$$;
revoke all on function public.registrar_abertura_lembrete(bigint) from public;
grant execute on function public.registrar_abertura_lembrete(bigint) to authenticated;

-- Cancela e devolve ao estoque os produtos vendidos na comanda.
-- p_devolver = true: devolve ao cliente o que ele pagou (um estorno por forma, no caixa de hoje).
drop function if exists public.cancelar_agendamento(bigint);
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

create or replace function public.cancelar_agendamento(p_agendamento_id bigint, p_devolver boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  return public.encerrar_agendamento(p_agendamento_id, p_devolver, 'cancelado');
end;
$$;
revoke all on function public.cancelar_agendamento(bigint, boolean) from public;
grant execute on function public.cancelar_agendamento(bigint, boolean) to authenticated;

-- Marca falta: só depois que o horário começou.
create or replace function public.marcar_falta(p_agendamento_id bigint, p_devolver boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  return public.encerrar_agendamento(p_agendamento_id, p_devolver, 'falta');
end;
$$;
revoke all on function public.marcar_falta(bigint, boolean) from public, anon;
grant execute on function public.marcar_falta(bigint, boolean) to authenticated;

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

-- Clientes: visita = agendamento confirmado cuja data já chegou. Inclui movimento por dia da semana.
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
revoke all on function public.clientes_resumo() from public;
grant execute on function public.clientes_resumo() to authenticated;

-- ------------------------------------------------------------ vendas avulsas
-- Dinheiro que entrou na gaveta no dia: pagamentos de comandas + vendas avulsas.
create or replace function public.dinheiro_do_dia(p_data date) returns numeric
language sql security definer stable set search_path = public as $$
  select coalesce((select sum(valor) from recebimentos_agendamento
                    where forma = 'dinheiro' and timezone('America/Sao_Paulo', recebido_em)::date = p_data), 0)
       + coalesce((select sum(valor_total) from vendas_avulsas
                    where forma = 'dinheiro' and status = 'ativa' and data = p_data), 0);
$$;
revoke all on function public.dinheiro_do_dia(date) from public, anon, authenticated;

-- Dinheiro devolvido da gaveta no dia.
create or replace function public.devolvido_do_dia(p_data date) returns numeric
language sql security definer stable set search_path = public as $$
  select coalesce(sum(valor), 0) from estornos
   where forma = 'dinheiro' and timezone('America/Sao_Paulo', criado_em)::date = p_data;
$$;
revoke all on function public.devolvido_do_dia(date) from public, anon, authenticated;

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


-- ------------------------------------------------------------ extrato (exportar)
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

-- ------------------------------------------------------------ dados iniciais
insert into configuracoes (chave, valor) values
  ('nome', 'Barbearia do Juan'),
  ('slogan', 'Seu estilo, Nossa assinatura'),
  ('telefone', '(11) 98811-8988'),
  ('whatsapp', '5511988118988'),
  ('endereco', 'Ernesto Rothschild, 287'),
  ('instagram', '@barbeariadojuan_'),
  ('instagram_url', 'https://www.instagram.com/barbeariadojuan_/'),
  ('desde', '2011'),
  ('logo', 'assets/logo/logo-720.png'),
  ('hero_foto', 'assets/images/hero.jpg'),
  ('sobre_foto', 'assets/images/sobre.jpg'),
  ('hero_texto', 'Desde 2011, cuidando do seu visual com qualidade, respeito e atenção aos detalhes.'),
  ('servicos_subtitulo', 'Qualidade e estilo em cada detalhe.'),
  ('sobre_titulo', 'Mais que uma barbearia, um lugar pra você.'),
  ('sobre_texto', 'Aqui, cada corte é feito com atenção, técnica e respeito ao seu estilo. Nossa missão é fazer você se sentir bem, do jeito que você gosta.'),
  ('whatsapp_msg', 'Olá! Vim pelo site da Barbearia do Juan e gostaria de agendar um horário. Pode me ajudar?'),
  ('almoco_ativo', '1'), ('almoco_inicio', '12:00'), ('almoco_fim', '13:00'),
  ('passo_min', '20'), ('antecedencia_min', '30'), ('dias_agenda', '60')
on conflict (chave) do nothing;

insert into servicos (nome, duracao_min, preco, foto, ordem) values
  ('Corte', 40, 40, 'assets/images/servico-corte.jpg', 1),
  ('Detalhamento', 20, 20, 'assets/images/servico-pezinho.jpg', 2),
  ('Barba', 30, 40, 'assets/images/servico-barba.jpg', 3),
  ('Sobrancelha', 15, 15, 'assets/images/servico-sobrancelha.jpg', 4),
  ('Alisamento', 60, 50, 'assets/images/servico-alisante.jpg', 5),
  ('Platinado', 60, 150, 'assets/images/servico-platinado.jpg', 6),
  ('Luzes', 60, 80, 'assets/images/servico-luzes.jpg', 7);

with c as (
  insert into combos (nome, descricao, preco, duracao_min, foto, ordem)
  values ('Corte + Barba', 'O combo perfeito para quem não abre mão do visual completo.', 70, 70, 'assets/images/combo-maquinas.jpg', 1)
  returning id)
insert into combo_servicos (combo_id, servico_id)
select c.id, s.id from c, servicos s where s.nome in ('Corte', 'Barba');

-- Expediente inicial (exemplo 08:00–18:00, segunda a sábado). Ajuste no painel.
insert into horarios_funcionamento (dia_semana, ativo, inicio_min, fim_min)
select d, d <> 0, 480, 1080 from generate_series(0, 6) d
on conflict (dia_semana) do nothing;

insert into galeria (foto, ordem)
select 'assets/images/galeria-' || i || '.jpg', i from generate_series(1, 8) i;

-- ------------------------------------------------------------ SEU ADMIN
-- 1) Authentication > Users > Add user (e-mail + senha do Juan).
-- 2) Rode (troque o e-mail):
-- insert into usuarios_admin (user_id, email)
-- select id, email from auth.users where email = 'EMAIL_DO_JUAN@exemplo.com';
