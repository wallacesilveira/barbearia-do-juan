/*
 * Servidor local da Barbearia do Juan (sem dependências externas).
 *  - serve os arquivos estáticos do site
 *  - API + banco SQLite (node:sqlite, incluso no Node 22.5+) em data/barbearia.db
 *  - toda reserva é validada AQUI, dentro de uma transação, antes de gravar.
 *
 * Uso:  node server.js            (porta 8080, ou PORT=3000 node server.js)
 *       node server.js --set-password NOVA_SENHA
 * Em produção estática o site pode usar o Supabase (ver README.md e supabase/schema.sql).
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const A = require('./js/availability.js');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8080);
const TZ = 'America/Sao_Paulo';
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
const db = new DatabaseSync(process.env.DB_FILE || path.join(ROOT, 'data', 'barbearia.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

/* ------------------------------------------------------------------ esquema */
db.exec(`
CREATE TABLE IF NOT EXISTS configuracoes (chave TEXT PRIMARY KEY, valor TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS servicos (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL, descricao TEXT DEFAULT '',
  duracao_min INTEGER NOT NULL CHECK (duracao_min BETWEEN 5 AND 600),
  preco REAL CHECK (preco IS NULL OR preco >= 0), foto TEXT DEFAULT '', ordem INTEGER DEFAULT 0, ativo INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS produtos (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL, descricao TEXT DEFAULT '',
  preco REAL NOT NULL CHECK (preco >= 0), estoque INTEGER NOT NULL DEFAULT 0 CHECK (estoque >= 0),
  estoque_minimo INTEGER NOT NULL DEFAULT 0 CHECK (estoque_minimo >= 0), ativo INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS combos (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL, descricao TEXT DEFAULT '',
  preco REAL NOT NULL CHECK (preco >= 0), duracao_min INTEGER, foto TEXT DEFAULT '', ordem INTEGER DEFAULT 0, ativo INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS combo_servicos (
  combo_id INTEGER NOT NULL REFERENCES combos(id) ON DELETE CASCADE,
  servico_id INTEGER NOT NULL REFERENCES servicos(id) ON DELETE CASCADE, PRIMARY KEY (combo_id, servico_id));
CREATE TABLE IF NOT EXISTS horarios_funcionamento (
  dia_semana INTEGER PRIMARY KEY CHECK (dia_semana BETWEEN 0 AND 6), ativo INTEGER NOT NULL DEFAULT 1,
  inicio_min INTEGER NOT NULL, fim_min INTEGER NOT NULL CHECK (fim_min > inicio_min));
CREATE TABLE IF NOT EXISTS bloqueios (
  id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL, inicio_min INTEGER NOT NULL, fim_min INTEGER NOT NULL,
  motivo TEXT DEFAULT '', CHECK (fim_min > inicio_min AND inicio_min >= 0 AND fim_min <= 1440));
CREATE TABLE IF NOT EXISTS galeria (
  id INTEGER PRIMARY KEY AUTOINCREMENT, foto TEXT NOT NULL, legenda TEXT DEFAULT '', ordem INTEGER DEFAULT 0, ativo INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS clientes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL, whatsapp TEXT NOT NULL, criado_em TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS agendamentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT NOT NULL UNIQUE, cliente_id INTEGER NOT NULL REFERENCES clientes(id),
  data TEXT NOT NULL, inicio_min INTEGER NOT NULL, fim_min INTEGER NOT NULL, duracao_min INTEGER NOT NULL,
  valor_total REAL NOT NULL, valor_ajuste REAL NOT NULL DEFAULT 0, valor_produtos REAL NOT NULL DEFAULT 0,
  lembrete_enviado_em TEXT, lembrete_envios INTEGER NOT NULL DEFAULT 0,
  lembrete_aberto_em TEXT, lembrete_aberturas INTEGER NOT NULL DEFAULT 0,
  combos_aplicados TEXT DEFAULT '', valor_consulta INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'confirmado' CHECK (status IN ('confirmado','cancelado','falta')), criado_em TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS recebimentos_agendamento (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agendamento_id INTEGER NOT NULL REFERENCES agendamentos(id) ON DELETE CASCADE,
  valor REAL NOT NULL CHECK (valor > 0),
  forma TEXT NOT NULL CHECK (forma IN ('dinheiro','pix','cartao','outro')),
  recebido_em TEXT NOT NULL DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS agendamento_produtos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agendamento_id INTEGER NOT NULL REFERENCES agendamentos(id) ON DELETE CASCADE,
  produto_id INTEGER REFERENCES produtos(id) ON DELETE SET NULL,
  nome TEXT NOT NULL, quantidade INTEGER NOT NULL CHECK (quantidade > 0),
  preco_unitario REAL NOT NULL CHECK (preco_unitario >= 0), valor_total REAL NOT NULL CHECK (valor_total >= 0));
CREATE TABLE IF NOT EXISTS movimentos_estoque (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE RESTRICT,
  quantidade INTEGER NOT NULL CHECK (quantidade <> 0), tipo TEXT NOT NULL CHECK (tipo IN ('entrada','ajuste','venda')),
  motivo TEXT NOT NULL DEFAULT '', agendamento_id INTEGER REFERENCES agendamentos(id) ON DELETE SET NULL,
  criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS caixas_diarios (
  data TEXT PRIMARY KEY,
  valor_abertura REAL NOT NULL CHECK (valor_abertura >= 0),
  valor_contado REAL CHECK (valor_contado IS NULL OR valor_contado >= 0),
  diferenca REAL,
  observacao TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto','fechado')),
  aberto_em TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  fechado_em TEXT);
CREATE TABLE IF NOT EXISTS alertas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL CHECK (tipo IN ('novo_agendamento','estoque_baixo')),
  agendamento_id INTEGER REFERENCES agendamentos(id) ON DELETE CASCADE,
  produto_id INTEGER REFERENCES produtos(id) ON DELETE CASCADE,
  titulo TEXT NOT NULL, mensagem TEXT NOT NULL DEFAULT '',
  criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime')), lido_em TEXT);
CREATE INDEX IF NOT EXISTS idx_alertas_lido ON alertas (lido_em, id);
CREATE INDEX IF NOT EXISTS idx_agend_data ON agendamentos (data, status);
CREATE INDEX IF NOT EXISTS idx_receb_ag ON recebimentos_agendamento (agendamento_id, recebido_em);
CREATE INDEX IF NOT EXISTS idx_agprod_ag ON agendamento_produtos (agendamento_id, id);
CREATE INDEX IF NOT EXISTS idx_mov_estoque_prod ON movimentos_estoque (produto_id, criado_em);
CREATE TABLE IF NOT EXISTS agendamento_servicos (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agendamento_id INTEGER NOT NULL REFERENCES agendamentos(id) ON DELETE CASCADE,
  servico_id INTEGER REFERENCES servicos(id) ON DELETE SET NULL, nome TEXT, duracao_min INTEGER, preco REAL);
CREATE TABLE IF NOT EXISTS usuarios_admin (usuario TEXT PRIMARY KEY, senha_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS vendas_avulsas (
  id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL,
  cliente_id INTEGER REFERENCES clientes(id) ON DELETE SET NULL, cliente_nome TEXT NOT NULL DEFAULT '',
  valor_total REAL NOT NULL CHECK (valor_total >= 0),
  forma TEXT NOT NULL CHECK (forma IN ('dinheiro','pix','cartao','outro')),
  status TEXT NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa','cancelada')),
  criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime')), cancelada_em TEXT);
CREATE TABLE IF NOT EXISTS vendas_avulsas_itens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venda_id INTEGER NOT NULL REFERENCES vendas_avulsas(id) ON DELETE CASCADE,
  produto_id INTEGER REFERENCES produtos(id) ON DELETE SET NULL,
  nome TEXT NOT NULL, quantidade INTEGER NOT NULL CHECK (quantidade > 0),
  preco_unitario REAL NOT NULL CHECK (preco_unitario >= 0), valor_total REAL NOT NULL CHECK (valor_total >= 0));
CREATE INDEX IF NOT EXISTS idx_vendas_avulsas_data ON vendas_avulsas (data, status);
CREATE INDEX IF NOT EXISTS idx_vendas_avulsas_itens ON vendas_avulsas_itens (venda_id, id);
CREATE TABLE IF NOT EXISTS estornos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agendamento_id INTEGER NOT NULL REFERENCES agendamentos(id) ON DELETE CASCADE,
  valor REAL NOT NULL CHECK (valor > 0),
  forma TEXT NOT NULL CHECK (forma IN ('dinheiro','pix','cartao','outro')),
  criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime')));
CREATE INDEX IF NOT EXISTS idx_estornos_ag ON estornos (agendamento_id);
CREATE TABLE IF NOT EXISTS remarcacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agendamento_id INTEGER NOT NULL REFERENCES agendamentos(id) ON DELETE CASCADE,
  data_anterior TEXT NOT NULL, inicio_anterior INTEGER NOT NULL,
  data_nova TEXT NOT NULL, inicio_novo INTEGER NOT NULL,
  criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime')));
CREATE INDEX IF NOT EXISTS idx_remarcacoes_ag ON remarcacoes (agendamento_id);
CREATE TABLE IF NOT EXISTS movimentos_caixa (
  id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('sangria','despesa','reforco')),
  valor REAL NOT NULL CHECK (valor > 0),
  forma TEXT NOT NULL DEFAULT 'dinheiro' CHECK (forma IN ('dinheiro','pix','cartao','outro')),
  descricao TEXT NOT NULL DEFAULT '',
  criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime')));
CREATE INDEX IF NOT EXISTS idx_movimentos_caixa_data ON movimentos_caixa (data);
`);
try {
  const cols = db.prepare('PRAGMA table_info(agendamentos)').all();
  const temAjuste = cols.some((c) => c.name === 'valor_ajuste');
  const temProdutos = cols.some((c) => c.name === 'valor_produtos');
  const temLembreteEnviado = cols.some((c) => c.name === 'lembrete_enviado_em');
  const temLembreteEnvios = cols.some((c) => c.name === 'lembrete_envios');
  const temLembreteAberto = cols.some((c) => c.name === 'lembrete_aberto_em');
  const temLembreteAberturas = cols.some((c) => c.name === 'lembrete_aberturas');
  const temAntigo = cols.some((c) => c.name === 'valor_adicional');
  if (!temAjuste && temAntigo) {
    db.exec('ALTER TABLE agendamentos RENAME COLUMN valor_adicional TO valor_ajuste');
  } else if (!temAjuste) {
    db.exec('ALTER TABLE agendamentos ADD COLUMN valor_ajuste REAL NOT NULL DEFAULT 0');
  }
  if (!temProdutos) db.exec('ALTER TABLE agendamentos ADD COLUMN valor_produtos REAL NOT NULL DEFAULT 0');
  if (!temLembreteEnviado) db.exec('ALTER TABLE agendamentos ADD COLUMN lembrete_enviado_em TEXT');
  if (!temLembreteEnvios) db.exec('ALTER TABLE agendamentos ADD COLUMN lembrete_envios INTEGER NOT NULL DEFAULT 0');
  if (!temLembreteAberto) db.exec('ALTER TABLE agendamentos ADD COLUMN lembrete_aberto_em TEXT');
  if (!temLembreteAberturas) db.exec('ALTER TABLE agendamentos ADD COLUMN lembrete_aberturas INTEGER NOT NULL DEFAULT 0');
} catch (e) {
  /* coluna já existe */
}
// contato do cliente: e-mail e aniversário (opcionais)
{
  const colsCli = db.prepare('PRAGMA table_info(clientes)').all().map((c) => c.name);
  if (!colsCli.includes('email')) db.exec("ALTER TABLE clientes ADD COLUMN email TEXT NOT NULL DEFAULT ''");
  if (!colsCli.includes('aniversario')) db.exec('ALTER TABLE clientes ADD COLUMN aniversario TEXT');
}
// status 'falta' (cliente não apareceu): o SQLite não altera um CHECK existente, então a tabela é recriada uma única vez
{
  const def = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agendamentos'").get().sql;
  if (!def.includes("'falta'")) {
    const nova = def.replace(/^CREATE TABLE (IF NOT EXISTS )?"?agendamentos"?/i, 'CREATE TABLE agendamentos_novo')
      .replace("CHECK (status IN ('confirmado','cancelado'))", "CHECK (status IN ('confirmado','cancelado','falta'))");
    if (!nova.includes("'falta'") || !nova.startsWith('CREATE TABLE agendamentos_novo')) throw new Error('Não consegui preparar a tabela agendamentos para o status "falta".');
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(nova);
      db.exec('INSERT INTO agendamentos_novo SELECT * FROM agendamentos');
      db.exec('DROP TABLE agendamentos');
      db.exec('ALTER TABLE agendamentos_novo RENAME TO agendamentos');
      db.exec('CREATE INDEX IF NOT EXISTS idx_agend_data ON agendamentos (data, status)');
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

/* --------------------------------------------------------------- dados base */
function seed() {
  if (db.prepare('SELECT COUNT(*) n FROM configuracoes').get().n) return;
  const cfg = {
    nome: 'Barbearia do Juan', slogan: 'Seu estilo, Nossa assinatura', telefone: '(11) 98811-8988', whatsapp: '5511988118988',
    endereco: 'Ernesto Rothschild, 287', instagram: '@barbeariadojuan_', instagram_url: 'https://www.instagram.com/barbeariadojuan_/',
    desde: '2011', logo: 'assets/logo/logo-720.png', hero_foto: 'assets/images/hero.jpg', sobre_foto: 'assets/images/sobre.jpg',
    hero_texto: 'Desde 2011, cuidando do seu visual com qualidade, respeito e atenção aos detalhes.',
    servicos_subtitulo: 'Qualidade e estilo em cada detalhe.',
    sobre_titulo: 'Mais que uma barbearia, um lugar pra você.',
    sobre_texto: 'Aqui, cada corte é feito com atenção, técnica e respeito ao seu estilo. Nossa missão é fazer você se sentir bem, do jeito que você gosta.',
    whatsapp_msg: 'Olá! Vim pelo site da Barbearia do Juan e gostaria de agendar um horário. Pode me ajudar?',
    almoco_ativo: '1', almoco_inicio: '12:00', almoco_fim: '13:00', passo_min: '20', antecedencia_min: '30', dias_agenda: '60',
  };
  const ic = db.prepare('INSERT INTO configuracoes (chave, valor) VALUES (?, ?)');
  for (const [k, v] of Object.entries(cfg)) ic.run(k, v);

  const servicos = [
    ['Corte', 40, 40, 'servico-corte'], ['Detalhamento', 20, 20, 'servico-pezinho'], ['Barba', 30, 40, 'servico-barba'],
    ['Sobrancelha', 15, 15, 'servico-sobrancelha'], ['Alisamento', 60, 50, 'servico-alisante'],
    ['Platinado', 60, 150, 'servico-platinado'], ['Luzes', 60, 80, 'servico-luzes'],
  ];
  const is = db.prepare('INSERT INTO servicos (nome, duracao_min, preco, foto, ordem) VALUES (?, ?, ?, ?, ?)');
  servicos.forEach((s, i) => is.run(s[0], s[1], s[2], `assets/images/${s[3]}.jpg`, i + 1));

  const combo = db.prepare('INSERT INTO combos (nome, descricao, preco, duracao_min, foto, ordem) VALUES (?, ?, ?, ?, ?, 1)')
    .run('Corte + Barba', 'O combo perfeito para quem não abre mão do visual completo.', 70, 70, 'assets/images/combo-maquinas.jpg');
  const cs = db.prepare('INSERT INTO combo_servicos (combo_id, servico_id) VALUES (?, ?)');
  cs.run(combo.lastInsertRowid, 1); cs.run(combo.lastInsertRowid, 3);

  // Expediente inicial (exemplo do briefing 08:00–18:00, seg–sáb). O Juan ajusta no painel.
  const ih = db.prepare('INSERT INTO horarios_funcionamento (dia_semana, ativo, inicio_min, fim_min) VALUES (?, ?, 480, 1080)');
  for (let d = 0; d < 7; d++) ih.run(d, d === 0 ? 0 : 1);

  const ig = db.prepare('INSERT INTO galeria (foto, ordem) VALUES (?, ?)');
  for (let i = 1; i <= 8; i++) ig.run(`assets/images/galeria-${i}.jpg`, i);
}
seed();

function hashSenha(senha, salt = crypto.randomBytes(16).toString('hex')) {
  return salt + ':' + crypto.scryptSync(senha, salt, 32).toString('hex');
}
function confereSenha(senha, salvo) {
  const [salt, h] = salvo.split(':');
  const novo = crypto.scryptSync(senha, salt, 32);
  const velho = Buffer.from(h, 'hex');
  return novo.length === velho.length && crypto.timingSafeEqual(novo, velho);
}
function definirSenha(usuario, senha) {
  db.prepare('INSERT INTO usuarios_admin (usuario, senha_hash) VALUES (?, ?) ON CONFLICT(usuario) DO UPDATE SET senha_hash = excluded.senha_hash')
    .run(usuario, hashSenha(senha));
}
const argSenha = process.argv.indexOf('--set-password');
if (argSenha > -1) {
  definirSenha('admin', process.argv[argSenha + 1] || '');
  console.log('Senha do usuário "admin" atualizada.');
  process.exit(0);
}
if (!db.prepare('SELECT COUNT(*) n FROM usuarios_admin').get().n) {
  const senha = process.env.ADMIN_PASSWORD || crypto.randomBytes(5).toString('hex');
  definirSenha('admin', senha);
  console.log('\n  Painel admin criado. Usuário: admin   Senha: ' + senha);
  console.log('  (troque com: node server.js --set-password NOVA_SENHA)\n');
}

/* ------------------------------------------------------------------ helpers */
const BOOL = ['ativo'];
const tratar = (r) => { if (r) BOOL.forEach((k) => { if (k in r) r[k] = !!r[k]; }); return r; };
const todos = (sql, ...p) => db.prepare(sql).all(...p).map((r) => tratar({ ...r }));
const um = (sql, ...p) => { const r = db.prepare(sql).get(...p); return r ? tratar({ ...r }) : null; };

function agoraSP() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { data: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute) };
}
function getConfig() {
  return Object.fromEntries(db.prepare('SELECT chave, valor FROM configuracoes').all().map((r) => [r.chave, r.valor]));
}
function getCombos(soAtivos) {
  const combos = todos(`SELECT * FROM combos ${soAtivos ? 'WHERE ativo = 1' : ''} ORDER BY ordem, id`);
  const links = db.prepare('SELECT * FROM combo_servicos').all();
  combos.forEach((c) => { c.servico_ids = links.filter((l) => l.combo_id === c.id).map((l) => l.servico_id); });
  return combos;
}
function siteData(admin) {
  const w = admin ? '' : 'WHERE ativo = 1';
  const out = {
    config: getConfig(),
    servicos: todos(`SELECT * FROM servicos ${w} ORDER BY ordem, id`),
    combos: getCombos(!admin),
    horarios: todos('SELECT * FROM horarios_funcionamento ORDER BY dia_semana'),
    galeria: todos(`SELECT * FROM galeria ${w} ORDER BY ordem, id`),
  };
  if (admin) {
    out.bloqueios = todos('SELECT * FROM bloqueios ORDER BY data, inicio_min');
    out.produtos = todos('SELECT * FROM produtos ORDER BY nome COLLATE NOCASE');
  }
  return out;
}
function indisponiveis(data) {
  return [
    ...db.prepare("SELECT inicio_min ini, fim_min fim FROM agendamentos WHERE data = ? AND status = 'confirmado'").all(data),
    ...db.prepare('SELECT inicio_min ini, fim_min fim FROM bloqueios WHERE data = ?').all(data),
  ].map((r) => ({ ...r }));
}
function formatarAgendamento(a) {
  const cli = db.prepare('SELECT nome, whatsapp FROM clientes WHERE id = ?').get(a.cliente_id);
  if (cli) cli.nome = padronizarNome(cli.nome);
  const servicos = db.prepare('SELECT nome, duracao_min, preco FROM agendamento_servicos WHERE agendamento_id = ? ORDER BY id').all(a.id).map((s) => ({ ...s }));
  const produtos = db.prepare('SELECT nome, quantidade, preco_unitario, valor_total FROM agendamento_produtos WHERE agendamento_id = ? ORDER BY id').all(a.id).map((p) => ({ ...p }));
  const pagamentos = db.prepare('SELECT id, valor, forma, recebido_em FROM recebimentos_agendamento WHERE agendamento_id = ? ORDER BY recebido_em, id').all(a.id).map((p) => ({ ...p, valor: Number(p.valor) }));
  const totalPago = Math.round(pagamentos.reduce((s, p) => s + p.valor, 0) * 100) / 100;
  const estornos = db.prepare('SELECT id, valor, forma, criado_em FROM estornos WHERE agendamento_id = ? ORDER BY id').all(a.id).map((e) => ({ ...e, valor: Number(e.valor) }));
  const remarcacoes = db.prepare('SELECT data_anterior, inicio_anterior, data_nova, inicio_novo, criado_em FROM remarcacoes WHERE agendamento_id = ? ORDER BY id').all(a.id).map((r) => ({ ...r }));
  const { cliente_id, ...resto } = a;
  return { ...resto, valor_consulta: !!a.valor_consulta, valor_ajuste: Number(a.valor_ajuste || 0), valor_produtos: Number(a.valor_produtos || 0), total_pago: totalPago, saldo_devedor: Math.max(0, Number(a.valor_total || 0) - totalPago), pagamentos, estornos, remarcacoes, cliente: { ...cli }, servicos, produtos };
}
const centavos = (v) => Math.round(Number(v || 0) * 100) / 100;
function isoMais(iso, dias) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + dias)).toISOString().slice(0, 10);
}
/** Intervalos de data (fuso de São Paulo) usados no Caixa. */
function periodos() {
  const hoje = agoraSP().data;
  const [y, m] = hoje.split('-').map(Number);
  const dow = new Date(hoje + 'T12:00:00Z').getUTCDay();
  const segunda = isoMais(hoje, dow === 0 ? -6 : 1 - dow);
  return {
    hoje: { de: hoje, ate: hoje },
    semana: { de: segunda, ate: isoMais(segunda, 6) },
    mes: { de: hoje.slice(0, 7) + '-01', ate: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) },
    ano: { de: `${y}-01-01`, ate: `${y}-12-31` },
    total: { de: '0000-01-01', ate: '9999-12-31' },
  };
}
function resumoCaixa() {
  const somaPeriodo = db.prepare(`
    SELECT COUNT(*) AS agendamentos,
      COALESCE(SUM(valor_total - valor_ajuste - valor_produtos), 0) AS servicos,
      COALESCE(SUM(valor_produtos), 0) AS produtos,
      COALESCE(SUM(CASE WHEN valor_ajuste > 0 THEN valor_ajuste ELSE 0 END), 0) AS adicionais,
      COALESCE(SUM(CASE WHEN valor_ajuste < 0 THEN -valor_ajuste ELSE 0 END), 0) AS descontos,
      COALESCE(SUM(valor_total), 0) AS total,
      COALESCE(SUM((SELECT SUM(r.valor) FROM recebimentos_agendamento r WHERE r.agendamento_id = agendamentos.id)), 0) AS pago
    FROM agendamentos WHERE status = 'confirmado' AND data BETWEEN ? AND ?`);
  const porForma = db.prepare(`SELECT forma, SUM(valor) AS total FROM recebimentos_agendamento
    WHERE date(recebido_em) BETWEEN ? AND ? GROUP BY forma`);
  const somaAvulsas = db.prepare(`SELECT COUNT(*) AS vendas, COALESCE(SUM(valor_total), 0) AS total
    FROM vendas_avulsas WHERE status = 'ativa' AND data BETWEEN ? AND ?`);
  const porFormaAvulsas = db.prepare(`SELECT forma, SUM(valor_total) AS total FROM vendas_avulsas
    WHERE status = 'ativa' AND data BETWEEN ? AND ? GROUP BY forma`);
  const porFormaEstornos = db.prepare(`SELECT forma, SUM(valor) AS total FROM estornos
    WHERE date(criado_em) BETWEEN ? AND ? GROUP BY forma`);
  const somaDespesas = db.prepare(`SELECT COALESCE(SUM(valor), 0) AS total FROM movimentos_caixa
    WHERE tipo = 'despesa' AND data BETWEEN ? AND ?`);
  const ranking = db.prepare(`
    SELECT s.nome, COUNT(*) AS quantidade, COALESCE(SUM(s.preco), 0) AS valor
    FROM agendamento_servicos s JOIN agendamentos a ON a.id = s.agendamento_id
    WHERE a.status = 'confirmado' AND a.data BETWEEN ? AND ?
    GROUP BY s.nome ORDER BY quantidade DESC, s.nome COLLATE NOCASE LIMIT 5`);

  const out = {};
  for (const [k, { de, ate }] of Object.entries(periodos())) {
    const p = somaPeriodo.get(de, ate);
    const formas = { dinheiro: 0, pix: 0, cartao: 0, outro: 0 };
    porForma.all(de, ate).forEach((f) => { formas[f.forma] = centavos(f.total); });
    // vendas avulsas (balcão, sem agendamento) entram como produtos e já estão pagas
    const av = somaAvulsas.get(de, ate);
    porFormaAvulsas.all(de, ate).forEach((f) => { formas[f.forma] = centavos(formas[f.forma] + Number(f.total)); });
    // devoluções de agendamentos cancelados saem da forma em que o cliente pagou
    let devolvido = 0;
    porFormaEstornos.all(de, ate).forEach((f) => { formas[f.forma] = centavos(formas[f.forma] - Number(f.total)); devolvido += Number(f.total); });
    const total = centavos(Number(p.total) + Number(av.total));
    const recebido = centavos(Object.values(formas).reduce((s, v) => s + v, 0));
    const despesas = centavos(somaDespesas.get(de, ate).total);
    out[k] = {
      de, ate,
      agendamentos: Number(p.agendamentos || 0),
      servicos: centavos(p.servicos),
      produtos: centavos(Number(p.produtos) + Number(av.total)),
      vendas_avulsas: Number(av.vendas || 0),
      valor_avulsas: centavos(av.total),
      adicionais: centavos(p.adicionais),
      descontos: centavos(p.descontos),
      total,
      a_receber: centavos(Math.max(0, Number(p.total) - Number(p.pago || 0))),
      ticket_medio: p.agendamentos ? centavos(p.total / p.agendamentos) : 0,
      recebido,
      devolvido: centavos(devolvido),
      despesas,
      saldo: centavos(recebido - despesas),
      por_forma: formas,
      servicos_mais_vendidos: ranking.all(de, ate).map((s) => ({ nome: s.nome, quantidade: Number(s.quantidade), valor: centavos(s.valor) })),
    };
  }
  return out;
}
/** Dinheiro que entrou na gaveta no dia: pagamentos de comandas + vendas avulsas. */
function dinheiroDoDia(data) {
  const comandas = Number(db.prepare(`SELECT COALESCE(SUM(valor), 0) AS total
    FROM recebimentos_agendamento WHERE forma = 'dinheiro' AND date(recebido_em) = ?`).get(data).total || 0);
  const avulsas = Number(db.prepare(`SELECT COALESCE(SUM(valor_total), 0) AS total
    FROM vendas_avulsas WHERE forma = 'dinheiro' AND status = 'ativa' AND data = ?`).get(data).total || 0);
  return centavos(comandas + avulsas);
}
/** Dinheiro devolvido da gaveta no dia (estornos de agendamentos cancelados). */
function devolvidoDoDia(data) {
  return centavos(db.prepare(`SELECT COALESCE(SUM(valor), 0) AS total
    FROM estornos WHERE forma = 'dinheiro' AND date(criado_em) = ?`).get(data).total || 0);
}
/** Dinheiro não entra numa gaveta já conferida: com o caixa de hoje fechado, só pix/cartão/outro. */
function exigirCaixaNaoFechado() {
  const caixa = db.prepare('SELECT status FROM caixas_diarios WHERE data = ?').get(agoraSP().data);
  if (caixa && caixa.status === 'fechado') {
    throw new Erro(409, 'CAIXA_FECHADO_DINHEIRO', 'O caixa de hoje já foi fechado. Registre em pix, cartão ou outro, ou receba o dinheiro amanhã.');
  }
}
/** Sangrias, despesas e reforços lançados no caixa do dia. */
function movimentosCaixa(data) {
  return db.prepare('SELECT id, tipo, valor, forma, descricao, criado_em FROM movimentos_caixa WHERE data = ? ORDER BY id').all(data)
    .map((mv) => ({ ...mv, valor: Number(mv.valor) }));
}
/** Conta da gaveta: troco + entradas em dinheiro + reforços − devoluções − sangrias − despesas em dinheiro. */
function contaGaveta(data, abertura) {
  const movs = movimentosCaixa(data);
  const soma = (fn) => centavos(movs.filter(fn).reduce((t, mv) => t + mv.valor, 0));
  const c = {
    recebido_dinheiro: dinheiroDoDia(data),
    devolvido_dinheiro: devolvidoDoDia(data),
    sangrias: soma((mv) => mv.tipo === 'sangria'),
    despesas_dinheiro: soma((mv) => mv.tipo === 'despesa' && mv.forma === 'dinheiro'),
    reforcos: soma((mv) => mv.tipo === 'reforco'),
    movimentos: movs,
  };
  c.saidas_dinheiro = centavos(c.devolvido_dinheiro + c.sangrias + c.despesas_dinheiro);
  c.valor_esperado = abertura == null ? null : centavos(abertura + c.recebido_dinheiro + c.reforcos - c.saidas_dinheiro);
  return c;
}
function resumoCaixaDiario(data) {
  const caixa = db.prepare('SELECT * FROM caixas_diarios WHERE data = ?').get(data);
  const valorAbertura = caixa ? Number(caixa.valor_abertura) : null;
  const { valor_esperado: valorEsperado, ...conta } = contaGaveta(data, valorAbertura);
  return {
    data,
    status: caixa ? caixa.status : 'nao_aberto',
    valor_abertura: valorAbertura,
    ...conta,
    valor_esperado: valorEsperado,
    valor_contado: caixa && caixa.valor_contado != null ? Number(caixa.valor_contado) : null,
    diferenca: caixa && caixa.diferenca != null ? Number(caixa.diferenca) : null,
    observacao: caixa ? caixa.observacao : '',
    aberto_em: caixa ? caixa.aberto_em : null,
    fechado_em: caixa ? caixa.fechado_em : null,
  };
}
const FORMAS_PAGAMENTO = ['dinheiro', 'pix', 'cartao', 'outro'];
function vendaAvulsa(id) {
  const v = db.prepare('SELECT * FROM vendas_avulsas WHERE id = ?').get(id);
  if (!v) return null;
  const itens = db.prepare('SELECT produto_id, nome, quantidade, preco_unitario, valor_total FROM vendas_avulsas_itens WHERE venda_id = ? ORDER BY id').all(id)
    .map((i) => ({ ...i, preco_unitario: Number(i.preco_unitario), valor_total: Number(i.valor_total) }));
  return { ...v, valor_total: Number(v.valor_total), itens };
}
function listarVendasAvulsas(data) {
  return db.prepare('SELECT id FROM vendas_avulsas WHERE data = ? ORDER BY id DESC').all(data).map((v) => vendaAvulsa(v.id));
}
/**
 * Extrato para o contador: todo dinheiro que entrou ou saiu no período, pela data do movimento.
 * valor > 0 é entrada, valor < 0 é saída. quando = 'YYYY-MM-DD HH:MM' (horário de São Paulo).
 */
