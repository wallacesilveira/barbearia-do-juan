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
  valor_total REAL NOT NULL, combos_aplicados TEXT DEFAULT '', valor_consulta INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'confirmado' CHECK (status IN ('confirmado','cancelado')), criado_em TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_agend_data ON agendamentos (data, status);
CREATE TABLE IF NOT EXISTS agendamento_servicos (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agendamento_id INTEGER NOT NULL REFERENCES agendamentos(id) ON DELETE CASCADE,
  servico_id INTEGER REFERENCES servicos(id) ON DELETE SET NULL, nome TEXT, duracao_min INTEGER, preco REAL);
CREATE TABLE IF NOT EXISTS usuarios_admin (usuario TEXT PRIMARY KEY, senha_hash TEXT NOT NULL);
`);

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
    whatsapp_msg: 'Olá, Juan! Vim pelo site da Barbearia do Juan e gostaria de agendar um horário. Pode me ajudar?',
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
  if (admin) out.bloqueios = todos('SELECT * FROM bloqueios ORDER BY data, inicio_min');
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
  const servicos = db.prepare('SELECT nome, duracao_min, preco FROM agendamento_servicos WHERE agendamento_id = ? ORDER BY id').all(a.id).map((s) => ({ ...s }));
  const { cliente_id, ...resto } = a;
  return { ...resto, valor_consulta: !!a.valor_consulta, cliente: { ...cli }, servicos };
}
class Erro extends Error { constructor(status, codigo, msg) { super(msg || codigo); this.status = status; this.codigo = codigo; } }

/* -------------------------------------------------------------- agendamento */
const DIGITOS = (s) => String(s || '').replace(/\D/g, '');

function criarAgendamento(b) {
  const nome = String(b.nome || '').trim().replace(/\s+/g, ' ');
  const wa = DIGITOS(b.whatsapp);
  if (nome.length < 3 || nome.length > 80 || wa.length < 10 || wa.length > 13) return { ok: false, erro: 'DADOS_INVALIDOS' };
  const data = String(b.data || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || !Number.isInteger(b.inicio_min)) return { ok: false, erro: 'DADOS_INVALIDOS' };
  const ids = [...new Set((Array.isArray(b.servico_ids) ? b.servico_ids : []).map(Number))];

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
    db.exec('COMMIT');
    return { ok: true, agendamento: formatarAgendamento(db.prepare('SELECT * FROM agendamentos WHERE id = ?').get(ag.lastInsertRowid)) };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* já finalizada */ }
    throw e;
  }
}

/* ---------------------------------------------------------------- admin CRUD */
const TABELAS = {
  servicos: { cols: ['nome', 'descricao', 'duracao_min', 'preco', 'foto', 'ordem', 'ativo'], pk: 'id' },
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
    else if (['duracao_min', 'inicio_min', 'fim_min', 'ordem'].includes(c)) v = v === null || v === '' ? null : Math.round(Number(v));
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
    if (/CHECK constraint/.test(e.message)) throw new Erro(400, 'DADOS_INVALIDOS', 'Valores fora do permitido.');
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
    if (m === 'GET' && rota === 'admin/agendamentos') {
      const de = url.searchParams.get('de') || '0000-01-01', ate = url.searchParams.get('ate') || '9999-12-31';
      return json(res, 200, db.prepare('SELECT * FROM agendamentos WHERE data BETWEEN ? AND ? ORDER BY data, inicio_min').all(de, ate).map((a) => formatarAgendamento({ ...a })));
    }
    if (m === 'POST' && rota === 'admin/cancelar') {
      const b = await lerCorpo(req);
      db.prepare("UPDATE agendamentos SET status = 'cancelado' WHERE id = ?").run(Number(b.id));
      return json(res, 200, { ok: true });
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
      db.prepare(`DELETE FROM ${mm[1]} WHERE ${t.pk} = ?`).run(Number(b.id));
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
