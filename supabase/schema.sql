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

create table if not exists agendamentos (
  id bigint generated always as identity primary key,
  codigo text not null unique,
  cliente_id bigint not null references clientes(id),
  data date not null,
  inicio_min int not null,
  fim_min int not null,
  duracao_min int not null,
  valor_total numeric(10,2) not null,
  combos_aplicados text default '',
  valor_consulta boolean not null default false,
  status text not null default 'confirmado' check (status in ('confirmado','cancelado')),
  criado_em timestamptz not null default now(),
  check (fim_min > inicio_min),
  -- Garantia final contra dupla reserva: o PRÓPRIO BANCO recusa dois agendamentos
  -- confirmados que se sobreponham no mesmo dia, mesmo se duas requisições chegarem juntas.
  constraint agendamentos_sem_conflito
    exclude using gist (data with =, int4range(inicio_min, fim_min) with &&) where (status = 'confirmado')
);
create index if not exists idx_agendamentos_data on agendamentos (data, status);

create table if not exists agendamento_servicos (
  id bigint generated always as identity primary key,
  agendamento_id bigint not null references agendamentos(id) on delete cascade,
  servico_id bigint references servicos(id) on delete set null,
  nome text,
  duracao_min int,
  preco numeric(10,2)
);

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
alter table combos enable row level security;
alter table combo_servicos enable row level security;
alter table horarios_funcionamento enable row level security;
alter table bloqueios enable row level security;
alter table galeria enable row level security;
alter table clientes enable row level security;
alter table agendamentos enable row level security;
alter table agendamento_servicos enable row level security;
alter table usuarios_admin enable row level security;

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
create policy adm_combos on combos for all using (is_admin()) with check (is_admin());
create policy adm_combo_servicos on combo_servicos for all using (is_admin()) with check (is_admin());
create policy adm_horarios on horarios_funcionamento for all using (is_admin()) with check (is_admin());
create policy adm_bloqueios on bloqueios for all using (is_admin()) with check (is_admin());
create policy adm_galeria on galeria for all using (is_admin()) with check (is_admin());
create policy adm_clientes on clientes for all using (is_admin()) with check (is_admin());
create policy adm_agendamentos on agendamentos for all using (is_admin()) with check (is_admin());
create policy adm_ag_servicos on agendamento_servicos for all using (is_admin()) with check (is_admin());
create policy proprio_admin on usuarios_admin for select using (user_id = auth.uid());

grant usage on schema public to anon, authenticated;
grant select on configuracoes, servicos, combos, combo_servicos, horarios_funcionamento, galeria to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
revoke all on clientes, agendamentos, agendamento_servicos, bloqueios, usuarios_admin from anon;

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
revoke all on function public.get_indisponiveis(date) from public;
grant execute on function public.criar_agendamento(date, int, bigint[], text, text) to anon, authenticated;
grant execute on function public.get_indisponiveis(date) to anon, authenticated;

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