function extrato(de, ate) {
  const hm = (s) => String(s || '').slice(0, 16);
  const linhas = [
    ...db.prepare(`SELECT r.recebido_em AS quando, r.valor, r.forma, a.codigo, c.nome FROM recebimentos_agendamento r
      JOIN agendamentos a ON a.id = r.agendamento_id JOIN clientes c ON c.id = a.cliente_id
      WHERE date(r.recebido_em) BETWEEN ? AND ?`).all(de, ate)
      .map((r) => ({ quando: hm(r.quando), tipo: 'Pagamento de atendimento', descricao: `${padronizarNome(r.nome)} · ${r.codigo}`, forma: r.forma, valor: centavos(r.valor) })),
    ...db.prepare(`SELECT v.id, v.criado_em AS quando, v.valor_total, v.forma, v.cliente_nome,
        (SELECT GROUP_CONCAT(CASE WHEN i.quantidade > 1 THEN i.quantidade || '× ' ELSE '' END || i.nome, ', ') FROM vendas_avulsas_itens i WHERE i.venda_id = v.id) AS itens
      FROM vendas_avulsas v WHERE v.status = 'ativa' AND v.data BETWEEN ? AND ?`).all(de, ate)
      .map((v) => ({ quando: hm(v.quando), tipo: 'Venda avulsa', descricao: [v.itens, v.cliente_nome ? padronizarNome(v.cliente_nome) : ''].filter(Boolean).join(' · '), forma: v.forma, valor: centavos(v.valor_total) })),
    ...db.prepare(`SELECT e.criado_em AS quando, e.valor, e.forma, a.codigo, a.status, c.nome FROM estornos e
      JOIN agendamentos a ON a.id = e.agendamento_id JOIN clientes c ON c.id = a.cliente_id
      WHERE date(e.criado_em) BETWEEN ? AND ?`).all(de, ate)
      .map((e) => ({ quando: hm(e.quando), tipo: 'Devolução ao cliente', descricao: `${padronizarNome(e.nome)} · ${e.codigo} ${e.status === 'falta' ? 'com falta' : 'cancelado'}`, forma: e.forma, valor: -centavos(e.valor) })),
    ...db.prepare('SELECT criado_em AS quando, tipo, valor, forma, descricao FROM movimentos_caixa WHERE data BETWEEN ? AND ?').all(de, ate)
      .map((mv) => ({ quando: hm(mv.quando), tipo: { despesa: 'Despesa', sangria: 'Sangria (retirada da gaveta)', reforco: 'Reforço de troco' }[mv.tipo], descricao: mv.descricao, forma: mv.forma, valor: mv.tipo === 'reforco' ? centavos(mv.valor) : -centavos(mv.valor) })),
  ];
  return linhas.sort((a, b) => a.quando.localeCompare(b.quando));
}
/** Visita = agendamento confirmado cuja data já chegou. Cancelados e futuros não contam. */
function clientesResumo() {
  const hoje = agoraSP().data;
  const clientes = db.prepare(`
    SELECT c.id, c.nome, c.whatsapp, c.email, c.aniversario, c.criado_em,
      COALESCE(SUM(CASE WHEN a.status = 'confirmado' AND a.data <= :hoje THEN 1 END), 0) AS visitas,
      COALESCE(SUM(CASE WHEN a.status = 'confirmado' AND a.data > :hoje THEN 1 END), 0) AS futuros,
      COALESCE(SUM(CASE WHEN a.status = 'confirmado' AND a.data <= :hoje THEN a.valor_total END), 0) AS total_gasto,
      MAX(CASE WHEN a.status = 'confirmado' AND a.data <= :hoje THEN a.data END) AS ultima_visita,
      MIN(CASE WHEN a.status = 'confirmado' AND a.data > :hoje THEN a.data END) AS proxima_visita,
      COALESCE(SUM(CASE WHEN a.status = 'falta' THEN 1 END), 0) AS faltas
    FROM clientes c LEFT JOIN agendamentos a ON a.cliente_id = c.id
    GROUP BY c.id
    ORDER BY visitas DESC, total_gasto DESC, c.nome COLLATE NOCASE`).all({ hoje }).map((c) => ({
    id: c.id,
    nome: padronizarNome(c.nome),
    whatsapp: c.whatsapp,
    email: c.email || '',
    aniversario: c.aniversario || null,
    criado_em: c.criado_em,
    visitas: Number(c.visitas),
    futuros: Number(c.futuros),
    total_gasto: centavos(c.total_gasto),
    ultima_visita: c.ultima_visita || null,
    proxima_visita: c.proxima_visita || null,
    faltas: Number(c.faltas),
  }));

  // movimento por dia da semana (0 = domingo), só atendimentos que já aconteceram
  const semana = Array.from({ length: 7 }, (_, dia) => ({ dia, agendamentos: 0 }));
  db.prepare(`SELECT CAST(strftime('%w', data) AS INTEGER) AS dia, COUNT(*) AS n FROM agendamentos
    WHERE status = 'confirmado' AND data <= ? GROUP BY dia`).all(hoje).forEach((r) => { semana[r.dia].agendamentos = Number(r.n); });
  const abertos = db.prepare('SELECT dia_semana FROM horarios_funcionamento WHERE ativo = 1').all().map((h) => h.dia_semana);
  return { clientes, semana, abertos };
}

/* ------------------------------------------------------------------ alertas */
function criarAlerta(tipo, { agendamento_id = null, produto_id = null, titulo, mensagem = '' }) {
  db.prepare('INSERT INTO alertas (tipo, agendamento_id, produto_id, titulo, mensagem) VALUES (?, ?, ?, ?, ?)')
    .run(tipo, agendamento_id, produto_id, titulo, mensagem);
}
/** Avisa uma única vez quando o produto atinge o estoque mínimo (enquanto não for lido). */
function alertaEstoque(produtoId) {
  const p = db.prepare('SELECT id, nome, estoque, estoque_minimo FROM produtos WHERE id = ?').get(produtoId);
  if (!p || p.estoque > p.estoque_minimo) return;
  const pendente = db.prepare("SELECT 1 FROM alertas WHERE tipo = 'estoque_baixo' AND produto_id = ? AND lido_em IS NULL").get(p.id);
  if (!pendente) criarAlerta('estoque_baixo', { produto_id: p.id, titulo: `Estoque baixo: ${p.nome}`, mensagem: `Restam ${p.estoque} unidade(s). Mínimo configurado: ${p.estoque_minimo}.` });
}
function listarAlertas(limite) {
  const alertas = db.prepare(`SELECT al.*, a.codigo, a.data, a.inicio_min FROM alertas al
    LEFT JOIN agendamentos a ON a.id = al.agendamento_id ORDER BY al.id DESC LIMIT ?`).all(limite).map((r) => ({ ...r }));
  const naoLidos = db.prepare('SELECT COUNT(*) AS n FROM alertas WHERE lido_em IS NULL').get().n;
  return { nao_lidos: Number(naoLidos), alertas };
}
class Erro extends Error { constructor(status, codigo, msg) { super(msg || codigo); this.status = status; this.codigo = codigo; } }

/* -------------------------------------------------------------- agendamento */
const DIGITOS = (s) => String(s || '').replace(/\D/g, '');
const PARTICULAS_NOME = new Set(['da', 'das', 'de', 'do', 'dos', 'e']);
function padronizarNome(valor) {
  return String(valor || '').trim().replace(/\s+/g, ' ').split(' ').map((palavra, indice) => {
    const minuscula = palavra.toLocaleLowerCase('pt-BR');
    if (indice > 0 && PARTICULAS_NOME.has(minuscula)) return minuscula;
    return palavra.split(/([-'])/).map((parte) => {
      if (parte === '-' || parte === "'") return parte;
      return parte ? parte.charAt(0).toLocaleUpperCase('pt-BR') + parte.slice(1).toLocaleLowerCase('pt-BR') : parte;
    }).join('');
  }).join(' ');
}

function criarAgendamento(b) {
  const nome = padronizarNome(b.nome);
  const wa = DIGITOS(b.whatsapp);
  if (nome.length < 3 || nome.length > 80 || wa.length < 10 || wa.length > 13) return { ok: false, erro: 'DADOS_INVALIDOS' };
  const data = String(b.data || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || !Number.isInteger(b.inicio_min)) return { ok: false, erro: 'DADOS_INVALIDOS' };
  const ids = [...new Set((Array.isArray(b.servico_ids) ? b.servico_ids : []).map(Number))];
  // Valores financeiros nunca vêm do site público: ajustes só existem no painel.

  db.exec('BEGIN IMMEDIATE'); // trava de escrita: dois pedidos nunca validam ao mesmo tempo
  try {
    // Preço e duração vêm SEMPRE do banco, nunca do navegador.
    const servicos = todos('SELECT * FROM servicos WHERE ativo = 1');
    const selecionados = servicos.filter((s) => ids.includes(s.id));
    if (!ids.length || selecionados.length !== ids.length) { db.exec('ROLLBACK'); return { ok: false, erro: 'SERVICO_INVALIDO' }; }
    const preco = A.calcPricing(ids, servicos, getCombos(true));

    const config = getConfig();
    const r = A.validarHorario({
      data, inicio_min: b.inicio_min, duracao: preco.duracao,
      horarios: todos('SELECT * FROM horarios_funcionamento'), config,
      bloqueios: todos('SELECT * FROM bloqueios WHERE data = ?', data),
      ocupados: db.prepare("SELECT inicio_min ini, fim_min fim FROM agendamentos WHERE data = ? AND status = 'confirmado'").all(data).map((o) => ({ ...o })),
      agora: agoraSP(),
    });
    if (!r.ok) { db.exec('ROLLBACK'); return { ok: false, erro: r.motivo }; }

    let cli = db.prepare('SELECT id FROM clientes WHERE whatsapp = ?').get(wa);
    if (cli) db.prepare('UPDATE clientes SET nome = ? WHERE id = ?').run(nome, cli.id);
    else cli = { id: db.prepare('INSERT INTO clientes (nome, whatsapp) VALUES (?, ?)').run(nome, wa).lastInsertRowid };

    const codigo = 'BJ-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const ag = db.prepare(`INSERT INTO agendamentos (codigo, cliente_id, data, inicio_min, fim_min, duracao_min, valor_total, combos_aplicados, valor_consulta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(codigo, cli.id, data, b.inicio_min, b.inicio_min + preco.duracao, preco.duracao, preco.total,
        preco.linhas.filter((l) => l.tipo === 'combo').map((l) => l.nome).join(', '), preco.consulta ? 1 : 0);
    const isv = db.prepare('INSERT INTO agendamento_servicos (agendamento_id, servico_id, nome, duracao_min, preco) VALUES (?, ?, ?, ?, ?)');
    selecionados.forEach((s) => isv.run(ag.lastInsertRowid, s.id, s.nome, s.duracao_min, s.preco));
    const [ano, mes, dia] = data.split('-');
    criarAlerta('novo_agendamento', {
      agendamento_id: Number(ag.lastInsertRowid),
      titulo: `Novo agendamento: ${nome}`,
      mensagem: `${dia}/${mes}/${ano} às ${A.fmtMin(b.inicio_min)} · ${selecionados.map((s) => s.nome).join(' + ')}`,
    });
    db.exec('COMMIT');
    return { ok: true, agendamento: formatarAgendamento(db.prepare('SELECT * FROM agendamentos WHERE id = ?').get(ag.lastInsertRowid)) };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* já finalizada */ }
    throw e;
  }
}

function criarAgendamentoAdmin(b) {
  const nome = padronizarNome(b.nome);
  let wa = DIGITOS(b.whatsapp);
  if (wa.length > 11 && wa.startsWith('55')) wa = wa.slice(2);
  const data = String(b.data || '');
  const inicioMin = Number(b.inicio_min);
  if (!nome || nome.length > 80 || (wa && wa.length !== 10 && wa.length !== 11)
      || !/^\d{4}-\d{2}-\d{2}$/.test(data) || !Number.isInteger(inicioMin)) {
    return { ok: false, erro: 'DADOS_INVALIDOS' };
  }
  const ids = [...new Set((Array.isArray(b.servico_ids) ? b.servico_ids : []).map(Number))];
  if (!ids.length) return { ok: false, erro: 'SERVICO_INVALIDO' };

  db.exec('BEGIN IMMEDIATE');
  try {
    const servicos = todos('SELECT * FROM servicos WHERE ativo = 1');
    const selecionados = servicos.filter((s) => ids.includes(s.id));
    if (selecionados.length !== ids.length) { db.exec('ROLLBACK'); return { ok: false, erro: 'SERVICO_INVALIDO' }; }
    const preco = A.calcPricing(ids, servicos, getCombos(true));
    const validacao = A.validarHorario({
      data, inicio_min: inicioMin, duracao: preco.duracao,
      horarios: todos('SELECT * FROM horarios_funcionamento'), config: getConfig(),
      bloqueios: todos('SELECT * FROM bloqueios WHERE data = ?', data),
      ocupados: db.prepare("SELECT inicio_min ini, fim_min fim FROM agendamentos WHERE data = ? AND status = 'confirmado'").all(data).map((o) => ({ ...o })),
    });
    if (!validacao.ok) { db.exec('ROLLBACK'); return { ok: false, erro: validacao.motivo }; }

    // sem telefone, reaproveita o cliente de mesmo nome que também não tem telefone (evita duplicatas)
    const cliente = wa
      ? db.prepare('SELECT id FROM clientes WHERE whatsapp = ? ORDER BY id LIMIT 1').get(wa)
      : db.prepare("SELECT id FROM clientes WHERE whatsapp = '' AND nome = ? COLLATE NOCASE ORDER BY id LIMIT 1").get(nome);
    let clienteId;
    if (cliente) { clienteId = cliente.id; db.prepare('UPDATE clientes SET nome = ? WHERE id = ?').run(nome, clienteId); }
    else clienteId = db.prepare('INSERT INTO clientes (nome, whatsapp) VALUES (?, ?)').run(nome, wa).lastInsertRowid;

    const codigo = 'BJ-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const ag = db.prepare(`INSERT INTO agendamentos
      (codigo, cliente_id, data, inicio_min, fim_min, duracao_min, valor_total, valor_ajuste, valor_produtos, combos_aplicados, valor_consulta)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`)
      .run(codigo, clienteId, data, inicioMin, inicioMin + preco.duracao, preco.duracao, Number(preco.total),
        preco.linhas.filter((l) => l.tipo === 'combo').map((l) => l.nome).join(', '), preco.consulta ? 1 : 0);
    const insServico = db.prepare('INSERT INTO agendamento_servicos (agendamento_id, servico_id, nome, duracao_min, preco) VALUES (?, ?, ?, ?, ?)');
    selecionados.forEach((s) => insServico.run(ag.lastInsertRowid, s.id, s.nome, s.duracao_min, s.preco));
    db.exec('COMMIT');
    return { ok: true, agendamento: formatarAgendamento(db.prepare('SELECT * FROM agendamentos WHERE id = ?').get(ag.lastInsertRowid)) };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* transação já encerrada */ }
    throw e;
  }
}

/** Muda data/horário mantendo serviços, valores, pagamentos e produtos. Mesmas regras do agendamento pelo painel. */
function reagendarAgendamento(b) {
  const id = Number(b.id);
  const data = String(b.data || '');
  const inicioMin = Number(b.inicio_min);
  if (!Number.isInteger(id) || id < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(data) || !Number.isInteger(inicioMin)) return { ok: false, erro: 'DADOS_INVALIDOS' };
  db.exec('BEGIN IMMEDIATE');
  try {
    const ag = db.prepare('SELECT * FROM agendamentos WHERE id = ?').get(id);
    if (!ag) { db.exec('ROLLBACK'); return { ok: false, erro: 'AGENDAMENTO_NAO_ENCONTRADO' }; }
    if (ag.status !== 'confirmado') { db.exec('ROLLBACK'); return { ok: false, erro: 'AGENDAMENTO_CANCELADO' }; }
    if (ag.data === data && ag.inicio_min === inicioMin) { db.exec('ROLLBACK'); return { ok: false, erro: 'MESMO_HORARIO' }; }
    const validacao = A.validarHorario({
      data, inicio_min: inicioMin, duracao: ag.duracao_min,
      horarios: todos('SELECT * FROM horarios_funcionamento'), config: getConfig(),
      bloqueios: todos('SELECT * FROM bloqueios WHERE data = ?', data),
      // o próprio horário atual não conta como ocupado
      ocupados: db.prepare("SELECT inicio_min ini, fim_min fim FROM agendamentos WHERE data = ? AND status = 'confirmado' AND id <> ?").all(data, id).map((o) => ({ ...o })),
    });
    if (!validacao.ok) { db.exec('ROLLBACK'); return { ok: false, erro: validacao.motivo }; }
    db.prepare('INSERT INTO remarcacoes (agendamento_id, data_anterior, inicio_anterior, data_nova, inicio_novo) VALUES (?, ?, ?, ?, ?)')
      .run(id, ag.data, ag.inicio_min, data, inicioMin);
    // o lembrete enviado era do horário antigo: volta a "não enviado"
    db.prepare(`UPDATE agendamentos SET data = ?, inicio_min = ?, fim_min = ?,
      lembrete_enviado_em = NULL, lembrete_envios = 0, lembrete_aberto_em = NULL, lembrete_aberturas = 0 WHERE id = ?`)
      .run(data, inicioMin, inicioMin + Number(ag.duracao_min), id);
    db.exec('COMMIT');
    return { ok: true, agendamento: formatarAgendamento(db.prepare('SELECT * FROM agendamentos WHERE id = ?').get(id)) };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* transação já encerrada */ }
    throw e;
  }
}

/* ---------------------------------------------------------------- admin CRUD */
const TABELAS = {
  servicos: { cols: ['nome', 'descricao', 'duracao_min', 'preco', 'foto', 'ordem', 'ativo'], pk: 'id' },
  produtos: { cols: ['nome', 'descricao', 'preco', 'estoque', 'estoque_minimo', 'ativo'], pk: 'id' },
  combos: { cols: ['nome', 'descricao', 'preco', 'duracao_min', 'foto', 'ordem', 'ativo'], pk: 'id' },
  horarios_funcionamento: { cols: ['ativo', 'inicio_min', 'fim_min'], pk: 'dia_semana' },
  bloqueios: { cols: ['data', 'inicio_min', 'fim_min', 'motivo'], pk: 'id' },
  galeria: { cols: ['foto', 'legenda', 'ordem', 'ativo'], pk: 'id' },
};
function limparLinha(tabela, r) {
  const out = {};
  for (const c of TABELAS[tabela].cols) {
    if (!(c in r)) continue;
    let v = r[c];
    if (c === 'ativo') v = v ? 1 : 0;
    else if (['duracao_min', 'inicio_min', 'fim_min', 'ordem', 'estoque', 'estoque_minimo'].includes(c)) v = v === null || v === '' ? null : Math.round(Number(v));
    else if (c === 'preco') v = v === null || v === '' ? null : Number(v);
    else v = v == null ? '' : String(v);
    if (typeof v === 'number' && Number.isNaN(v)) throw new Erro(400, 'DADOS_INVALIDOS', 'Valor numérico inválido em ' + c);
    out[c] = v;
  }
  return out;
}
function salvar(tabela, r) {
  const t = TABELAS[tabela];
  if (!t) throw new Erro(404, 'TABELA');
  const d = limparLinha(tabela, r);
  const chaves = Object.keys(d);
  if (tabela === 'produtos') {
    if (r.id && 'estoque' in r) throw new Erro(400, 'ESTOQUE_VIA_MOVIMENTO', 'Use o ajuste de estoque para registrar alterações.');
    db.exec('BEGIN IMMEDIATE');
    try {
      let id;
      if (r.id) {
        db.prepare(`UPDATE produtos SET ${chaves.map((c) => c + ' = ?').join(',')} WHERE id = ?`).run(...chaves.map((c) => d[c]), r.id);
        id = Number(r.id);
      } else {
        id = Number(db.prepare(`INSERT INTO produtos (${chaves.join(',')}) VALUES (${chaves.map(() => '?').join(',')})`).run(...chaves.map((c) => d[c])).lastInsertRowid);
        if (Number(d.estoque) > 0) db.prepare("INSERT INTO movimentos_estoque (produto_id, quantidade, tipo, motivo) VALUES (?, ?, 'entrada', 'Estoque inicial')").run(id, d.estoque);
      }
      db.exec('COMMIT');
      return um('SELECT * FROM produtos WHERE id = ?', id);
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* transação já encerrada */ }
      if (/CHECK constraint|NOT NULL constraint/.test(e.message)) throw new Erro(400, 'DADOS_INVALIDOS', 'Valores fora do permitido.');
      throw e;
    }
  }
  if (tabela === 'horarios_funcionamento') {
    const dia = Number(r.dia_semana);
    db.prepare(`INSERT INTO horarios_funcionamento (dia_semana, ${chaves.join(',')}) VALUES (?, ${chaves.map(() => '?').join(',')})
      ON CONFLICT(dia_semana) DO UPDATE SET ${chaves.map((c) => c + '=excluded.' + c).join(',')}`).run(dia, ...chaves.map((c) => d[c]));
    return um('SELECT * FROM horarios_funcionamento WHERE dia_semana = ?', dia);
  }
  try {
    if (r.id) {
      db.prepare(`UPDATE ${tabela} SET ${chaves.map((c) => c + ' = ?').join(',')} WHERE id = ?`).run(...chaves.map((c) => d[c]), r.id);
      return um(`SELECT * FROM ${tabela} WHERE id = ?`, r.id);
    }
    const id = db.prepare(`INSERT INTO ${tabela} (${chaves.join(',')}) VALUES (${chaves.map(() => '?').join(',')})`).run(...chaves.map((c) => d[c])).lastInsertRowid;
    return um(`SELECT * FROM ${tabela} WHERE id = ?`, id);
  } catch (e) {
    if (/CHECK constraint|NOT NULL constraint/.test(e.message)) throw new Erro(400, 'DADOS_INVALIDOS', 'Valores fora do permitido.');
    throw e;
  }
}

/* --------------------------------------------------------------------- HTTP */
const sessoes = new Map(); // token -> expira
const falhas = new Map(); // ip -> {n, ate}
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };

function lerCorpo(req) {
  return new Promise((ok, no) => {
    let n = 0; const partes = [];
    req.on('data', (c) => { n += c.length; if (n > 12e6) { no(new Erro(413, 'GRANDE')); req.destroy(); } else partes.push(c); });
    req.on('end', () => { try { ok(partes.length ? JSON.parse(Buffer.concat(partes).toString()) : {}); } catch { no(new Erro(400, 'JSON')); } });
    req.on('error', no);
  });
}
const json = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };

function exigeAdmin(req) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  const exp = sessoes.get(t);
  if (!exp || exp < Date.now()) { sessoes.delete(t); throw new Erro(401, 'NAO_AUTORIZADO'); }
}

async function api(req, res, url) {
  const rota = url.pathname.replace(/^\/api\//, '');
  const m = req.method;
  if (m === 'GET' && rota === 'site') return json(res, 200, siteData(false));
  if (m === 'GET' && rota === 'indisponiveis') {
    const d = url.searchParams.get('data') || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Erro(400, 'DATA');
    return json(res, 200, indisponiveis(d));
  }
  if (m === 'POST' && rota === 'agendar') {
    const r = criarAgendamento(await lerCorpo(req));
    return json(res, r.ok ? 200 : 409, r);
  }
  if (m === 'POST' && rota === 'admin/login') {
    const ip = req.socket.remoteAddress;
    const f = falhas.get(ip);
    if (f && f.ate > Date.now()) throw new Erro(429, 'MUITAS_TENTATIVAS');
    const b = await lerCorpo(req);
    const u = db.prepare('SELECT * FROM usuarios_admin WHERE usuario = ?').get(String(b.usuario || '').trim().toLowerCase());
    if (!u || !confereSenha(String(b.senha || ''), u.senha_hash)) {
      const n = (f ? f.n : 0) + 1;
      falhas.set(ip, { n, ate: n >= 5 ? Date.now() + 60000 : 0 });
      throw new Erro(401, 'CREDENCIAIS');
    }
    falhas.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    sessoes.set(token, Date.now() + 12 * 3600e3);
    return json(res, 200, { token });
  }
  if (rota.startsWith('admin/')) {
    exigeAdmin(req);
    if (m === 'POST' && rota === 'admin/logout') { sessoes.delete((req.headers.authorization || '').replace(/^Bearer /, '')); return json(res, 200, { ok: true }); }
    if (m === 'GET' && rota === 'admin/site') return json(res, 200, siteData(true));
    if (m === 'GET' && rota === 'admin/clientes') return json(res, 200, clientesResumo());
    if (m === 'POST' && rota === 'admin/cliente') {
      const b = await lerCorpo(req);
      const novo = b.id == null || b.id === '';
      const id = novo ? 0 : Number(b.id);
      const nome = padronizarNome(b.nome);
      let wa = DIGITOS(b.whatsapp);
      if (wa.length > 11 && wa.startsWith('55')) wa = wa.slice(2);
      if ((!novo && (!Number.isInteger(id) || id < 1)) || !nome || nome.length > 80 || (wa && wa.length !== 10 && wa.length !== 11)) {
        throw new Erro(400, 'DADOS_INVALIDOS', 'Confira o nome e o WhatsApp (DDD + número).');
      }
      const email = String(b.email || '').trim().toLowerCase();
      if (email && (email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new Erro(400, 'EMAIL_INVALIDO', 'E-mail inválido. Ex.: nome@gmail.com');
      const aniversario = String(b.aniversario || '').trim() || null;
      if (aniversario) {
        const [y, mo, d] = aniversario.split('-').map(Number);
        const dt = new Date(Date.UTC(y, mo - 1, d));
        const valida = /^\d{4}-\d{2}-\d{2}$/.test(aniversario) && dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
        if (!valida || y < 1900 || aniversario > agoraSP().data) throw new Erro(400, 'ANIVERSARIO_INVALIDO', 'Data de aniversário inválida.');
      }
      if (!novo && !db.prepare('SELECT 1 FROM clientes WHERE id = ?').get(id)) throw new Erro(404, 'CLIENTE_NAO_ENCONTRADO', 'Cliente não encontrado.');
      // o WhatsApp identifica o cliente nos agendamentos do site: não pode repetir
      if (wa && db.prepare('SELECT 1 FROM clientes WHERE whatsapp = ? AND id <> ?').get(wa, id)) {
        throw new Erro(409, 'WHATSAPP_EM_USO', 'Já existe outro cliente com esse WhatsApp.');
      }
      // sem telefone, o nome é o que identifica (o agendamento presencial reaproveita pelo nome)
      if (!wa && db.prepare("SELECT 1 FROM clientes WHERE whatsapp = '' AND nome = ? COLLATE NOCASE AND id <> ?").get(nome, id)) {
        throw new Erro(409, 'CLIENTE_EXISTE', 'Já existe um cliente sem telefone com esse nome.');
      }
      if (novo) {
        const r = db.prepare('INSERT INTO clientes (nome, whatsapp, email, aniversario) VALUES (?, ?, ?, ?)').run(nome, wa, email, aniversario);
        return json(res, 200, { id: Number(r.lastInsertRowid), nome, whatsapp: wa, email, aniversario });
      }
      db.prepare('UPDATE clientes SET nome = ?, whatsapp = ?, email = ?, aniversario = ? WHERE id = ?').run(nome, wa, email, aniversario, id);
      return json(res, 200, { id, nome, whatsapp: wa, email, aniversario });
    }
    if (m === 'GET' && rota === 'admin/indicadores') return json(res, 200, resumoCaixa());
    if (m === 'GET' && rota === 'admin/alertas') {
      const limite = Math.min(200, Math.max(1, Number(url.searchParams.get('limite')) || 50));
      return json(res, 200, listarAlertas(limite));
    }
    if (m === 'POST' && rota === 'admin/alertas/lidos') {
      const b = await lerCorpo(req);
      const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Number.isInteger);
      if (ids.length) db.prepare(`UPDATE alertas SET lido_em = datetime('now','localtime') WHERE lido_em IS NULL AND id IN (${ids.map(() => '?').join(',')})`).run(...ids);
      else db.prepare("UPDATE alertas SET lido_em = datetime('now','localtime') WHERE lido_em IS NULL").run();
      return json(res, 200, listarAlertas(50));
    }
    if (m === 'POST' && rota === 'admin/agendar') {
      const resultado = criarAgendamentoAdmin(await lerCorpo(req));
      return json(res, resultado.ok ? 200 : 409, resultado);
    }
    if (m === 'POST' && rota === 'admin/reagendar') {
      const resultado = reagendarAgendamento(await lerCorpo(req));
      return json(res, resultado.ok ? 200 : 409, resultado);
    }
    if (m === 'GET' && rota === 'admin/caixa-diario') {
      const data = url.searchParams.get('data') || agoraSP().data;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) throw new Erro(400, 'DATA_INVALIDA');
      return json(res, 200, resumoCaixaDiario(data));
    }
    if (m === 'POST' && rota === 'admin/caixa-diario/abrir') {
      const b = await lerCorpo(req);
      const data = String(b.data || agoraSP().data);
      const abertura = Math.round(Number(b.valor_abertura) * 100) / 100;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || !Number.isFinite(abertura) || abertura < 0 || abertura > 1e9) {
        throw new Erro(400, 'DADOS_INVALIDOS', 'Informe uma data e um saldo inicial válido.');
      }
      try {
        db.prepare('INSERT INTO caixas_diarios (data, valor_abertura, observacao) VALUES (?, ?, ?)')
          .run(data, abertura, String(b.observacao || '').trim().slice(0, 240));
      } catch (e) {
        if (/UNIQUE constraint/.test(e.message)) throw new Erro(409, 'CAIXA_JA_ABERTO', 'Já existe um caixa registrado para esse dia.');
        throw e;
      }
      return json(res, 200, resumoCaixaDiario(data));
    }
    if (m === 'POST' && rota === 'admin/caixa-diario/fechar') {
      const b = await lerCorpo(req);
      const data = String(b.data || agoraSP().data);
      const contado = Math.round(Number(b.valor_contado) * 100) / 100;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || !Number.isFinite(contado) || contado < 0 || contado > 1e9) {
        throw new Erro(400, 'DADOS_INVALIDOS', 'Informe uma data e um valor contado válido.');
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        const caixa = db.prepare('SELECT * FROM caixas_diarios WHERE data = ?').get(data);
        if (!caixa) throw new Erro(404, 'CAIXA_NAO_ABERTO', 'Abra o caixa antes de fechá-lo.');
        if (caixa.status !== 'aberto') throw new Erro(409, 'CAIXA_JA_FECHADO', 'Este caixa já foi fechado.');
        const esperado = contaGaveta(data, Number(caixa.valor_abertura)).valor_esperado;
        const diferenca = Math.round((contado - esperado) * 100) / 100;
        db.prepare("UPDATE caixas_diarios SET valor_contado = ?, diferenca = ?, status = 'fechado', fechado_em = datetime('now','localtime') WHERE data = ?")
          .run(contado, diferenca, data);
        db.exec('COMMIT');
        return json(res, 200, resumoCaixaDiario(data));
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* transação já encerrada */ }
        throw e;
      }
    }
    if (m === 'POST' && rota === 'admin/caixa-movimento') {
      const b = await lerCorpo(req);
      const tipo = String(b.tipo || '');
      const valor = centavos(b.valor);
      // sangria e reforço são sempre dinheiro da gaveta; despesa pode ter sido paga de outra forma
      const forma = tipo === 'despesa' ? String(b.forma || 'dinheiro') : 'dinheiro';
      const descricao = String(b.descricao || '').trim().slice(0, 120);
      if (!['sangria', 'despesa', 'reforco'].includes(tipo) || !FORMAS_PAGAMENTO.includes(forma)
          || !Number.isFinite(valor) || valor <= 0 || valor > 1e9) {
        throw new Erro(400, 'DADOS_INVALIDOS', 'Informe o tipo, um valor válido e a forma de pagamento.');
      }
      if (tipo === 'despesa' && !descricao) throw new Erro(400, 'DESCRICAO_OBRIGATORIA', 'Diga com o que foi a despesa.');
      const data = agoraSP().data;
      db.exec('BEGIN IMMEDIATE');
      try {
        const caixa = db.prepare('SELECT * FROM caixas_diarios WHERE data = ?').get(data);
        if (forma === 'dinheiro') {
          if (!caixa) throw new Erro(409, 'CAIXA_NAO_ABERTO', 'Abra o caixa de hoje antes de mexer no dinheiro da gaveta.');
          if (caixa.status === 'fechado') throw new Erro(409, 'CAIXA_JA_FECHADO', 'O caixa de hoje já foi fechado.');
          if (tipo !== 'reforco') {
            const disponivel = contaGaveta(data, Number(caixa.valor_abertura)).valor_esperado;
            if (valor > disponivel) throw new Erro(400, 'SALDO_GAVETA_INSUFICIENTE', `Na gaveta deveria haver só ${disponivel.toFixed(2).replace('.', ',')}.`);
          }
        }
        db.prepare('INSERT INTO movimentos_caixa (data, tipo, valor, forma, descricao) VALUES (?, ?, ?, ?, ?)').run(data, tipo, valor, forma, descricao);
        db.exec('COMMIT');
        return json(res, 200, resumoCaixaDiario(data));
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* transação já encerrada */ }
        throw e;
      }
    }
    if (m === 'POST' && rota === 'admin/caixa-movimento/excluir') {
      const id = Number((await lerCorpo(req)).id);
      if (!Number.isInteger(id) || id < 1) throw new Erro(400, 'DADOS_INVALIDOS');
      db.exec('BEGIN IMMEDIATE');
      try {
        const mv = db.prepare('SELECT * FROM movimentos_caixa WHERE id = ?').get(id);
        if (!mv) throw new Erro(404, 'MOVIMENTO_NAO_ENCONTRADO', 'Lançamento não encontrado.');
        const caixa = db.prepare('SELECT status FROM caixas_diarios WHERE data = ?').get(mv.data);
        if (caixa && caixa.status === 'fechado') throw new Erro(409, 'CAIXA_JA_FECHADO', 'O caixa desse dia já foi fechado; o lançamento não pode mais ser excluído.');
        db.prepare('DELETE FROM movimentos_caixa WHERE id = ?').run(id);
        db.exec('COMMIT');
        return json(res, 200, resumoCaixaDiario(mv.data));
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* transação já encerrada */ }
        throw e;
      }
    }
    if (m === 'GET' && rota === 'admin/vendas-avulsas') {
      const data = url.searchParams.get('data') || agoraSP().data;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) throw new Erro(400, 'DATA_INVALIDA');
      return json(res, 200, listarVendasAvulsas(data));
    }
    if (m === 'POST' && rota === 'admin/venda-avulsa') {
      const b = await lerCorpo(req);
      const forma = String(b.forma || '');
      const itens = (Array.isArray(b.itens) ? b.itens : []).map((i) => ({ produto_id: Number(i.produto_id), quantidade: Number(i.quantidade) }));
      if (!FORMAS_PAGAMENTO.includes(forma) || !itens.length || itens.length > 50
        || itens.some((i) => !Number.isInteger(i.produto_id) || i.produto_id < 1 || !Number.isInteger(i.quantidade) || i.quantidade < 1)) {
        throw new Erro(400, 'DADOS_INVALIDOS', 'Escolha os produtos, as quantidades e a forma de pagamento.');
      }
      const clienteId = b.cliente_id == null || b.cliente_id === '' ? null : Number(b.cliente_id);
      if (clienteId !== null && (!Number.isInteger(clienteId) || clienteId < 1)) throw new Erro(400, 'DADOS_INVALIDOS');
      db.exec('BEGIN IMMEDIATE');
      try {
        if (forma === 'dinheiro') exigirCaixaNaoFechado();
        const cli = clienteId ? db.prepare('SELECT id, nome FROM clientes WHERE id = ?').get(clienteId) : null;
        if (clienteId && !cli) throw new Erro(404, 'CLIENTE_NAO_ENCONTRADO', 'Cliente não encontrado.');
        // soma quantidades repetidas do mesmo produto antes de conferir o estoque
        const qtd = new Map();
        itens.forEach((i) => qtd.set(i.produto_id, (qtd.get(i.produto_id) || 0) + i.quantidade));
        const linhas = [];
        for (const [produtoId, quantidade] of qtd) {
          const produto = db.prepare('SELECT * FROM produtos WHERE id = ? AND ativo = 1').get(produtoId);
          if (!produto) throw new Erro(404, 'PRODUTO_NAO_ENCONTRADO', 'Produto não encontrado ou inativo.');
          if (Number(produto.estoque) < quantidade) throw new Erro(400, 'ESTOQUE_INSUFICIENTE', `Estoque insuficiente de ${produto.nome}: há ${produto.estoque}.`);
          const unitario = centavos(produto.preco);
          linhas.push({ produto, quantidade, unitario, total: centavos(unitario * quantidade) });
        }
        const total = centavos(linhas.reduce((t, l) => t + l.total, 0));
        const venda = db.prepare('INSERT INTO vendas_avulsas (data, cliente_id, cliente_nome, valor_total, forma) VALUES (?, ?, ?, ?, ?)')
          .run(agoraSP().data, cli ? cli.id : null, cli ? cli.nome : '', total, forma);
        const vendaId = Number(venda.lastInsertRowid);
        for (const l of linhas) {
          db.prepare('UPDATE produtos SET estoque = estoque - ? WHERE id = ?').run(l.quantidade, l.produto.id);
          db.prepare('INSERT INTO vendas_avulsas_itens (venda_id, produto_id, nome, quantidade, preco_unitario, valor_total) VALUES (?, ?, ?, ?, ?, ?)')
            .run(vendaId, l.produto.id, l.produto.nome, l.quantidade, l.unitario, l.total);
          db.prepare("INSERT INTO movimentos_estoque (produto_id, quantidade, tipo, motivo) VALUES (?, ?, 'venda', ?)")
            .run(l.produto.id, -l.quantidade, `Venda avulsa nº ${vendaId}`);
          alertaEstoque(l.produto.id);
        }
        db.exec('COMMIT');
        return json(res, 200, vendaAvulsa(vendaId));
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* transação já encerrada */ }
        throw e;
      }
    }
    if (m === 'POST' && rota === 'admin/venda-avulsa/cancelar') {
      const id = Number((await lerCorpo(req)).id);
      if (!Number.isInteger(id) || id < 1) throw new Erro(400, 'DADOS_INVALIDOS');
      db.exec('BEGIN IMMEDIATE');
      try {
        const venda = db.prepare('SELECT * FROM vendas_avulsas WHERE id = ?').get(id);
        if (!venda) throw new Erro(404, 'VENDA_NAO_ENCONTRADA', 'Venda não encontrada.');
        if (venda.status !== 'ativa') throw new Erro(409, 'VENDA_JA_CANCELADA', 'Esta venda já foi cancelada.');
        const caixa = db.prepare('SELECT status FROM caixas_diarios WHERE data = ?').get(venda.data);
        if (caixa && caixa.status === 'fechado') throw new Erro(409, 'CAIXA_JA_FECHADO', 'O caixa desse dia já foi fechado; a venda não pode mais ser cancelada.');
        db.prepare("UPDATE vendas_avulsas SET status = 'cancelada', cancelada_em = datetime('now','localtime') WHERE id = ?").run(id);
        let devolvidos = 0;
        for (const it of db.prepare('SELECT produto_id, quantidade FROM vendas_avulsas_itens WHERE venda_id = ? AND produto_id IS NOT NULL').all(id)) {
          db.prepare('UPDATE produtos SET estoque = estoque + ? WHERE id = ?').run(it.quantidade, it.produto_id);
          db.prepare("INSERT INTO movimentos_estoque (produto_id, quantidade, tipo, motivo) VALUES (?, ?, 'entrada', ?)")
            .run(it.produto_id, it.quantidade, `Devolução: venda avulsa nº ${id} cancelada`);
          devolvidos += Number(it.quantidade);
        }
        db.exec('COMMIT');
        return json(res, 200, { ok: true, produtos_devolvidos: devolvidos });
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* transação já encerrada */ }
        throw e;
      }
    }
    if (m === 'GET' && rota === 'admin/cliente-historico') {
      const id = Number(url.searchParams.get('id'));
      if (!Number.isInteger(id) || id < 1) throw new Erro(400, 'DADOS_INVALIDOS');
      return json(res, 200, db.prepare('SELECT * FROM agendamentos WHERE cliente_id = ? ORDER BY data DESC, inicio_min DESC LIMIT 30').all(id).map((a) => formatarAgendamento({ ...a })));
    }
    if (m === 'GET' && rota === 'admin/extrato') {
      const de = url.searchParams.get('de'), ate = url.searchParams.get('ate');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(de || '') || !/^\d{4}-\d{2}-\d{2}$/.test(ate || '') || de > ate) throw new Erro(400, 'DATA_INVALIDA', 'Escolha um período válido.');
      return json(res, 200, extrato(de, ate));
    }
    if (m === 'GET' && rota === 'admin/movimentos-estoque') {
      const produtoId = Number(url.searchParams.get('produto_id'));
      if (!Number.isInteger(produtoId) || produtoId < 1) throw new Erro(400, 'DADOS_INVALIDOS');
      const movimentos = db.prepare(`SELECT m.id, m.quantidade, m.tipo, m.motivo, m.criado_em, a.codigo AS agendamento_codigo
        FROM movimentos_estoque m LEFT JOIN agendamentos a ON a.id = m.agendamento_id
        WHERE m.produto_id = ? ORDER BY m.criado_em DESC, m.id DESC LIMIT 50`).all(produtoId);
      return json(res, 200, movimentos);
    }
    if (m === 'POST' && rota === 'admin/ajuste-agendamento') {
      const b = await lerCorpo(req);
      const id = Number(b.id);
      const valor = Math.round(Number(b.valor_ajuste ?? 0) * 100) / 100;
      if (!Number.isInteger(id) || id < 1 || !Number.isFinite(valor)) throw new Erro(400, 'DADOS_INVALIDOS', 'Ajuste inválido.');
      const atual = db.prepare('SELECT status, valor_total, valor_ajuste FROM agendamentos WHERE id = ?').get(id);
      if (!atual) throw new Erro(404, 'AGENDAMENTO_NAO_ENCONTRADO');
      if (atual.status !== 'confirmado') throw new Erro(409, 'AGENDAMENTO_CANCELADO', 'Não é possível ajustar um agendamento cancelado.');
      const totalBase = Number(atual.valor_total) - Number(atual.valor_ajuste || 0);
      const novoTotal = centavos(totalBase + valor);
      if (novoTotal < 0) throw new Erro(400, 'AJUSTE_EXCEDE_TOTAL', 'O desconto não pode deixar o total negativo.');
      const pago = Number(db.prepare('SELECT COALESCE(SUM(valor), 0) AS t FROM recebimentos_agendamento WHERE agendamento_id = ?').get(id).t);
      if (novoTotal < pago) throw new Erro(400, 'AJUSTE_ABAIXO_DO_PAGO', `O cliente já pagou ${pago.toFixed(2).replace('.', ',')}. O total não pode ficar abaixo disso.`);
      db.prepare('UPDATE agendamentos SET valor_ajuste = ?, valor_total = ? WHERE id = ?').run(valor, novoTotal, id);
      const ag = db.prepare('SELECT * FROM agendamentos WHERE id = ?').get(id);
      return json(res, 200, formatarAgendamento(ag));
    }
    if (m === 'POST' && rota === 'admin/lembrete-enviado') {
      const b = await lerCorpo(req);
      const id = Number(b.id);
      if (!Number.isInteger(id) || id < 1) throw new Erro(400, 'DADOS_INVALIDOS', 'Agendamento inválido.');
      const ag = db.prepare('SELECT status FROM agendamentos WHERE id = ?').get(id);
      if (!ag) throw new Erro(404, 'AGENDAMENTO_NAO_ENCONTRADO');
      if (ag.status !== 'confirmado') throw new Erro(409, 'AGENDAMENTO_CANCELADO', 'Não é possível registrar lembrete de agendamento cancelado.');
      db.prepare("UPDATE agendamentos SET lembrete_enviado_em = datetime('now','localtime'), lembrete_envios = lembrete_envios + 1 WHERE id = ?").run(id);
      return json(res, 200, formatarAgendamento(db.prepare('SELECT * FROM agendamentos WHERE id = ?').get(id)));
    }
    if (m === 'POST' && rota === 'admin/lembrete-aberto') {
      const b = await lerCorpo(req);
      const id = Number(b.id);
      if (!Number.isInteger(id) || id < 1) throw new Erro(400, 'DADOS_INVALIDOS', 'Agendamento inválido.');
      const ag = db.prepare('SELECT status, data, inicio_min FROM agendamentos WHERE id = ?').get(id);
      if (!ag) throw new Erro(404, 'AGENDAMENTO_NAO_ENCONTRADO');
      if (ag.status !== 'confirmado') throw new Erro(409, 'AGENDAMENTO_CANCELADO', 'Não é possível abrir lembrete de agendamento cancelado.');
      const agora = agoraSP();
      if (ag.data < agora.data || (ag.data === agora.data && Number(ag.inicio_min) <= agora.min)) {
        throw new Erro(409, 'AGENDAMENTO_PASSADO', 'O horário do agendamento já começou.');
      }
      db.prepare("UPDATE agendamentos SET lembrete_aberto_em = datetime('now','localtime'), lembrete_aberturas = lembrete_aberturas + 1 WHERE id = ?").run(id);
      return json(res, 200, formatarAgendamento(db.prepare('SELECT * FROM agendamentos WHERE id = ?').get(id)));
    }
    if (m === 'POST' && rota === 'admin/recebimento') {
      const b = await lerCorpo(req);
      const id = Number(b.id);
      const valor = Math.round(Number(b.valor) * 100) / 100;
      const forma = String(b.forma || '');
      if (!Number.isInteger(id) || id < 1 || !Number.isFinite(valor) || valor <= 0 || !['dinheiro', 'pix', 'cartao', 'outro'].includes(forma)) {
        throw new Erro(400, 'DADOS_INVALIDOS', 'Informe valor e forma de pagamento válidos.');
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        const ag = db.prepare("SELECT * FROM agendamentos WHERE id = ? AND status = 'confirmado'").get(id);
        if (!ag) throw new Erro(404, 'AGENDAMENTO_NAO_ENCONTRADO');
        const pago = Number(db.prepare('SELECT COALESCE(SUM(valor), 0) AS total FROM recebimentos_agendamento WHERE agendamento_id = ?').get(id).total || 0);
        const saldo = Math.round((Number(ag.valor_total) - pago) * 100) / 100;
        if (valor > saldo) throw new Erro(400, 'RECEBIMENTO_EXCEDE_SALDO', 'O recebimento não pode ser maior que o saldo pendente.');
        if (forma === 'dinheiro') exigirCaixaNaoFechado();
        db.prepare('INSERT INTO recebimentos_agendamento (agendamento_id, valor, forma) VALUES (?, ?, ?)').run(id, valor, forma);
        db.exec('COMMIT');
        return json(res, 200, formatarAgendamento(db.prepare('SELECT * FROM agendamentos WHERE id = ?').get(id)));
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* transação já encerrada */ }
        throw e;
      }
    }
    if (m === 'POST' && rota === 'admin/estoque') {
      const b = await lerCorpo(req);
      const id = Number(b.produto_id);
      const quantidade = Number(b.quantidade);
      const tipo = String(b.tipo || '');
      const motivo = String(b.motivo || '').trim().slice(0, 120);
      if (!Number.isInteger(id) || id < 1 || !Number.isInteger(quantidade) || quantidade < 1 || !['entrada', 'ajuste'].includes(tipo)) {
        throw new Erro(400, 'DADOS_INVALIDOS', 'Informe um produto, uma quantidade inteira e um tipo de movimento válidos.');
      }
      const delta = tipo === 'entrada' ? quantidade : -quantidade;
      db.exec('BEGIN IMMEDIATE');
      try {
        const produto = db.prepare('SELECT estoque FROM produtos WHERE id = ?').get(id);
        if (!produto) throw new Erro(404, 'PRODUTO_NAO_ENCONTRADO');
        if (Number(produto.estoque) + delta < 0) throw new Erro(400, 'ESTOQUE_INSUFICIENTE', 'A saída não pode deixar o estoque negativo.');
        db.prepare('UPDATE produtos SET estoque = estoque + ? WHERE id = ?').run(delta, id);
        db.prepare('INSERT INTO movimentos_estoque (produto_id, quantidade, tipo, motivo) VALUES (?, ?, ?, ?)').run(id, delta, tipo, motivo || (tipo === 'entrada' ? 'Reposição' : 'Ajuste manual'));
        if (delta < 0) alertaEstoque(id);
        db.exec('COMMIT');
        return json(res, 200, um('SELECT * FROM produtos WHERE id = ?', id));
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* transação já encerrada */ }
        throw e;
      }
    }
    if (m === 'POST' && rota === 'admin/venda-produto') {
      const b = await lerCorpo(req);
      const agendamentoId = Number(b.agendamento_id);
      const produtoId = Number(b.produto_id);
      const quantidade = Number(b.quantidade);
      if (!Number.isInteger(agendamentoId) || agendamentoId < 1 || !Number.isInteger(produtoId) || produtoId < 1 || !Number.isInteger(quantidade) || quantidade < 1) {
        throw new Erro(400, 'DADOS_INVALIDOS', 'Produto e quantidade inválidos.');
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        const ag = db.prepare("SELECT * FROM agendamentos WHERE id = ? AND status = 'confirmado'").get(agendamentoId);
        if (!ag) throw new Erro(404, 'AGENDAMENTO_NAO_ENCONTRADO');
        const produto = db.prepare('SELECT * FROM produtos WHERE id = ? AND ativo = 1').get(produtoId);
        if (!produto) throw new Erro(404, 'PRODUTO_NAO_ENCONTRADO');
        if (Number(produto.estoque) < quantidade) throw new Erro(400, 'ESTOQUE_INSUFICIENTE', 'Estoque insuficiente para essa venda.');
        const unitario = Math.round(Number(produto.preco) * 100) / 100;
        const total = Math.round(unitario * quantidade * 100) / 100;
        db.prepare('UPDATE produtos SET estoque = estoque - ? WHERE id = ?').run(quantidade, produtoId);
        db.prepare('INSERT INTO agendamento_produtos (agendamento_id, produto_id, nome, quantidade, preco_unitario, valor_total) VALUES (?, ?, ?, ?, ?, ?)')
          .run(agendamentoId, produtoId, produto.nome, quantidade, unitario, total);
        db.prepare("INSERT INTO movimentos_estoque (produto_id, quantidade, tipo, motivo, agendamento_id) VALUES (?, ?, 'venda', ?, ?)")
          .run(produtoId, -quantidade, `Venda no agendamento ${ag.codigo}`, agendamentoId);
        db.prepare('UPDATE agendamentos SET valor_produtos = valor_produtos + ?, valor_total = valor_total + ? WHERE id = ?')
          .run(total, total, agendamentoId);
        alertaEstoque(produtoId);
        db.exec('COMMIT');
        return json(res, 200, formatarAgendamento(db.prepare('SELECT * FROM agendamentos WHERE id = ?').get(agendamentoId)));
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* transação já encerrada */ }
        throw e;
      }
    }
    if (m === 'GET' && rota === 'admin/agendamentos') {
      const de = url.searchParams.get('de') || '0000-01-01', ate = url.searchParams.get('ate') || '9999-12-31';
      return json(res, 200, db.prepare('SELECT * FROM agendamentos WHERE data BETWEEN ? AND ? ORDER BY data, inicio_min').all(de, ate).map((a) => formatarAgendamento({ ...a })));
    }
    // cancelar e marcar falta encerram o agendamento do mesmo jeito: estorno opcional e produtos de volta ao estoque
    if (m === 'POST' && (rota === 'admin/cancelar' || rota === 'admin/falta')) {
      const b = await lerCorpo(req);
      const id = Number(b.id);
      const devolver = b.devolver === true;
      const falta = rota === 'admin/falta';
      db.exec('BEGIN IMMEDIATE');
      try {
        const ag = db.prepare('SELECT id, codigo, status, data, inicio_min FROM agendamentos WHERE id = ?').get(id);
        if (!ag) throw new Erro(404, 'AGENDAMENTO_NAO_ENCONTRADO');
        if (falta) {
          if (ag.status !== 'confirmado') throw new Erro(409, 'AGENDAMENTO_CANCELADO', 'Só um agendamento confirmado pode ser marcado como falta.');
          const agora = agoraSP();
          if (ag.data > agora.data || (ag.data === agora.data && Number(ag.inicio_min) > agora.min)) {
            throw new Erro(409, 'AINDA_NAO_COMECOU', 'O horário ainda não começou. Para desmarcar antes, use Cancelar horário.');
          }
        }
        let devolvidos = 0, estornado = 0;
        if (ag.status === 'confirmado') {
          db.prepare('UPDATE agendamentos SET status = ? WHERE id = ?').run(falta ? 'falta' : 'cancelado', id);
          // devolução ao cliente: um estorno por forma de pagamento, lançado no caixa de hoje
          if (devolver) {
            const formas = db.prepare('SELECT forma, SUM(valor) AS total FROM recebimentos_agendamento WHERE agendamento_id = ? GROUP BY forma').all(id);
            if (formas.some((f) => f.forma === 'dinheiro')) {
              const caixa = db.prepare('SELECT status FROM caixas_diarios WHERE data = ?').get(agoraSP().data);
              if (caixa && caixa.status === 'fechado') throw new Erro(409, 'CAIXA_JA_FECHADO', 'O caixa de hoje já foi fechado; não dá para devolver dinheiro agora. Cancele sem devolver ou devolva por fora.');
            }
            for (const f of formas) {
              db.prepare('INSERT INTO estornos (agendamento_id, valor, forma) VALUES (?, ?, ?)').run(id, centavos(f.total), f.forma);
              estornado += Number(f.total);
            }
          }
          // produtos vendidos na comanda voltam para o estoque
          const itens = db.prepare('SELECT produto_id, quantidade FROM agendamento_produtos WHERE agendamento_id = ? AND produto_id IS NOT NULL').all(id);
          for (const it of itens) {
            db.prepare('UPDATE produtos SET estoque = estoque + ? WHERE id = ?').run(it.quantidade, it.produto_id);
            db.prepare("INSERT INTO movimentos_estoque (produto_id, quantidade, tipo, motivo, agendamento_id) VALUES (?, ?, 'entrada', ?, ?)")
              .run(it.produto_id, it.quantidade, `Devolução: agendamento ${ag.codigo} ${falta ? 'com falta' : 'cancelado'}`, id);
            devolvidos += Number(it.quantidade);
          }
        }
        db.exec('COMMIT');
        return json(res, 200, { ok: true, produtos_devolvidos: devolvidos, valor_estornado: centavos(estornado) });
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* transação já encerrada */ }
        throw e;
      }
    }
    if (m === 'POST' && rota === 'admin/config') {
      const b = await lerCorpo(req);
      const st = db.prepare('INSERT INTO configuracoes (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor');
      for (const [k, v] of Object.entries(b)) if (/^[a-z_]{1,40}$/.test(k)) st.run(k, String(v ?? ''));
      return json(res, 200, getConfig());
    }
    if (m === 'POST' && rota === 'admin/combo-servicos') {
      const b = await lerCorpo(req);
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM combo_servicos WHERE combo_id = ?').run(Number(b.combo_id));
        const ins = db.prepare('INSERT INTO combo_servicos (combo_id, servico_id) VALUES (?, ?)');
        [...new Set(b.servico_ids || [])].forEach((s) => ins.run(Number(b.combo_id), Number(s)));
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return json(res, 200, { ok: true });
    }
    let mm = /^admin\/salvar\/(\w+)$/.exec(rota);
    if (m === 'POST' && mm) return json(res, 200, salvar(mm[1], await lerCorpo(req)));
    mm = /^admin\/excluir\/(\w+)$/.exec(rota);
    if (m === 'POST' && mm) {
      const t = TABELAS[mm[1]];
      if (!t) throw new Erro(404, 'TABELA');
      const b = await lerCorpo(req);
      try {
        db.prepare(`DELETE FROM ${mm[1]} WHERE ${t.pk} = ?`).run(Number(b.id));
      } catch (e) {
        if (/FOREIGN KEY/.test(e.message)) throw new Erro(409, 'EM_USO', 'Este item tem histórico e não pode ser excluído. Desative-o para escondê-lo.');
        throw e;
      }
      return json(res, 200, { ok: true });
    }
  }
  throw new Erro(404, 'ROTA');
}

const BLOQUEADOS = /^\/(data|supabase|node_modules)\/|^\/(server\.js|package\.json|README\.md)$|\/\./;
function estatico(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/admin') p = '/admin.html';
  if (p.endsWith('/')) p += 'index.html';
  const arq = path.normalize(path.join(ROOT, p));
  const ext = path.extname(arq).toLowerCase();
  if (!arq.startsWith(ROOT + path.sep) || BLOQUEADOS.test(p) || !MIME[ext]) { res.writeHead(404); return res.end('Não encontrado'); }
  fs.readFile(arq, (e, d) => {
    if (e) { res.writeHead(404); return res.end('Não encontrado'); }
    res.writeHead(200, { 'Content-Type': MIME[ext], 'Cache-Control': ext === '.html' || ext === '.js' || ext === '.css' ? 'no-cache' : 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
    res.end(d);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else estatico(req, res, url);
  } catch (e) {
    if (e instanceof Erro) return json(res, e.status, { ok: false, erro: e.codigo, mensagem: e.message });
    console.error(e);
    json(res, 500, { ok: false, erro: 'INTERNO' });
  }
}).listen(PORT, () => console.log(`Barbearia do Juan em http://localhost:${PORT}  (painel: /admin)`));
