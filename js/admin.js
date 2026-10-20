/* Painel administrativo — Hoje, Agenda, Caixa, Clientes, Alertas, catálogo (serviços, combos, produtos) e ajustes. */
(function () {
  'use strict';
  const A = window.BJAvail;
  const esc = BJ.esc;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  let D = { config: {}, servicos: [], produtos: [], combos: [], horarios: [], galeria: [], bloqueios: [] };
  const S = {
    dia: null, mes: null, diaAg: null, mostrarCancelados: false, mostrarPassados: false, ag: new Map(),
    periodo: 'hoje', buscaCli: '', ordemCli: 'visitas', limiteCli: 30, diasSumido: 45, todosSumidos: false,
    alertas: { nao_lidos: 0, alertas: [] }, ultimoAlerta: null, timerAlertas: null,
  };
  let rotaAtual = 'dashboard';
  let ordemDias = [1, 2, 3, 4, 5, 6, 0];
  const TITULO_BASE = document.title;

  BJIcons.hydrate();

  /* ------------------------------------------------------------ utilidades */
  const hojeIso = () => A.isoDate(new Date());
  const minAgora = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
  const dataLonga = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); };
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const dataCurta = (iso) => { const [y, m, d] = iso.split('-').map(Number); return cap(new Date(y, m - 1, d).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' }).replace('.', '')); };
  const brl = (v) => (v == null ? 'Sob consulta' : A.fmtBRL(v));
  const numBR = (s) => { s = String(s).trim().replace(/\s|R\$/g, ''); if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.'); return s === '' ? null : Number(s); };
  const fmtNum = (v) => (v == null ? '' : String(v).replace('.', ','));
  const digitos = (s) => String(s || '').replace(/\D/g, '');
  const centavos = (v) => Math.round(Number(v || 0) * 100) / 100;
  const fmtTel = (s) => BJ.telExibir(s);
  const telValido = (d) => d.length === 10 || d.length === 11;
  const CAMPO_TEL = 'type="tel" inputmode="tel" data-mascara="tel" placeholder="(11)98765-4321" autocomplete="off"';
  const waCliente = (s) => { let d = digitos(s); if (d.length <= 11) d = '55' + d; return 'https://wa.me/' + d; };
  const pick = (o, cols) => Object.fromEntries(cols.filter((c) => c in o).map((c) => [c, o[c]]));
  const iniciais = (nome) => String(nome || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || '?';
  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
  const FORMAS = { dinheiro: 'Dinheiro', pix: 'Pix', cartao: 'Cartão', outro: 'Outro' };

  /** Converte data/hora do banco em Date. No SQLite local, "utc" indica colunas gravadas com CURRENT_TIMESTAMP. */
  function paraData(s, utc) {
    if (!s) return null;
    let t = String(s);
    if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(t)) t = t.replace(' ', 'T') + (utc ? 'Z' : '');
    const d = new Date(t);
    return isNaN(d) ? null : d;
  }
  function quando(s, utc) {
    const d = paraData(s, utc);
    return d ? d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', ' às') : '';
  }
  function relativo(s) {
    const d = paraData(s); if (!d) return '';
    const min = Math.round((Date.now() - d.getTime()) / 60000);
    if (min < 1) return 'agora';
    if (min < 60) return `há ${min} min`;
    if (min < 24 * 60) return `há ${Math.round(min / 60)} h`;
    return quando(s);
  }
  const valorAg = (a, v = a.valor_total) => (a.valor_consulta ? (Number(v) ? A.fmtBRL(v) + ' + a consultar' : 'A consultar') : A.fmtBRL(v));

  /** Situação financeira do agendamento: [rótulo, variante]. */
  function situacao(a) {
    if (a.status === 'cancelado') return ['Cancelado', 'err'];
    if (a.status === 'falta') return ['Faltou', 'warn'];
    const total = Number(a.valor_total || 0), pago = Number(a.total_pago || 0);
    if (a.valor_consulta && !total && !pago) return ['A consultar', 'muted'];
    if (total > 0 && pago >= total - 0.004) return ['Pago', 'ok'];
    if (pago > 0) return ['Parcial', 'warn'];
    return ['A receber', 'muted'];
  }
  const pill = ([txt, tipo]) => `<span class="pill pill--${tipo}">${esc(txt)}</span>`;
  const kpi = (rotulo, valor, sub = '', cls = '') => `<div class="kpi${cls ? ' ' + cls : ''}"><span class="kpi__rotulo">${rotulo}</span><b class="kpi__valor">${valor}</b>${sub ? `<span class="kpi__sub">${sub}</span>` : ''}</div>`;
  const barra = (rotulo, valor, max, texto, cls = '') => `<div class="barra${cls ? ' ' + cls : ''}"><div class="barra__topo"><span>${rotulo}</span><b>${texto}</b></div>
    <div class="barra__trilho"><span style="width:${valor > 0 && max > 0 ? Math.max(3, Math.round((valor / max) * 100)) : 0}%"></span></div></div>`;
  const vazio = (icone, titulo, texto = '', acao = '') => `<div class="estado-vazio">${BJIcons.svg(icone)}<strong>${titulo}</strong>${texto ? `<p>${texto}</p>` : ''}${acao}</div>`;

  function toast(msg, ok = true) {
    const t = $('#toast');
    // modais abertos ficam na camada superior do navegador: o aviso precisa morar dentro do modal para aparecer por cima
    const host = $$('dialog[open]').pop() || document.body;
    if (t.parentElement !== host) host.appendChild(t);
    t.textContent = msg; t.className = 'toast' + (ok ? ' ok' : ''); t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ok ? 3500 : 7000);
  }

  const ERROS = {
    AJUSTE_ABAIXO_DO_PAGO: 'O total não pode ficar abaixo do que o cliente já pagou.',
    AJUSTE_EXCEDE_TOTAL: 'O desconto não pode ser maior que o valor da comanda.',
    RECEBIMENTO_EXCEDE_SALDO: 'O valor é maior do que falta receber.',
    RECEBIMENTO_INVALIDO: 'Confira o valor e a forma de pagamento.',
    ESTOQUE_INSUFICIENTE: 'Não há estoque suficiente para essa quantidade.',
    CAIXA_JA_ABERTO: 'O caixa deste dia já foi aberto.',
    CAIXA_JA_FECHADO: 'O caixa de hoje já foi fechado.',
    CAIXA_NAO_ABERTO: 'Abra o caixa de hoje primeiro.',
    CAIXA_FECHADO_DINHEIRO: 'O caixa de hoje já foi fechado. Registre em pix, cartão ou outro, ou receba o dinheiro amanhã.',
    SALDO_GAVETA_INSUFICIENTE: 'O valor é maior do que deveria haver na gaveta.',
    DESCRICAO_OBRIGATORIA: 'Diga com o que foi a despesa.',
    MOVIMENTO_NAO_ENCONTRADO: 'Lançamento não encontrado. Atualize a página.',
    AGENDAMENTO_CANCELADO: 'Este agendamento está cancelado.',
    AINDA_NAO_COMECOU: 'O horário ainda não começou. Para desmarcar antes, use Cancelar horário.',
    AGENDAMENTO_PASSADO: 'O horário deste agendamento já passou.',
    AGENDAMENTO_NAO_ENCONTRADO: 'Agendamento não encontrado. Atualize a página.',
    PRODUTO_NAO_ENCONTRADO: 'Produto indisponível. Atualize a página.',
    VENDA_NAO_ENCONTRADA: 'Venda não encontrada. Atualize a página.',
    VENDA_JA_CANCELADA: 'Esta venda já foi cancelada.',
    CLIENTE_NAO_ENCONTRADO: 'Cliente não encontrado. Atualize a página.',
    EM_USO: 'Este item tem histórico e não pode ser excluído. Desative-o para escondê-lo.',
    23503: 'Este item tem histórico e não pode ser excluído. Desative-o para escondê-lo.',
    REDE: 'Sem conexão com o servidor. Verifique a internet e tente de novo.',
  };
  /** Mensagem amigável para erros do servidor local (código + mensagem) e do Supabase (mensagem = código). */
  function textoErro(e) {
    if (!e) return 'Algo deu errado. Tente novamente.';
    if (ERROS[e.message]) return ERROS[e.message];
    if (/^\d{5}$/.test(e.codigo || '') && ERROS[e.codigo]) return ERROS[e.codigo];
    if (e.message && e.message !== e.codigo && !/^[A-Z_]+$/.test(e.message)) return e.message;
    return ERROS[e.codigo] || 'Algo deu errado. Tente novamente.';
  }

  /** Executa uma ação; trata sessão expirada e mostra erros. */
  async function seguro(fn) {
    try { return await fn(); } catch (e) {
      if (e.status === 401) { mostrarLogin('Sua sessão expirou. Entre novamente.'); return undefined; }
      toast(textoErro(e), false);
      return undefined;
    }
  }
  window.addEventListener('bj:sessao-expirada', () => mostrarLogin('Sua sessão expirou. Entre novamente.'));

  /* ------------------------------------------------------------- modais */
  const modal = $('#modal');
  let aoEnviar = null;
  function abrirModal({ titulo, corpo, rodape, enviar, aberto }) {
    $('#modal-titulo').textContent = titulo;
    $('#modal-corpo').innerHTML = corpo;
    $('#modal-corpo').onchange = null; $('#modal-corpo').oninput = null; $('#modal-corpo').onclick = null;
    $('#modal-rodape').innerHTML = rodape || '<button type="button" class="btn" data-fechar>Fechar</button>';
    aoEnviar = enviar || null;
    BJIcons.hydrate(modal);
    if (!modal.open) modal.showModal();
    $('#modal-corpo').scrollTop = 0;
    if (aberto) aberto();
  }
  const fecharModal = () => { if (modal.open) modal.close(); };
  $('#modal-x').addEventListener('click', fecharModal);
  // só fecha pelos botões: toque fora não fecha, e Esc/voltar do Android não descartam um formulário em preenchimento
  modal.addEventListener('click', (e) => { if (e.target.closest('[data-fechar]')) fecharModal(); });
  modal.addEventListener('cancel', (e) => { if ($('input, select, textarea', modal)) e.preventDefault(); });
  $('#modal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!aoEnviar) return;
    const btn = $('#modal-rodape button[type="submit"]');
    if (btn) btn.disabled = true;
    try { await aoEnviar(); } finally { if (btn) btn.disabled = false; }
  });

  /** Pergunta com texto em um ou mais parágrafos e vários botões; resolve com o `valor` escolhido (null em Voltar). */
  function escolha(texto, opcoes) {
    return new Promise((ok) => {
      const d = document.createElement('dialog');
      d.className = 'modal modal--confirma' + (opcoes.length > 1 ? ' modal--escolha' : '');
      d.setAttribute('aria-label', 'Confirmação');
      const paragrafos = (Array.isArray(texto) ? texto : [texto]).filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join('');
      d.innerHTML = `<div class="modal__box"><div class="modal__corpo">${paragrafos}</div>
        <div class="modal__rodape"><button type="button" class="btn" data-r="">Voltar</button>${opcoes.map((o, i) => `<button type="button" class="btn ${o.classe || ''}" data-r="${i}">${esc(o.rotulo)}</button>`).join('')}</div></div>`;
      document.body.appendChild(d);
      const fim = (v) => { d.close(); d.remove(); ok(v); };
      d.addEventListener('click', (e) => { const b = e.target.closest('[data-r]'); if (b) fim(b.dataset.r === '' ? null : opcoes[Number(b.dataset.r)].valor); });
      d.addEventListener('cancel', (e) => { e.preventDefault(); fim(null); });
      d.showModal();
      $('[data-r=""]', d).focus();
    });
  }
  /** Confirmação com texto em um ou mais parágrafos. */
  async function confirma(texto, rotulo = 'Confirmar', perigo = true) {
    return (await escolha(texto, [{ rotulo, classe: perigo ? 'btn--perigo' : 'btn--solid', valor: true }])) === true;
  }

  /* upload de imagem (guarda o data URL em memória até salvar) */
  function uploadHtml(id, valor, { logo = false, rotulo = 'Foto' } = {}) {
    const src = BJ.src(valor);
    return `<div class="campo"><span class="rotulo" id="${id}-r">${esc(rotulo)}</span>
      <div class="upload"><div class="upload__prev${logo ? ' logo' : ''}" id="${id}-prev">${src ? `<img src="${esc(src)}" alt="">` : 'sem foto'}</div>
      <input type="file" id="${id}" accept="image/*" aria-labelledby="${id}-r"></div></div>`;
  }
  function ligarUpload(id, opcoes, aoEscolher) {
    $('#' + id).addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const url = await BJ.lerImagem(f, opcoes);
        $('#' + id + '-prev').innerHTML = `<img src="${url}" alt="">`;
        aoEscolher(url);
      } catch (err) { toast(err.message, false); e.target.value = ''; }
    });
  }

  /* ---------------------------------------------------------------- login */
  function mostrarLogin(msg) {
    $('#painel').hidden = true; $('#login').hidden = false;
    const er = $('#l-erro'); er.hidden = !msg; er.textContent = msg || '';
    $('#l-senha').value = '';
    clearInterval(S.timerAlertas); S.timerAlertas = null; S.ultimoAlerta = null;
    document.title = TITULO_BASE;
    if (Api.logado()) Api.sair();
    setTimeout(() => $('#l-user').focus(), 30);
  }
  function mostrarPainel() {
    $('#login').hidden = true; $('#painel').hidden = false;
    rotear();
    verificarAlertas();
    clearInterval(S.timerAlertas);
    S.timerAlertas = setInterval(verificarAlertas, 30000);
  }
  $('#form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#l-btn'), er = $('#l-erro');
    er.hidden = true; btn.disabled = true; btn.textContent = 'Entrando…';
    try {
      await Api.entrar($('#l-user').value.trim(), $('#l-senha').value);
      await recarregar();
      mostrarPainel();
    } catch (err) {
      er.hidden = false;
      er.textContent = err.codigo === 'CREDENCIAIS' ? 'Usuário ou senha incorretos.' : err.codigo === 'MUITAS_TENTATIVAS' ? 'Muitas tentativas. Aguarde 1 minuto e tente de novo.' : textoErro(err);
    } finally { btn.disabled = false; btn.textContent = 'Entrar'; }
  });
  $('#sair').addEventListener('click', () => mostrarLogin());

  async function recarregar() {
    const dados = await Api.carregarAdmin();
    D = { config: {}, servicos: [], produtos: [], combos: [], horarios: [], galeria: [], bloqueios: [], ...dados };
    D.produtos = Array.isArray(dados.produtos) ? dados.produtos : [];
  }

  /* --------------------------------------------------------------- roteador */
  const VIEWS = {
    dashboard: ['Hoje', vDashboard], agendamentos: ['Agenda', vAgendamentos], caixa: ['Caixa', vCaixa], clientes: ['Clientes', vClientes], alertas: ['Alertas', vAlertas],
    servicos: ['Serviços', vServicos], combos: ['Combos', vCombos], produtos: ['Produtos', vProdutos],
    horarios: ['Horários', vHorarios], bloqueios: ['Bloqueios', vBloqueios], galeria: ['Galeria', vGaleria], config: ['Configurações', vConfig],
  };
  async function rotear() {
    if ($('#painel').hidden) return;
    const r = (location.hash.replace(/^#\//, '') || 'dashboard');
    rotaAtual = VIEWS[r] ? r : 'dashboard';
    $$('#nav a').forEach((a) => (a.dataset.v === rotaAtual ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
    $('#titulo-topo').textContent = VIEWS[rotaAtual][0];
    fecharMenu();
    const c = $('#conteudo');
    c.onclick = null; c.onchange = null; c.oninput = null; c.onsubmit = null;
    c.innerHTML = '<div class="carregando-pg" aria-busy="true"><span class="spinner" aria-hidden="true"></span>Carregando…</div>';
    await seguro(() => VIEWS[rotaAtual][1](c));
    BJIcons.hydrate(c);
    c.focus({ preventScroll: true });
  }
  window.addEventListener('hashchange', rotear);
  const refazer = () => rotear();

  const menu = $('#side'), veu = $('#veu');
  function fecharMenu() { menu.classList.remove('aberto'); veu.hidden = true; }
  $('#abrir-menu').addEventListener('click', () => { menu.classList.add('aberto'); veu.hidden = false; });
  veu.addEventListener('click', fecharMenu);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fecharMenu(); });

  /* ================================================================ Alertas */
  function atualizarBadges() {
    const n = S.alertas.nao_lidos || 0;
    $$('[data-badge-alertas]').forEach((b) => { b.textContent = n > 99 ? '99+' : String(n); b.hidden = !n; });
    document.title = (n ? `(${n}) ` : '') + TITULO_BASE;
  }
  function notificarSistema(novos) {
    if (!('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
    novos.slice(0, 3).forEach((a) => { try { new Notification(a.titulo, { body: a.mensagem, icon: 'assets/logo/logo-128.png', tag: 'bj-alerta-' + a.id }); } catch { /* sem suporte */ } });
  }
  /** Busca alertas a cada 30 s; avisa (toast + notificação do sistema) quando chega algo novo. */
  async function verificarAlertas() {
    if ($('#painel').hidden || !Api.logado()) return;
    let r;
    try { r = await Api.alertas(); } catch (e) { if (e.status === 401) mostrarLogin('Sua sessão expirou. Entre novamente.'); return; }
    const primeira = S.ultimoAlerta == null;
    const novos = primeira ? [] : r.alertas.filter((x) => x.id > S.ultimoAlerta && !x.lido_em);
    S.alertas = r;
    S.ultimoAlerta = r.alertas.reduce((m, x) => Math.max(m, Number(x.id)), S.ultimoAlerta || 0);
    atualizarBadges();
    if (!novos.length) return;
    toast(novos.length === 1 ? novos[0].titulo : `${novos.length} novos alertas`);
    notificarSistema(novos);
    if (rotaAtual === 'alertas' || (rotaAtual === 'dashboard' && novos.some((n) => n.tipo === 'novo_agendamento'))) refazer();
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) verificarAlertas(); });

  async function abrirAlerta(al) {
    if (!al.lido_em) {
      const r = await seguro(() => Api.marcarAlertasLidos([al.id]));
      if (r) { S.alertas = r; atualizarBadges(); }
    }
    if (al.tipo === 'estoque_baixo') { location.hash = '#/produtos'; return; }
    if (!al.data || !al.codigo) return refazer();
    const lista = await seguro(() => Api.agendamentos(al.data, al.data));
    const ag = lista && lista.find((x) => x.codigo === al.codigo);
    if (rotaAtual === 'alertas') refazer();
    if (ag) detalheAg(ag, refazer); else toast('Agendamento não encontrado.', false);
  }

  async function vAlertas(c) {
    const r = await Api.alertas();
    S.alertas = r; atualizarBadges();
    const suporta = 'Notification' in window;
    const permissao = suporta ? Notification.permission : 'denied';
    const icone = (t) => (t === 'estoque_baixo' ? 'box' : 'calendar');
    c.innerHTML = `<div class="pg-topo"><div><h1>Alertas</h1><p>Novos agendamentos feitos pelo site e avisos de estoque. O painel verifica a cada 30 segundos.</p></div>
        <div class="pg-acoes">${r.nao_lidos ? '<button type="button" class="btn btn--sec" data-ler-todos>Marcar todos como lidos</button>' : ''}</div></div>
      ${suporta && permissao === 'default' ? `<div class="aviso-barra">${BJIcons.svg('bell')}<span><b>Receba avisos mesmo com o painel em segundo plano.</b> Ative as notificações deste navegador.</span><button type="button" class="btn btn--sm btn--solid" data-permitir>Ativar</button></div>` : ''}
      <div class="cartao">${r.alertas.length ? `<ul class="alertas">${r.alertas.map((al) => `
        <li><button type="button" class="alerta-item${al.lido_em ? '' : ' nao-lido'}" data-alerta="${al.id}">
          <span class="alerta-item__ic alerta-item__ic--${al.tipo}">${BJIcons.svg(icone(al.tipo))}</span>
          <span class="alerta-item__txt"><b>${esc(al.titulo)}</b><span>${esc(al.mensagem)}</span></span>
          <span class="alerta-item__hora">${esc(relativo(al.criado_em))}</span></button></li>`).join('')}</ul>`
        : vazio('bell', 'Nenhum alerta por aqui', 'Quando um cliente agendar pelo site, o aviso aparece nesta tela e no menu.')}</div>`;
    c.onclick = async (e) => {
      if (e.target.closest('[data-permitir]')) { await Notification.requestPermission(); return refazer(); }
      if (e.target.closest('[data-ler-todos]')) {
        const x = await seguro(() => Api.marcarAlertasLidos());
        if (x) { S.alertas = x; atualizarBadges(); toast('Alertas marcados como lidos.'); refazer(); }
        return;
      }
      const b = e.target.closest('[data-alerta]');
      if (b) abrirAlerta(S.alertas.alertas.find((x) => String(x.id) === b.dataset.alerta));
    };
  }

  /* =================================================== Agendamento: linha e detalhe */
  function linhaAg(a, extra = '') {
    const nomes = a.servicos.map((s) => s.nome).join(' + ');
    return `<button type="button" class="ag-row${a.status === 'cancelado' ? ' cancelado' : a.status === 'falta' ? ' falta' : ''}${extra}" data-ag="${a.id}">
      <span class="ag-hora">${A.fmtMin(a.inicio_min)}<small>até ${A.fmtMin(a.fim_min)}</small></span>
      <span class="ag-info"><span class="ag-nome">${esc(BJ.nome(a.cliente.nome))}</span><span class="ag-serv">${esc(nomes)}</span></span>
      <span class="ag-dir"><span class="ag-preco">${esc(valorAg(a))}</span>${pill(situacao(a))}</span></button>`;
  }

  function detalheAg(a, aoMudar) {
    S.ag.set(String(a.id), a);
    const nome = BJ.nome(a.cliente.nome);
    const confirmado = a.status === 'confirmado';
    const total = Number(a.valor_total || 0), ajuste = Number(a.valor_ajuste || 0), vProdutos = Number(a.valor_produtos || 0);
    const base = centavos(total - ajuste - vProdutos);
    const pago = Number(a.total_pago || 0);
    const saldo = Math.max(0, centavos(total - pago));
    const pct = total > 0 ? Math.min(100, Math.round((pago / total) * 100)) : 0;
    const temWa = digitos(a.cliente.whatsapp).length >= 10;
    const hoje = hojeIso();
    const futuro = a.data > hoje || (a.data === hoje && a.inicio_min > minAgora());
    const lembreteOk = confirmado && temWa && futuro;
    const aberturas = Number(a.lembrete_aberturas || 0) || Number(a.lembrete_envios || 0);
    const ultimoLembrete = a.lembrete_aberto_em || a.lembrete_enviado_em;
    const temProdutos = D.produtos.some((p) => p.ativo && p.estoque > 0);

    const [ano, mes, dia] = a.data.split('-');
    const textoLembrete = `Olá, ${nome}! Passando para lembrar que você tem um horário marcado na ${D.config.nome || 'Barbearia do Juan'} para ${a.servicos.map((s) => s.nome).join(' e ')}, ${A.DIAS[A.weekday(a.data)].toLowerCase()} ${dia}/${mes}/${ano.slice(-2)} às ${A.fmtMin(a.inicio_min).replace(':', 'h')}. Esperamos você!`;
    const urlLembrete = `${waCliente(a.cliente.whatsapp)}?text=${encodeURIComponent(textoLembrete)}`;

    const recibo = [
      `<li><span>Serviços<small>${a.servicos.map((s) => esc(s.nome)).join(' + ')}${a.combos_aplicados ? ` · combo ${esc(a.combos_aplicados)}` : ''}</small></span><b>${esc(valorAg(a, base))}</b></li>`,
      ...(a.produtos || []).map((p) => `<li><span>${esc(p.nome)}<small>${p.quantidade} × ${A.fmtBRL(p.preco_unitario)}</small></span><b>${A.fmtBRL(p.valor_total)}</b></li>`),
      ajuste ? `<li class="${ajuste < 0 ? 'neg' : 'pos'}"><span>${ajuste < 0 ? 'Desconto' : 'Adicional'}</span><b>${ajuste < 0 ? '− ' : '+ '}${A.fmtBRL(Math.abs(ajuste))}</b></li>` : '',
      `<li class="recibo__total"><span>Total</span><b>${esc(valorAg(a))}</b></li>`,
    ].join('');
    const pagamentos = (a.pagamentos || []).map((p) => `<li><span>${esc(FORMAS[p.forma] || p.forma)}<small>${esc(quando(p.recebido_em))}</small></span><b>${A.fmtBRL(p.valor)}</b></li>`).join('')
      + (a.estornos || []).map((e) => `<li class="neg"><span>Devolvido · ${esc(FORMAS[e.forma] || e.forma)}<small>${esc(quando(e.criado_em))}</small></span><b>− ${A.fmtBRL(e.valor)}</b></li>`).join('');
    const ficouComBarbearia = !confirmado && pago > 0 && !(a.estornos || []).length;
    const faltou = a.status === 'falta';
    const statusLembrete = ultimoLembrete
      ? `Conversa aberta ${esc(quando(ultimoLembrete))}${aberturas > 1 ? ` · ${aberturas} vezes` : ''}`
      : (futuro ? 'Ainda não enviado.' : 'O horário já passou.');

    abrirModal({
      titulo: 'Agendamento ' + a.codigo,
      corpo: `<div class="det-cab">
          <span class="avatar">${esc(iniciais(nome))}</span>
          <div class="det-cab__txt"><strong>${esc(nome)}</strong>
            <span>${temWa ? `<a href="${esc(waCliente(a.cliente.whatsapp))}" target="_blank" rel="noopener">${BJIcons.svg('whatsapp')}${esc(fmtTel(a.cliente.whatsapp))}</a>` : 'Sem telefone cadastrado'}</span></div>
          ${pill(situacao(a))}
        </div>
        <div class="det-fatos">
          <div><span>Data</span><strong>${esc(dataCurta(a.data))}</strong></div>
          <div><span>Horário</span><strong>${A.fmtMin(a.inicio_min)} – ${A.fmtMin(a.fim_min)}</strong></div>
          <div><span>Duração</span><strong>${A.fmtDur(a.duracao_min)}</strong></div>
        </div>
        <section class="det-sec"><h3>Comanda</h3><ul class="recibo">${recibo}</ul></section>
        <section class="det-sec"><div class="det-sec__topo"><h3>Pagamento</h3><span>${A.fmtBRL(pago)} de ${A.fmtBRL(total)}</span></div>
          <div class="progresso${pct >= 100 ? ' completo' : ''}" role="progressbar" aria-label="Valor pago" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>
          ${pagamentos ? `<ul class="recibo recibo--lista">${pagamentos}</ul>` : '<p class="det-vazio">Nenhum pagamento registrado.</p>'}
          ${confirmado && saldo > 0 ? `<p class="det-falta">Falta receber <strong>${A.fmtBRL(saldo)}</strong></p>` : ''}
          ${ficouComBarbearia ? `<p class="det-vazio">${faltou ? 'Falta sem devolução' : 'Cancelado sem devolução'}: o valor pago ficou com a barbearia.</p>` : ''}
        </section>
        ${confirmado && temWa ? `<section class="det-sec det-lembrete"><div><h3>Lembrete por WhatsApp</h3><p id="lembrete-status">${statusLembrete}</p></div>
          ${lembreteOk ? `<a class="btn btn--sm btn--sec" id="lembrete-link" href="${esc(urlLembrete)}" target="_blank" rel="noopener">${BJIcons.svg('whatsapp')}${aberturas ? 'Reenviar' : 'Enviar'}</a>` : ''}</section>` : ''}
        ${(a.remarcacoes || []).length ? `<section class="det-sec"><h3>Remarcações</h3><ul class="recibo recibo--lista">${a.remarcacoes.map((r) => `<li><span>${esc(dataCurta(r.data_anterior))} às ${A.fmtMin(r.inicio_anterior)} → ${esc(dataCurta(r.data_nova))} às ${A.fmtMin(r.inicio_novo)}<small>${esc(quando(r.criado_em))}</small></span></li>`).join('')}</ul></section>` : ''}
        <p class="det-meta">${a.criado_em ? `Criado em ${esc(quando(a.criado_em, true))} · ` : ''}Código ${esc(a.codigo)}</p>`,
      rodape: `${confirmado ? '<button type="button" class="btn-texto perigo" id="cancelar-ag">Cancelar horário</button>' : ''}
        <span class="modal__espaco"></span>
        ${confirmado && !futuro ? '<button type="button" class="btn btn--sec" id="falta-ag"><i data-icon="ban"></i>Faltou</button>' : ''}
        ${confirmado ? '<button type="button" class="btn btn--sec" id="remarcar-ag"><i data-icon="calendar"></i>Reagendar</button>' : ''}
        ${confirmado ? '<button type="button" class="btn btn--sec" id="ajuste-ag"><i data-icon="sliders"></i>Ajustar valor</button>' : ''}
        ${confirmado && temProdutos ? '<button type="button" class="btn btn--sec" id="vender-produto-ag"><i data-icon="box"></i>Produto</button>' : ''}
        ${confirmado && saldo > 0 ? '<button type="button" class="btn btn--solid" id="receber-ag"><i data-icon="wallet"></i>Receber</button>' : ''}
        ${!confirmado ? '<button type="button" class="btn" data-fechar>Fechar</button>' : ''}`,
      aberto() {
        const link = $('#lembrete-link');
        if (link) link.addEventListener('click', () => {
          Api.registrarAberturaLembrete(a.id).then((reg) => {
            const st = $('#lembrete-status');
            if (st) st.textContent = `Conversa aberta ${quando(reg.lembrete_aberto_em) || 'agora'} · ${reg.lembrete_aberturas} ${reg.lembrete_aberturas === 1 ? 'vez' : 'vezes'}`;
            a.lembrete_aberto_em = reg.lembrete_aberto_em; a.lembrete_aberturas = reg.lembrete_aberturas;
            toast('WhatsApp aberto. Toque em Enviar no aplicativo para concluir.');
          }).catch((err) => toast('A conversa abriu, mas não consegui registrar o envio. ' + textoErro(err), false));
        });
        const on = (id, fn) => { const b = $('#' + id); if (b) b.addEventListener('click', fn); };
        on('receber-ag', () => formRecebimento(a, saldo, aoMudar));
        on('ajuste-ag', () => formAjuste(a, aoMudar));
        on('remarcar-ag', () => abrirAgendamentoAdmin(null, () => aoMudar(), a));
        on('vender-produto-ag', () => formVenda(a, aoMudar));
        /** Cancelar ou marcar falta: mesmo fluxo (devolver ou não o que foi pago; produtos voltam ao estoque). */
        const encerrar = async (falta) => {
          const avisos = [falta
            ? `Marcar que ${nome} não veio ao horário de ${A.fmtData(a.data)} às ${A.fmtMin(a.inicio_min)}? A falta fica registrada no cadastro do cliente e não conta como visita nem faturamento.`
            : `Cancelar o horário de ${nome} em ${A.fmtData(a.data)} às ${A.fmtMin(a.inicio_min)}? O horário volta a ficar livre na agenda.`];
          if ((a.produtos || []).length) avisos.push('Os produtos desta comanda voltam para o estoque.');
          const acao = falta ? 'Marcar falta' : 'Cancelar';
          let devolver = false;
          if (pago > 0) {
            const porForma = {};
            (a.pagamentos || []).forEach((p) => { porForma[p.forma] = centavos((porForma[p.forma] || 0) + p.valor); });
            const detalhe = Object.entries(porForma).map(([f, v]) => `${FORMAS[f] || f} ${A.fmtBRL(v)}`).join(' · ');
            avisos.push(`O cliente já pagou ${A.fmtBRL(pago)} (${detalhe}). Se devolver, o valor sai do caixa de hoje na mesma forma em que foi pago. Se não devolver, ele fica com a barbearia (ex.: taxa por falta).`);
            const r = await escolha(avisos, [
              { rotulo: `${acao} sem devolver`, valor: 'manter' },
              { rotulo: `${acao} e devolver ${A.fmtBRL(pago)}`, classe: 'btn--perigo', valor: 'devolver' },
            ]);
            if (!r) return;
            devolver = r === 'devolver';
          } else if (!(await confirma(avisos, falta ? 'Marcar falta' : 'Cancelar agendamento'))) return;
          const r = await seguro(() => (falta ? Api.marcarFalta(a.id, devolver) : Api.cancelar(a.id, devolver)));
          if (r) {
            const partes = [falta ? 'Falta registrada.' : 'Agendamento cancelado.'];
            if (Number(r.valor_estornado) > 0) partes.push(`${A.fmtBRL(r.valor_estornado)} devolvidos ao cliente.`);
            if (r.produtos_devolvidos) partes.push(`${plural(r.produtos_devolvidos, 'produto voltou', 'produtos voltaram')} ao estoque.`);
            fecharModal(); toast(partes.join(' ')); await recarregar(); aoMudar();
          }
        };
        on('cancelar-ag', () => encerrar(false));
        on('falta-ag', () => encerrar(true));
      },
    });
  }

  const voltarDetalhe = () => "<button type=\"button\" class=\"btn\" data-voltar>Voltar</button>";
  function ligarVoltar(a, aoMudar) { const b = $('[data-voltar]'); if (b) b.addEventListener('click', () => detalheAg(a, aoMudar)); }

  function formRecebimento(a, saldo, aoMudar) {
    abrirModal({
      titulo: 'Registrar pagamento',
      corpo: `<p class="sub">${esc(BJ.nome(a.cliente.nome))} · falta receber <strong>${A.fmtBRL(saldo)}</strong></p>
        <div class="campo"><label for="receb-valor">Valor recebido</label><div class="campo-moeda"><span>R$</span><input id="receb-valor" inputmode="decimal" autocomplete="off" value="${fmtNum(saldo.toFixed(2))}" required></div>
          <small>Pode ser parcial. O restante continua pendente.</small></div>
        <fieldset class="campo"><legend class="rotulo">Forma de pagamento</legend><div class="opcoes">${Object.entries(FORMAS).map(([k, v]) => `<label class="opcao"><input type="radio" name="receb-forma" value="${k}" ${k === 'pix' ? 'checked' : ''}><span>${v}</span></label>`).join('')}</div></fieldset>`,
      rodape: `${voltarDetalhe()}<button type="submit" class="btn btn--solid">Confirmar pagamento</button>`,
      aberto() { ligarVoltar(a, aoMudar); const i = $('#receb-valor'); i.focus(); i.select(); },
      async enviar() {
        const valor = centavos(numBR($('#receb-valor').value));
        const forma = ($('input[name="receb-forma"]:checked') || {}).value;
        if (!(valor > 0)) return toast('Informe um valor maior que zero.', false);
        if (valor > saldo) return toast(`O valor passa do que falta receber (${A.fmtBRL(saldo)}).`, false);
        if (!forma) return toast('Escolha a forma de pagamento.', false);
        const ok = await seguro(() => Api.registrarRecebimento(a.id, valor, forma).then(() => true));
        if (ok) { fecharModal(); toast(valor === saldo ? 'Pagamento registrado. Comanda quitada.' : `Pagamento de ${A.fmtBRL(valor)} registrado.`); aoMudar(); }
      },
    });
  }

  function formAjuste(a, aoMudar) {
    const atual = Number(a.valor_ajuste || 0);
    const semAjuste = centavos(Number(a.valor_total || 0) - atual);
    const pago = Number(a.total_pago || 0);
    const tipoAtual = atual > 0 ? 'adicional' : 'desconto';
    abrirModal({
      titulo: 'Ajustar valor',
      corpo: `<p class="sub">Use para descontos ou cobranças extras. O valor sem ajuste é <strong>${A.fmtBRL(semAjuste)}</strong>.</p>
        <fieldset class="campo"><legend class="rotulo">Tipo</legend><div class="opcoes opcoes--3">
          <label class="opcao"><input type="radio" name="aj-tipo" value="desconto" ${tipoAtual === 'desconto' ? 'checked' : ''}><span>Desconto</span></label>
          <label class="opcao"><input type="radio" name="aj-tipo" value="adicional" ${tipoAtual === 'adicional' ? 'checked' : ''}><span>Adicional</span></label>
          <label class="opcao"><input type="radio" name="aj-tipo" value="remover"><span>Sem ajuste</span></label></div></fieldset>
        <div class="campo"><label for="aj-valor">Valor</label><div class="campo-moeda"><span>R$</span><input id="aj-valor" inputmode="decimal" autocomplete="off" value="${atual ? fmtNum(Math.abs(atual).toFixed(2)) : ''}" placeholder="0,00"></div></div>
        <div class="previa"><span>Novo total</span><strong id="aj-previa">${A.fmtBRL(a.valor_total)}</strong></div>
        <p class="aviso-campo" id="aj-aviso" role="alert"></p>`,
      rodape: `${voltarDetalhe()}<button type="submit" class="btn btn--solid" id="aj-salvar">Salvar ajuste</button>`,
      aberto() {
        ligarVoltar(a, aoMudar);
        const calc = () => {
          const tipo = $('input[name="aj-tipo"]:checked').value;
          const v = tipo === 'remover' ? 0 : (numBR($('#aj-valor').value) || 0);
          const ajuste = tipo === 'desconto' ? -v : tipo === 'adicional' ? v : 0;
          const novo = centavos(semAjuste + ajuste);
          $('#aj-valor').disabled = tipo === 'remover';
          $('#aj-previa').textContent = A.fmtBRL(Math.max(0, novo));
          const aviso = !Number.isFinite(v) || v < 0 ? 'Informe um valor válido.' : novo < 0 ? 'O desconto não pode ser maior que o valor da comanda.' : novo < pago ? `O cliente já pagou ${A.fmtBRL(pago)}; o total não pode ficar abaixo disso.` : '';
          $('#aj-aviso').textContent = aviso;
          $('#aj-salvar').disabled = !!aviso;
          return { ajuste: centavos(ajuste), aviso };
        };
        $('#modal-corpo').oninput = calc; $('#modal-corpo').onchange = calc;
        calc();
        $('#aj-valor').focus();
      },
      async enviar() {
        const tipo = $('input[name="aj-tipo"]:checked').value;
        const v = tipo === 'remover' ? 0 : (numBR($('#aj-valor').value) || 0);
        const ajuste = centavos(tipo === 'desconto' ? -v : tipo === 'adicional' ? v : 0);
        const novo = centavos(semAjuste + ajuste);
        if (!Number.isFinite(v) || v < 0 || novo < 0 || novo < pago) return toast($('#aj-aviso').textContent || 'Confira o valor.', false);
        const ok = await seguro(() => Api.ajusteAgendamento(a.id, ajuste).then(() => true));
        if (ok) { fecharModal(); toast(ajuste ? 'Ajuste salvo.' : 'Ajuste removido.'); aoMudar(); }
      },
    });
  }

  function formVenda(a, aoMudar) {
    const disponiveis = D.produtos.filter((p) => p.ativo && p.estoque > 0);
    if (!disponiveis.length) return toast('Não há produtos com estoque disponível.', false);
    abrirModal({
      titulo: 'Adicionar produto',
      corpo: `<p class="sub">O valor entra na comanda de ${esc(BJ.nome(a.cliente.nome))} e a saída é registrada no estoque.</p>
        <fieldset class="campo"><legend class="rotulo">Produto</legend><div class="lista-escolha">${disponiveis.map((p, i) => `
          <label class="escolha"><input type="radio" name="vp-produto" value="${p.id}" ${i === 0 ? 'checked' : ''}>
            <span class="escolha__txt"><b>${esc(p.nome)}</b><small>${plural(p.estoque, 'unidade', 'unidades')} em estoque</small></span><span class="escolha__preco">${A.fmtBRL(p.preco)}</span></label>`).join('')}</div></fieldset>
        <div class="campo"><label for="vp-qtd">Quantidade</label><div class="contador"><button type="button" class="icone" data-qtd="-1" aria-label="Diminuir">−</button><input id="vp-qtd" type="number" min="1" step="1" value="1" inputmode="numeric"><button type="button" class="icone" data-qtd="1" aria-label="Aumentar">+</button></div></div>
        <div class="previa"><span>Valor a adicionar</span><strong id="vp-previa"></strong></div>`,
      rodape: `${voltarDetalhe()}<button type="submit" class="btn btn--solid">Adicionar à comanda</button>`,
      aberto() {
        ligarVoltar(a, aoMudar);
        const produto = () => disponiveis.find((p) => p.id === Number(($('input[name="vp-produto"]:checked') || {}).value));
        const calc = () => {
          const p = produto(); const q = $('#vp-qtd');
          q.max = p.estoque;
          if (Number(q.value) > p.estoque) q.value = p.estoque;
          $('#vp-previa').textContent = A.fmtBRL(centavos(p.preco * Math.max(1, Number(q.value) || 1)));
        };
        $('#modal-corpo').onclick = (e) => { const b = e.target.closest('[data-qtd]'); if (!b) return; const q = $('#vp-qtd'); q.value = Math.max(1, (Number(q.value) || 1) + Number(b.dataset.qtd)); calc(); };
        $('#modal-corpo').onchange = calc; $('#modal-corpo').oninput = calc;
        calc();
      },
      async enviar() {
        const p = disponiveis.find((x) => x.id === Number(($('input[name="vp-produto"]:checked') || {}).value));
        const quantidade = Number($('#vp-qtd').value);
        if (!p || !Number.isInteger(quantidade) || quantidade < 1) return toast('Informe uma quantidade inteira maior que zero.', false);
        if (quantidade > p.estoque) return toast(`Só há ${plural(p.estoque, 'unidade', 'unidades')} em estoque.`, false);
        const ok = await seguro(() => Api.venderProduto(a.id, p.id, quantidade).then(() => true));
        if (ok) { fecharModal(); await recarregar(); toast(`${p.nome} adicionado à comanda.`); aoMudar(); }
      },
    });
  }

  /* --------------------------------------------- venda avulsa (balcão, sem agendamento) */
  function formVendaAvulsa(aoCriar) {
    const disponiveis = D.produtos.filter((p) => p.ativo && p.estoque > 0);
    if (!disponiveis.length) return toast('Não há produtos com estoque disponível.', false);
    const qtd = {}; // produto_id -> quantidade escolhida
    let clientes = [];
    seguro(() => Api.clientes()).then((r) => {
      clientes = (r && r.clientes) || [];
      const dl = $('#va-clientes');
      if (dl) dl.innerHTML = clientes.map((c) => `<option value="${esc(c.nome)}">${c.whatsapp ? esc(fmtTel(c.whatsapp)) : ''}</option>`).join('');
    });
    const clienteEscolhido = () => {
      const nome = ($('#va-cliente').value || '').trim().toLowerCase();
      return nome ? clientes.find((c) => c.nome.trim().toLowerCase() === nome) || null : null;
    };
    const itens = () => disponiveis.filter((p) => qtd[p.id] > 0).map((p) => ({ produto: p, quantidade: qtd[p.id] }));
    abrirModal({
      titulo: 'Venda avulsa',
      corpo: `<p class="sub">Para quem vem só comprar um produto. O estoque baixa e o valor entra no caixa do dia, sem ocupar horário na agenda.</p>
        <fieldset class="campo"><legend class="rotulo">Produtos</legend><div class="lista-escolha lista-qtd">${disponiveis.map((p) => `
          <div class="escolha escolha--qtd" data-va-prod="${p.id}"><span class="escolha__txt"><b>${esc(p.nome)}</b><small>${A.fmtBRL(p.preco)} · ${p.estoque} em estoque</small></span>
            <div class="qtd"><button type="button" class="icone" data-va="-1" aria-label="Tirar uma unidade de ${esc(p.nome)}" disabled>−</button><output aria-live="polite">0</output><button type="button" class="icone" data-va="1" aria-label="Adicionar uma unidade de ${esc(p.nome)}">+</button></div></div>`).join('')}</div></fieldset>
        <fieldset class="campo"><legend class="rotulo">Forma de pagamento</legend><div class="opcoes">${Object.entries(FORMAS).map(([k, v]) => `<label class="opcao"><input type="radio" name="va-forma" value="${k}" ${k === 'pix' ? 'checked' : ''}><span>${v}</span></label>`).join('')}</div></fieldset>
        <div class="campo"><label for="va-cliente">Cliente <span class="opcional">opcional</span></label><input id="va-cliente" list="va-clientes" autocomplete="off" maxlength="80" placeholder="Busque um cliente cadastrado"><datalist id="va-clientes"></datalist>
          <small id="va-cliente-info">Deixe em branco se o cliente não quiser se identificar.</small></div>
        <div class="previa"><span id="va-resumo">Nenhum produto escolhido</span><strong id="va-total">${A.fmtBRL(0)}</strong></div>`,
      rodape: '<button type="button" class="btn" data-fechar>Cancelar</button><button type="submit" class="btn btn--solid" id="va-salvar" disabled>Registrar venda</button>',
      aberto() {
        const calc = () => {
          const lista = itens();
          const total = centavos(lista.reduce((t, i) => t + i.produto.preco * i.quantidade, 0));
          const un = lista.reduce((t, i) => t + i.quantidade, 0);
          $('#va-resumo').textContent = un ? plural(un, 'item', 'itens') : 'Nenhum produto escolhido';
          $('#va-total').textContent = A.fmtBRL(total);
          $('#va-salvar').disabled = !un;
          $('#va-salvar').textContent = un ? `Registrar venda · ${A.fmtBRL(total)}` : 'Registrar venda';
          const txt = ($('#va-cliente').value || '').trim();
          const cli = clienteEscolhido();
          $('#va-cliente-info').textContent = !txt ? 'Deixe em branco se o cliente não quiser se identificar.'
            : cli ? `Venda vinculada a ${BJ.nome(cli.nome)}${cli.whatsapp ? ' · ' + fmtTel(cli.whatsapp) : ''}.`
              : 'Cliente não encontrado. Escolha um nome da lista ou deixe em branco.';
        };
        $('#modal-corpo').onclick = (e) => {
          const b = e.target.closest('[data-va]');
          if (!b) return;
          const linha = b.closest('[data-va-prod]');
          const p = disponiveis.find((x) => x.id === Number(linha.dataset.vaProd));
          const n = Math.min(p.estoque, Math.max(0, (qtd[p.id] || 0) + Number(b.dataset.va)));
          if (Number(b.dataset.va) > 0 && n === (qtd[p.id] || 0)) toast(`Só há ${plural(p.estoque, 'unidade', 'unidades')} de ${p.nome} em estoque.`, false);
          qtd[p.id] = n;
          $('output', linha).textContent = n;
          linha.classList.toggle('sel', n > 0);
          $('[data-va="-1"]', linha).disabled = n === 0;
          $('[data-va="1"]', linha).disabled = n >= p.estoque;
          calc();
        };
        $('#modal-corpo').oninput = calc;
        calc();
      },
      async enviar() {
        const lista = itens();
        if (!lista.length) return toast('Escolha ao menos um produto.', false);
        const forma = ($('input[name="va-forma"]:checked') || {}).value;
        if (!forma) return toast('Escolha a forma de pagamento.', false);
        const txt = ($('#va-cliente').value || '').trim();
        const cli = clienteEscolhido();
        if (txt && !cli) { $('#va-cliente').focus(); return toast('Cliente não encontrado. Escolha um nome da lista ou deixe em branco.', false); }
        const venda = await seguro(() => Api.vendaAvulsa(lista.map((i) => ({ produto_id: i.produto.id, quantidade: i.quantidade })), forma, cli ? cli.id : null));
        if (!venda) return;
        fecharModal();
        await recarregar();
        toast(`Venda de ${A.fmtBRL(venda.valor_total)} registrada${forma === 'dinheiro' ? '. Entrou no caixa do dia' : ''}.`);
        if (aoCriar) aoCriar(venda);
      },
    });
  }
  const resumoItens = (v) => v.itens.map((i) => (i.quantidade > 1 ? `${i.quantidade}× ` : '') + i.nome).join(', ');
  function cartaoVendasAvulsas(vendas, caixaFechado) {
    if (vendas == null) {
      return `<div class="cartao cartao__pad vendas-cartao"><h2>Vendas avulsas</h2><p class="nota">${BJIcons.svg('alert')}Não foi possível carregar as vendas avulsas. Se o painel usa o Supabase, rode o arquivo supabase/vendas-avulsas.sql no SQL Editor.</p></div>`;
    }
    const ativas = vendas.filter((v) => v.status === 'ativa');
    const total = centavos(ativas.reduce((t, v) => t + Number(v.valor_total), 0));
    return `<div class="cartao vendas-cartao"><div class="cartao__cab"><div><h2>Vendas avulsas de hoje</h2>
        <p>${ativas.length ? `${plural(ativas.length, 'venda', 'vendas')} · <b>${A.fmtBRL(total)}</b>` : 'Produtos vendidos no balcão, sem atendimento.'}</p></div>
        <button type="button" class="btn btn--sm btn--sec" data-venda-avulsa><i data-icon="plus"></i>Nova venda</button></div>
      ${vendas.length ? `<ul class="vendas">${vendas.map((v) => `<li class="venda${v.status === 'ativa' ? '' : ' cancelada'}">
          <div class="venda__txt"><b>${esc(resumoItens(v))}</b>
            <small>${esc((quando(v.criado_em).split(' às ')[1]) || '')} · ${esc(FORMAS[v.forma] || v.forma)}${v.cliente_nome ? ' · ' + esc(BJ.nome(v.cliente_nome)) : ''}${v.status === 'ativa' ? '' : ' · cancelada'}</small></div>
          <strong>${A.fmtBRL(v.valor_total)}</strong>
          ${v.status === 'ativa' && !caixaFechado ? `<button type="button" class="icone perigo" data-cancelar-venda="${v.id}" aria-label="Cancelar venda de ${esc(resumoItens(v))}" title="Cancelar venda">${BJIcons.svg('ban')}</button>` : ''}</li>`).join('')}</ul>`
        : `<p class="vendas-vazio">Nenhuma venda avulsa hoje. Quando alguém vier só comprar um produto, registre em <b>Nova venda</b>.</p>`}</div>`;
  }

  /* ------------------------------------------------- agendamento presencial */
  /** Novo agendamento presencial; com `remarcar` (um agendamento), vira "Mudar horário": só data e horário mudam. */
  async function abrirAgendamentoAdmin(dataInicial, aoCriar, remarcar = null) {
    const servicos = D.servicos.filter((s) => s.ativo);
    const cacheDia = {}; // data -> agendamentos confirmados do dia
    let inicioSel = null;
    let clientes = [];
    if (!remarcar) seguro(() => Api.clientes()).then((r) => {
      clientes = (r && r.clientes) || [];
      const dl = $('#admin-ag-clientes');
      if (dl) dl.innerHTML = clientes.map((c) => `<option value="${esc(c.nome)}">${c.whatsapp ? esc(fmtTel(c.whatsapp)) : ''}</option>`).join('');
    });
    const ehAtual = (data, min) => remarcar && data === remarcar.data && min === remarcar.inicio_min;
    abrirModal({
      titulo: remarcar ? 'Reagendar' : 'Novo agendamento',
      corpo: `${remarcar
        ? `<p class="sub">${esc(BJ.nome(remarcar.cliente.nome))} · ${remarcar.servicos.map((s) => esc(s.nome)).join(' + ')}. Hoje marcado para <b>${esc(dataCurta(remarcar.data))} às ${A.fmtMin(remarcar.inicio_min)}</b>. Valores, pagamentos e produtos continuam iguais.</p>`
        : `<p class="sub">Para clientes que marcam pelo telefone ou chegam sem horário. Sobrenome e telefone são opcionais.</p>
        <div class="grade2"><div class="campo"><label for="admin-ag-nome">Nome do cliente</label><input id="admin-ag-nome" maxlength="80" list="admin-ag-clientes" autocomplete="off" required><datalist id="admin-ag-clientes"></datalist></div>
          <div class="campo"><label for="admin-ag-whats">WhatsApp <span class="opcional">opcional</span></label><input id="admin-ag-whats" ${CAMPO_TEL}></div></div>
        <fieldset class="campo"><legend class="rotulo">Serviços</legend><div class="chips">${servicos.map((s) => `<label class="chip"><input type="checkbox" name="admin-ag-servico" value="${s.id}"><span>${esc(s.nome)}<small>${esc(brl(s.preco))}</small></span></label>`).join('')}</div></fieldset>`}
        <div class="campo"><label for="admin-ag-data">${remarcar ? 'Nova data' : 'Data'}</label><input id="admin-ag-data" type="date" value="${esc((remarcar && remarcar.data) || dataInicial || hojeIso())}" required></div>
        <fieldset class="campo"><legend class="rotulo">${remarcar ? 'Novo horário' : 'Horário'}</legend><div id="admin-ag-slots" class="slots-adm-area"></div></fieldset>
        <div class="previa" id="admin-ag-resumo"><span>Selecione ao menos um serviço</span><strong></strong></div>`,
      rodape: `<button type="button" class="btn" data-fechar>${remarcar ? 'Voltar' : 'Cancelar'}</button><button type="submit" class="btn btn--solid">${remarcar ? 'Reagendar' : 'Criar agendamento'}</button>`,
      aberto() {
        const ids = () => $$('input[name="admin-ag-servico"]:checked').map((el) => Number(el.value));
        const resumo = () => {
          const box = $('#admin-ag-resumo');
          if (remarcar) {
            const novo = inicioSel != null ? `${A.fmtMin(inicioSel)} às ${A.fmtMin(inicioSel + remarcar.duracao_min)}` : 'escolha o novo horário';
            box.innerHTML = `<span>${A.fmtDur(remarcar.duracao_min)} · ${novo}</span><strong>${esc(valorAg(remarcar))}</strong>`;
            return;
          }
          const p = A.calcPricing(ids(), D.servicos, D.combos);
          if (!ids().length) { box.innerHTML = '<span>Selecione ao menos um serviço</span><strong></strong>'; return; }
          box.innerHTML = `<span>${A.fmtDur(p.duracao)}${inicioSel != null ? ` · ${A.fmtMin(inicioSel)} às ${A.fmtMin(inicioSel + p.duracao)}` : ' · escolha um horário'}${p.economia ? ' · combo aplicado' : ''}</span><strong>${esc(p.consulta ? (p.total ? A.fmtBRL(p.total) + ' + a consultar' : 'A consultar') : A.fmtBRL(p.total))}</strong>`;
        };
        /** Grade com todos os horários do dia: livres para escolher e ocupados com o motivo (cliente, almoço, bloqueio). */
        const horarios = async () => {
          const area = $('#admin-ag-slots'); const data = $('#admin-ag-data').value;
          if (!data) { area.innerHTML = '<p class="slots-adm-msg">Escolha a data.</p>'; return resumo(); }
          if (!A.janelaDoDia(data, D.horarios)) { inicioSel = null; area.innerHTML = '<p class="slots-adm-msg">A barbearia não abre neste dia.</p>'; return resumo(); }
          if (!cacheDia[data]) {
            area.innerHTML = '<p class="slots-adm-msg"><span class="spinner" aria-hidden="true"></span>Carregando horários…</p>';
            const lista = await seguro(() => Api.agendamentos(data, data));
            // ao remarcar, o próprio horário atual não ocupa a agenda
            cacheDia[data] = (lista || []).filter((a) => a.status === 'confirmado' && !(remarcar && a.id === remarcar.id));
            if ($('#admin-ag-data').value !== data) return; // trocou a data no meio do caminho
          }
          const ags = cacheDia[data];
          const temServico = !!remarcar || ids().length > 0;
          const passo = Math.max(5, Number(D.config.passo_min || 20));
          const duracao = remarcar ? remarcar.duracao_min : temServico ? A.calcPricing(ids(), D.servicos, D.combos).duracao : passo;
          const slots = A.gerarHorarios({ data, duracao, horarios: D.horarios, config: D.config, bloqueios: D.bloqueios, ocupados: ags.map((a) => ({ ini: a.inicio_min, fim: a.fim_min })) })
            .filter((s) => s.motivo !== 'FORA_DO_EXPEDIENTE');
          const agoraMin = data === hojeIso() ? minAgora() : -1;
          const livres = slots.filter((s) => s.livre && !ehAtual(data, s.inicio_min));
          if (inicioSel != null && !livres.some((s) => s.inicio_min === inicioSel)) inicioSel = null;
          // ao remarcar, nada vem pré-selecionado: a pessoa escolhe o novo horário
          if (temServico && !remarcar && inicioSel == null && livres.length) inicioSel = (livres.find((s) => s.inicio_min >= agoraMin) || livres[0]).inicio_min;
          // O que ocupa o início do slot: almoço, bloqueio ou cliente (com o intervalo real). Sem dono = o atendimento "não cabe".
          const almoco = A.almoco(D.config);
          const ocupante = (t) => {
            if (almoco && almoco.ini <= t && t < almoco.fim) return { chave: 'almoco', rot: 'Almoço', ini: almoco.ini, fim: almoco.fim };
            const b = D.bloqueios.find((x) => x.data === data && x.inicio_min <= t && t < x.fim_min);
            if (b) return { chave: 'b' + b.id, rot: b.motivo || 'Bloqueado', ini: b.inicio_min, fim: b.fim_min };
            const a = ags.find((x) => x.inicio_min <= t && t < x.fim_min);
            if (a) return { chave: 'a' + a.id, rot: BJ.nome(a.cliente.nome).split(' ')[0], ini: a.inicio_min, fim: a.fim_min };
            return null;
          };
          const janela = A.janelaDoDia(data, D.horarios);
          let ultimaChave = null;
          const itens = slots.map((s) => {
            const passou = s.inicio_min < agoraMin;
            const occ = s.livre ? null : ocupante(s.inicio_min);
            if (occ) {
              if (occ.chave === ultimaChave) return ''; // período já mostrado em um bloco só
              ultimaChave = occ.chave;
              const ini = Math.max(occ.ini, janela.ini), fim = Math.min(occ.fim, janela.fim);
              return `<div class="slot-adm ocupado bloco" role="note" aria-label="${A.fmtMin(ini)} às ${A.fmtMin(fim)}, ${esc(occ.rot)}"><b>${A.fmtMin(ini)}–${A.fmtMin(fim)}</b><small>${esc(occ.rot)}</small></div>`;
            }
            ultimaChave = null;
            if (ehAtual(data, s.inicio_min)) {
              return `<button type="button" class="slot-adm atual" disabled aria-label="${A.fmtMin(s.inicio_min)}, horário atual"><b>${A.fmtMin(s.inicio_min)}</b><small>atual</small></button>`;
            }
            // começa livre, mas o atendimento inteiro esbarra em algo antes de terminar
            const rot = s.livre ? (passou ? 'já passou' : 'livre') : s.motivo === 'ALMOCO' ? 'invade almoço' : s.motivo === 'BLOQUEADO' ? 'invade bloqueio' : 'não cabe';
            return `<button type="button" class="slot-adm${s.livre ? '' : ' ocupado'}${passou ? ' passou' : ''}${s.inicio_min === inicioSel ? ' sel' : ''}" data-slot="${s.inicio_min}" ${s.livre && temServico ? '' : 'disabled'} aria-pressed="${s.inicio_min === inicioSel}" aria-label="Começar às ${A.fmtMin(s.inicio_min)}, ${esc(rot)}">
              <b>${A.fmtMin(s.inicio_min)}</b><small>${esc(rot)}</small></button>`;
          }).join('');
          area.innerHTML = `${temServico ? '' : '<p class="slots-adm-msg">Escolha os serviços para marcar. Abaixo, a ocupação do dia.</p>'}
            <div class="slots-adm" role="group" aria-label="Horários do dia">${itens}</div>
            <p class="slots-adm-legenda">Expediente das ${A.fmtMin(janela.ini)} às ${A.fmtMin(janela.fim)}. Os horários indicam o <b>início</b> do atendimento${temServico ? `, que precisa terminar antes do próximo compromisso` : ''}.</p>
            ${temServico && !livres.length ? '<p class="slots-adm-msg">Nenhum horário livre comporta esses serviços neste dia.</p>' : ''}`;
          resumo();
        };
        $('#modal-corpo').onchange = (e) => {
          if (e.target.matches('input[name="admin-ag-servico"], #admin-ag-data')) horarios();
          else if (e.target.id === 'admin-ag-nome') {
            const c = clientes.find((x) => x.nome.toLowerCase() === e.target.value.trim().toLowerCase());
            if (c && c.whatsapp && !$('#admin-ag-whats').value) $('#admin-ag-whats').value = fmtTel(c.whatsapp);
          }
        };
        $('#modal-corpo').onclick = (e) => {
          const b = e.target.closest('[data-slot]');
          if (!b || b.disabled) return;
          inicioSel = Number(b.dataset.slot);
          $$('.slot-adm', $('#admin-ag-slots')).forEach((x) => { const on = Number(x.dataset.slot) === inicioSel; x.classList.toggle('sel', on); x.setAttribute('aria-pressed', on); });
          resumo();
        };
        horarios();
        $(remarcar ? '#admin-ag-data' : '#admin-ag-nome').focus();
      },
      async enviar() {
        if (remarcar) {
          const data = $('#admin-ag-data').value;
          if (!data || inicioSel == null) return toast('Escolha a nova data e um horário livre.', false);
          const r = await seguro(() => Api.reagendar(remarcar.id, data, inicioSel));
          if (!r) return;
          if (!r.ok) return toast(BJ.mensagemErro(r.erro), false);
          fecharModal();
          toast(`Horário de ${BJ.nome(remarcar.cliente.nome).split(' ')[0]} mudado para ${A.fmtData(data)} às ${A.fmtMin(inicioSel)}.${remarcar.lembrete_aberto_em || remarcar.lembrete_enviado_em ? ' Envie o lembrete de novo com o horário novo.' : ''}`);
          aoCriar(data);
          return;
        }
        const nome = BJ.nome($('#admin-ag-nome').value);
        const whatsapp = digitos($('#admin-ag-whats').value);
        const data = $('#admin-ag-data').value;
        const servico_ids = $$('input[name="admin-ag-servico"]:checked').map((el) => Number(el.value));
        if (!nome) { $('#admin-ag-nome').focus(); return toast('Informe o nome do cliente.', false); }
        if (whatsapp && !telValido(whatsapp)) return toast('Confira o WhatsApp: DDD + número, ex.: (11)98765-4321. Ou deixe o campo vazio.', false);
        if (!servico_ids.length) return toast('Selecione pelo menos um serviço.', false);
        if (!data || inicioSel == null) return toast('Escolha a data e um horário livre.', false);
        const r = await seguro(() => Api.agendarAdmin({ data, inicio_min: inicioSel, servico_ids, nome, whatsapp }));
        if (!r) return;
        if (!r.ok) return toast(BJ.mensagemErro(r.erro), false);
        fecharModal();
        toast(`Agendamento de ${nome} criado para ${A.fmtData(data)} às ${A.fmtMin(inicioSel)}.`);
        aoCriar(data);
      },
    });
  }

  /* ================================================================== Hoje */
  async function vDashboard(c) {
    const dia = S.dia || hojeIso();
    S.dia = dia;
    const ehHoje = dia === hojeIso();
    const [todos, caixa] = await Promise.all([Api.agendamentos(dia, dia), ehHoje ? Api.caixaDiario(dia).catch(() => null) : null]);
    todos.forEach((a) => S.ag.set(String(a.id), a));
    const ativos = todos.filter((a) => a.status === 'confirmado');
    const cancelados = todos.filter((a) => a.status === 'cancelado').length;
    const faltas = todos.filter((a) => a.status === 'falta').length;
    // quem faltou continua na lista do dia (com a etiqueta); cancelados ficam de fora
    const listaDia = todos.filter((a) => a.status !== 'cancelado');
    const soma = (f) => centavos(ativos.reduce((s, a) => s + Number(f(a) || 0), 0));
    const previsto = soma((a) => a.valor_total), recebido = soma((a) => a.total_pago), falta = soma((a) => a.saldo_devedor);
    const mins = ativos.reduce((s, a) => s + a.duracao_min, 0);
    const agoraMin = minAgora();
    const atual = ehHoje ? ativos.find((a) => a.fim_min > agoraMin) : null;
    const emAtendimento = atual && atual.inicio_min <= agoraMin;

    c.innerHTML = `<div class="pg-topo"><div><h1>${ehHoje ? 'Hoje' : esc(dataCurta(dia))}</h1><p>${esc(cap(dataLonga(dia)))}</p></div>
        <div class="pg-acoes"><div class="dia-nav"><button type="button" class="icone" data-d="-1" aria-label="Dia anterior"><i data-icon="left"></i></button>
          <input type="date" id="dash-data" value="${dia}" aria-label="Escolher dia">
          <button type="button" class="icone" data-d="1" aria-label="Próximo dia"><i data-icon="right"></i></button>
          ${ehHoje ? '' : '<button type="button" class="btn btn--sm btn--sec" data-d="0">Hoje</button>'}</div>
          <button type="button" class="btn btn--solid" data-admin-agendar><i data-icon="plus"></i>Novo agendamento</button></div></div>
      ${caixa && caixa.status === 'nao_aberto' ? `<a class="aviso-barra" href="#/caixa">${BJIcons.svg('wallet')}<span><b>O caixa de hoje ainda não foi aberto.</b> Registre o troco inicial para conferir o fechamento no fim do dia.</span><span class="aviso-barra__acao">Abrir caixa</span></a>` : ''}
      <div class="kpis">
        ${kpi('Agendamentos', ativos.length, cancelados || faltas ? [faltas ? plural(faltas, 'falta', 'faltas') : '', cancelados ? plural(cancelados, 'cancelado', 'cancelados') : ''].filter(Boolean).join(' · ') : (mins ? A.fmtDur(mins) + ' de agenda' : 'Agenda livre'))}
        ${kpi('Previsto', A.fmtBRL(previsto))}
        ${kpi('Recebido', A.fmtBRL(recebido), previsto ? Math.round((recebido / previsto) * 100) + '% do previsto' : '')}
        ${kpi('A receber', A.fmtBRL(falta), '', falta > 0 ? 'kpi--alerta' : '')}
      </div>
      ${atual ? `<button type="button" class="destaque" data-ag="${atual.id}">
          <span class="destaque__rotulo">${emAtendimento ? 'Em atendimento' : `Próximo · em ${A.fmtDur(atual.inicio_min - agoraMin)}`}</span>
          <span class="destaque__hora">${A.fmtMin(atual.inicio_min)}</span>
          <span class="destaque__info"><b>${esc(BJ.nome(atual.cliente.nome))}</b><span>${esc(atual.servicos.map((s) => s.nome).join(' + '))}</span></span>
          <span class="destaque__seta">${BJIcons.svg('right')}</span></button>` : ''}
      <div class="cartao"><div class="cartao__cab"><h2>Agenda do dia</h2><a class="link" href="#/agendamentos">Ver agenda completa</a></div>
        ${listaDia.length ? `<div class="lista">${listaDia.map((a) => linhaAg(a, atual && a.id === atual.id ? ' atual' : (ehHoje && a.fim_min <= agoraMin ? ' passado' : ''))).join('')}</div>`
          : vazio('calendar', 'Nenhum agendamento neste dia', ehHoje ? 'Os horários marcados pelo site aparecem aqui automaticamente.' : '', '<button type="button" class="btn btn--sm btn--sec" data-admin-agendar>Agendar cliente</button>')}</div>`;
    c.onclick = (e) => {
      if (e.target.closest('[data-admin-agendar]')) return abrirAgendamentoAdmin(S.dia, (d) => { S.dia = d; refazer(); });
      const r = e.target.closest('[data-ag]');
      if (r) return detalheAg(S.ag.get(r.dataset.ag), refazer);
      const d = e.target.closest('[data-d]');
      if (d) { const k = Number(d.dataset.d); S.dia = k === 0 ? hojeIso() : A.addDays(S.dia, k); refazer(); }
    };
    c.onchange = (e) => { if (e.target.id === 'dash-data' && e.target.value) { S.dia = e.target.value; refazer(); } };
  }

  /* ================================================================== Agenda */
  async function vAgendamentos(c) {
    if (!S.mes) { const [y, m] = hojeIso().split('-').map(Number); S.mes = { y, m: m - 1 }; }
    const { y, m } = S.mes;
    const ultimo = new Date(y, m + 1, 0).getDate();
    const p2 = (n) => String(n).padStart(2, '0');
    const prefixo = `${y}-${p2(m + 1)}`;
    const lista = await Api.agendamentos(`${prefixo}-01`, `${prefixo}-${p2(ultimo)}`);
    lista.forEach((a) => S.ag.set(String(a.id), a));
    const ativos = lista.filter((a) => a.status === 'confirmado');
    const porDia = {};
    ativos.forEach((a) => { porDia[a.data] = (porDia[a.data] || 0) + 1; });
    if (!S.diaAg || S.diaAg.slice(0, 7) !== prefixo) S.diaAg = hojeIso().slice(0, 7) === prefixo ? hojeIso() : `${prefixo}-01`;
    const primeiro = new Date(y, m, 1).getDay();
    let cel = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'].map((l) => `<span class="sem" aria-hidden="true">${l}</span>`).join('') + '<span class="vazio-c"></span>'.repeat(primeiro);
    for (let d = 1; d <= ultimo; d++) {
      const iso = `${prefixo}-${p2(d)}`;
      const n = porDia[iso] || 0;
      const fechado = !A.janelaDoDia(iso, D.horarios);
      cel += `<button type="button" data-dia="${iso}" class="${iso === S.diaAg ? 'sel' : ''}${iso === hojeIso() ? ' hoje' : ''}${fechado ? ' fechado' : ''}" aria-label="${esc(dataLonga(iso))}${n ? ', ' + plural(n, 'agendamento', 'agendamentos') : ''}" ${iso === S.diaAg ? 'aria-pressed="true"' : ''}>${d}${n ? `<i>${n}</i>` : ''}</button>`;
    }
    const doDia = lista.filter((a) => a.data === S.diaAg && (S.mostrarCancelados || a.status !== 'cancelado'));
    const canceladosDia = lista.filter((a) => a.data === S.diaAg && a.status === 'cancelado').length;
    const totalDia = centavos(doDia.filter((a) => a.status === 'confirmado').reduce((s, a) => s + Number(a.valor_total), 0));
    c.innerHTML = `<div class="pg-topo"><div><h1>Agenda</h1><p>Escolha um dia no calendário para ver os horários marcados.</p></div>
        <div class="pg-acoes"><button type="button" class="btn btn--solid" data-admin-agendar><i data-icon="plus"></i>Novo agendamento</button></div></div>
      <div class="duas-col"><div class="cartao cartao__pad">
          <div class="cal-topo"><button type="button" class="icone" data-mes="-1" aria-label="Mês anterior"><i data-icon="left"></i></button><strong>${A.MESES[m]} ${y}</strong><button type="button" class="icone" data-mes="1" aria-label="Próximo mês"><i data-icon="right"></i></button></div>
          <div class="cal-adm" role="group" aria-label="Calendário">${cel}</div>
          <p class="cal-legenda">${plural(ativos.length, 'agendamento', 'agendamentos')} no mês</p></div>
        <div class="cartao"><div class="cartao__cab"><div><h2>${esc(cap(dataLonga(S.diaAg)))}</h2><p>${plural(doDia.filter((a) => a.status === 'confirmado').length, 'agendamento', 'agendamentos')}${totalDia ? ' · ' + A.fmtBRL(totalDia) : ''}</p></div>
            ${canceladosDia || S.mostrarCancelados ? `<label class="alternar"><span class="chave"><input type="checkbox" id="ver-canc" ${S.mostrarCancelados ? 'checked' : ''}><span></span></span>Cancelados (${canceladosDia})</label>` : ''}</div>
          ${doDia.length ? `<div class="lista agenda-dia-lista">${doDia.map((a) => linhaAg(a)).join('')}</div>`
            : vazio('calendar', A.janelaDoDia(S.diaAg, D.horarios) ? 'Nenhum agendamento neste dia' : 'A barbearia não abre neste dia', '', A.janelaDoDia(S.diaAg, D.horarios) ? '<button type="button" class="btn btn--sm btn--sec" data-admin-agendar>Agendar cliente</button>' : '')}</div></div>`;
    c.onclick = (e) => {
      if (e.target.closest('[data-admin-agendar]')) return abrirAgendamentoAdmin(S.diaAg, (dia) => { S.diaAg = dia; S.mes = { y: Number(dia.slice(0, 4)), m: Number(dia.slice(5, 7)) - 1 }; refazer(); });
      const r = e.target.closest('[data-ag]'); if (r) return detalheAg(S.ag.get(r.dataset.ag), refazer);
      const d = e.target.closest('[data-dia]'); if (d) { S.diaAg = d.dataset.dia; return refazer(); }
      const mm = e.target.closest('[data-mes]');
      if (mm) { const t = new Date(S.mes.y, S.mes.m + Number(mm.dataset.mes), 1); S.mes = { y: t.getFullYear(), m: t.getMonth() }; refazer(); }
    };
    c.onchange = (e) => { if (e.target.id === 'ver-canc') { S.mostrarCancelados = e.target.checked; refazer(); } };
  }

  /* ==================================================================== Caixa */
  const PERIODOS = { hoje: 'Hoje', semana: 'Semana', mes: 'Mês', ano: 'Ano', total: 'Tudo' };
  const TIPOS_MOV = { sangria: 'Sangria', despesa: 'Despesa', reforco: 'Reforço' };
  const AJUDA_MOV = {
    sangria: 'Dinheiro tirado da gaveta para guardar ou depositar. Não é gasto.',
    despesa: 'Um gasto da barbearia (fornecedor, lanche, material). Se foi pago em dinheiro, sai da gaveta.',
    reforco: 'Troco colocado na gaveta durante o dia.',
  };
  /** Formulário de sangria, despesa ou reforço no caixa de hoje. */
  function formMovimentoCaixa(tipo, aoSalvar) {
    const despesa = tipo === 'despesa';
    abrirModal({
      titulo: TIPOS_MOV[tipo],
      corpo: `<p class="sub">${esc(AJUDA_MOV[tipo])}</p>
        <div class="grade2"><div class="campo"><label for="mov-valor">Valor</label><div class="campo-moeda"><span>R$</span><input id="mov-valor" inputmode="decimal" autocomplete="off" placeholder="0,00" required></div></div>
          ${despesa ? `<div class="campo"><label for="mov-forma">Pago com</label><select id="mov-forma">${Object.entries(FORMAS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></div>` : ''}</div>
        <div class="campo"><label for="mov-desc">${despesa ? 'Com o que foi' : 'Observação <span class="opcional">opcional</span>'}</label><input id="mov-desc" maxlength="120" placeholder="${despesa ? 'Ex.: lâminas, café, conta de luz' : tipo === 'sangria' ? 'Ex.: depósito no banco' : 'Ex.: troco em moedas'}" ${despesa ? 'required' : ''}></div>`,
      rodape: `<button type="button" class="btn" data-fechar>Cancelar</button><button type="submit" class="btn btn--solid">Lançar ${esc(TIPOS_MOV[tipo].toLowerCase())}</button>`,
      aberto() { $('#mov-valor').focus(); },
      async enviar() {
        const valor = centavos(numBR($('#mov-valor').value));
        if (!(valor > 0)) { $('#mov-valor').focus(); return toast('Informe um valor maior que zero.', false); }
        const descricao = $('#mov-desc').value.trim();
        if (despesa && !descricao) { $('#mov-desc').focus(); return toast('Diga com o que foi a despesa.', false); }
        const forma = despesa ? $('#mov-forma').value : 'dinheiro';
        const r = await seguro(() => Api.movimentoCaixa(tipo, valor, forma, descricao));
        if (!r) return;
        fecharModal();
        toast(`${TIPOS_MOV[tipo]} de ${A.fmtBRL(valor)} ${tipo === 'reforco' ? 'lançado' : 'lançada'}${forma === 'dinheiro' ? '' : ' (fora da gaveta)'}.`);
        aoSalvar();
      },
    });
  }
  function cartaoCaixaDia(cx, dia) {
    if (cx.status === 'nao_aberto') {
      return `<div class="cartao cartao__pad caixa-dia"><div class="caixa-dia__cab"><div><h2>Caixa do dia</h2><p>${esc(dataCurta(dia))} · informe quanto dinheiro tem na gaveta para começar.</p></div>${pill(['Não aberto', 'muted'])}</div>
        <form id="form-abrir-caixa" class="caixa-form">
          <div class="campo"><label for="caixa-abertura">Troco inicial</label><div class="campo-moeda"><span>R$</span><input id="caixa-abertura" inputmode="decimal" autocomplete="off" placeholder="0,00" required></div></div>
          <div class="campo"><label for="caixa-observacao">Observação <span class="opcional">opcional</span></label><input id="caixa-observacao" maxlength="240" placeholder="Ex.: troco do dia anterior"></div>
          <button class="btn btn--solid" type="submit">Abrir caixa</button>
        </form>
        ${cx.recebido_dinheiro ? `<p class="nota">${BJIcons.svg('info')}Já há ${A.fmtBRL(cx.recebido_dinheiro)} recebidos em dinheiro hoje.</p>` : ''}</div>`;
    }
    const aberto = cx.status === 'aberto';
    const dif = Number(cx.diferenca || 0);
    const reforcos = Number(cx.reforcos || 0);
    const entradas = centavos(Number(cx.recebido_dinheiro || 0) + reforcos);
    const saidas = Number(cx.saidas_dinheiro ?? cx.devolvido_dinheiro ?? 0);
    const movs = cx.movimentos || [];
    // devoluções vêm dos cancelamentos; aparecem na lista para a conta da gaveta fechar
    const linhasSaida = [
      ...movs.map((mv) => `<li class="${mv.tipo === 'reforco' ? 'pos' : 'neg'}"><span>${esc(TIPOS_MOV[mv.tipo])}${mv.descricao ? ' · ' + esc(mv.descricao) : ''}<small>${esc((quando(mv.criado_em).split(' às ')[1]) || '')}${mv.forma !== 'dinheiro' ? ' · ' + esc(FORMAS[mv.forma] || mv.forma) + ' (fora da gaveta)' : ''}</small></span>
        <b>${mv.tipo === 'reforco' ? '+ ' : '− '}${A.fmtBRL(mv.valor)}</b>${aberto ? `<button type="button" class="icone perigo" data-excluir-mov="${mv.id}" aria-label="Excluir ${esc(TIPOS_MOV[mv.tipo].toLowerCase())} de ${A.fmtBRL(mv.valor)}" title="Excluir">${BJIcons.svg('trash')}</button>` : ''}</li>`),
      ...(Number(cx.devolvido_dinheiro) > 0 ? [`<li class="neg"><span>Devoluções de cancelamentos<small>em dinheiro</small></span><b>− ${A.fmtBRL(cx.devolvido_dinheiro)}</b></li>`] : []),
    ].join('');
    const blocoMovs = `<div class="caixa-movs">
        ${aberto ? `<div class="caixa-movs__acoes"><span>Lançar na gaveta:</span>
          <button type="button" class="btn btn--sm btn--sec" data-mov="sangria">Sangria</button>
          <button type="button" class="btn btn--sm btn--sec" data-mov="despesa">Despesa</button>
          <button type="button" class="btn btn--sm btn--sec" data-mov="reforco">Reforço</button></div>` : ''}
        ${linhasSaida ? `<ul class="recibo recibo--lista caixa-movs__lista">${linhasSaida}</ul>` : ''}</div>`;
    return `<div class="cartao cartao__pad caixa-dia"><div class="caixa-dia__cab"><div><h2>Caixa do dia</h2><p>${esc(dataCurta(dia))}${cx.aberto_em ? ` · aberto às ${esc((quando(cx.aberto_em).split(' às ')[1]) || '')}` : ''}${cx.fechado_em ? ` · fechado às ${esc((quando(cx.fechado_em).split(' às ')[1]) || '')}` : ''}</p></div>
        ${pill(aberto ? ['Aberto', 'ok'] : ['Fechado', 'muted'])}</div>
      <div class="conta${saidas > 0 ? ' conta--4' : ''}">
        <div><span>Troco inicial</span><b>${A.fmtBRL(cx.valor_abertura)}</b></div>
        <div class="conta__op">+</div>
        <div><span>Entradas em dinheiro${reforcos ? ` <small>com ${A.fmtBRL(reforcos)} de reforço</small>` : ''}</span><b>${A.fmtBRL(entradas)}</b></div>
        ${saidas > 0 ? `<div class="conta__op">−</div>
        <div><span>Saídas</span><b>${A.fmtBRL(saidas)}</b></div>` : ''}
        <div class="conta__op">=</div>
        <div class="conta__res"><span>Esperado na gaveta</span><b>${A.fmtBRL(cx.valor_esperado)}</b></div>
      </div>
      ${blocoMovs}
      ${aberto ? `<form id="form-fechar-caixa" class="caixa-form caixa-form--fechar">
          <div class="campo"><label for="caixa-contado">Dinheiro contado na gaveta</label><div class="campo-moeda"><span>R$</span><input id="caixa-contado" inputmode="decimal" autocomplete="off" placeholder="${fmtNum(Number(cx.valor_esperado || 0).toFixed(2))}" required></div>
            <small>Conte as notas e moedas antes de fechar.</small></div>
          <button class="btn btn--solid" type="submit">Fechar caixa</button></form>`
        : `<div class="fechamento ${dif < 0 ? 'falta' : dif > 0 ? 'sobra' : 'certo'}"><span>Contado: <b>${A.fmtBRL(cx.valor_contado)}</b></span>
            <strong>${dif === 0 ? 'Caixa bateu certinho' : dif < 0 ? `Faltaram ${A.fmtBRL(Math.abs(dif))}` : `Sobraram ${A.fmtBRL(dif)}`}</strong></div>`}
      ${cx.observacao ? `<p class="nota">${BJIcons.svg('info')}${esc(cx.observacao)}</p>` : ''}</div>`;
  }

  async function vCaixa(c) {
    const dia = hojeIso();
    // vendas avulsas falham sozinhas (ex.: SQL novo ainda não rodado no Supabase) sem derrubar a página
    const [resumo, caixaDia, vendas] = await Promise.all([Api.caixa(), Api.caixaDiario(dia), Api.vendasAvulsas(dia).catch(() => null)]);
    const render = () => {
      const p = resumo[S.periodo] || resumo.hoje;
      const faixa = S.periodo === 'total' ? 'Todo o histórico' : p.de === p.ate ? A.fmtData(p.de) : `${A.fmtData(p.de)} a ${A.fmtData(p.ate)}`;
      const formas = Object.entries(p.por_forma || {});
      const maxForma = Math.max(0, ...formas.map(([, v]) => Number(v)));
      const top = p.servicos_mais_vendidos || [];
      const maxTop = Math.max(0, ...top.map((s) => s.quantidade));
      const pctProd = p.total > 0 ? Math.round((p.produtos / (p.servicos + p.produtos || 1)) * 100) : 0;
      $('#caixa-periodo').innerHTML = `
        <div class="periodo-cab"><div class="seg" role="tablist" aria-label="Período">${Object.entries(PERIODOS).map(([k, v]) => `<button type="button" role="tab" aria-selected="${k === S.periodo}" data-periodo="${k}">${v}</button>`).join('')}</div>
          <span class="periodo-faixa">${esc(faixa)}</span></div>
        <div class="kpis">
          ${kpi('Faturamento', A.fmtBRL(p.total), plural(p.agendamentos, 'atendimento', 'atendimentos') + (p.vendas_avulsas ? ' · ' + plural(p.vendas_avulsas, 'venda avulsa', 'vendas avulsas') : ''), 'kpi--destaque')}
          ${kpi('Recebido', A.fmtBRL(p.recebido), Number(p.devolvido) > 0 ? `Já descontados ${A.fmtBRL(p.devolvido)} devolvidos` : 'Entradas no período')}
          ${kpi('A receber', A.fmtBRL(p.a_receber), 'Dos atendimentos do período', p.a_receber > 0 ? 'kpi--alerta' : '')}
          ${kpi('Ticket médio', A.fmtBRL(p.ticket_medio), 'Por atendimento')}
        </div>
        <div class="grade-cartoes">
          <div class="cartao cartao__pad"><h2>De onde veio o faturamento</h2>
            ${p.total || p.descontos ? `<div class="divisao" aria-hidden="true"><span style="width:${100 - pctProd}%"></span><span style="width:${pctProd}%"></span></div>
            <ul class="recibo">
              <li><span><i class="ponto ponto--1"></i>Serviços e combos</span><b>${A.fmtBRL(p.servicos)}</b></li>
              <li><span><i class="ponto ponto--2"></i>Produtos${p.valor_avulsas ? `<small>${A.fmtBRL(p.valor_avulsas)} em vendas avulsas</small>` : ''}</span><b>${A.fmtBRL(p.produtos)}</b></li>
              ${p.adicionais ? `<li class="pos"><span>Adicionais</span><b>+ ${A.fmtBRL(p.adicionais)}</b></li>` : ''}
              ${p.descontos ? `<li class="neg"><span>Descontos</span><b>− ${A.fmtBRL(p.descontos)}</b></li>` : ''}
              <li class="recibo__total"><span>Total</span><b>${A.fmtBRL(p.total)}</b></li></ul>` : vazio('receipt', 'Sem atendimentos neste período')}</div>
          <div class="cartao cartao__pad"><h2>Como recebeu</h2>
            ${p.recebido ? `<div class="barras">${formas.map(([k, v]) => barra(FORMAS[k], Number(v), maxForma, `${A.fmtBRL(v)}<small>${p.recebido ? Math.round((v / p.recebido) * 100) : 0}%</small>`)).join('')}</div>`
              : vazio('wallet', 'Nenhum pagamento registrado', 'Registre os pagamentos no detalhe de cada agendamento.')}
            ${Number(p.despesas) > 0 ? `<ul class="recibo caixa-saldo"><li class="neg"><span>Despesas do período</span><b>− ${A.fmtBRL(p.despesas)}</b></li>
              <li class="recibo__total"><span>Saldo (recebido − despesas)</span><b>${A.fmtBRL(p.saldo)}</b></li></ul>` : ''}</div>
        </div>
        <div class="cartao cartao__pad"><h2>Serviços mais vendidos</h2>
          ${top.length ? `<div class="barras barras--ranking">${top.map((s, i) => barra(`<i class="pos-rank">${i + 1}</i>${esc(s.nome)}`, s.quantidade, maxTop, `${s.quantidade}×<small>${A.fmtBRL(s.valor)}</small>`, i === 0 ? 'barra--top' : '')).join('')}</div>`
            : vazio('scissors', 'Nenhum serviço vendido neste período')}</div>`;
    };
    c.innerHTML = `<div class="pg-topo"><div><h1>Caixa</h1><p>Abertura e fechamento do dia, faturamento e formas de pagamento.</p></div>
        <div class="pg-acoes"><button type="button" class="btn btn--solid" data-venda-avulsa><i data-icon="box"></i>Venda avulsa</button></div></div>
      ${cartaoCaixaDia(caixaDia, dia)}${cartaoVendasAvulsas(vendas, caixaDia.status === 'fechado')}<div id="caixa-periodo"></div>`;
    render();
    c.onclick = async (e) => {
      if (e.target.closest('[data-venda-avulsa]')) return formVendaAvulsa(() => refazer());
      const mov = e.target.closest('[data-mov]');
      if (mov) return formMovimentoCaixa(mov.dataset.mov, () => refazer());
      const ex = e.target.closest('[data-excluir-mov]');
      if (ex) {
        const mv = (caixaDia.movimentos || []).find((x) => x.id === Number(ex.dataset.excluirMov));
        if (!mv || !(await confirma(`Excluir ${TIPOS_MOV[mv.tipo].toLowerCase()} de ${A.fmtBRL(mv.valor)}${mv.descricao ? ` (${mv.descricao})` : ''}? A conta da gaveta é refeita.`, 'Excluir'))) return;
        if (await seguro(() => Api.excluirMovimentoCaixa(mv.id))) { toast('Lançamento excluído.'); refazer(); }
        return;
      }
      const cv = e.target.closest('[data-cancelar-venda]');
      if (cv) {
        const v = vendas.find((x) => x.id === Number(cv.dataset.cancelarVenda));
        if (!(await confirma([`Cancelar a venda de ${resumoItens(v)} (${A.fmtBRL(v.valor_total)})?`, `Os produtos voltam para o estoque e o valor sai do caixa${v.forma === 'dinheiro' ? '. Devolva o dinheiro ao cliente' : ''}.`], 'Cancelar venda'))) return;
        const r = await seguro(() => Api.cancelarVendaAvulsa(v.id));
        if (r) { await recarregar(); toast('Venda cancelada. Os produtos voltaram ao estoque.'); refazer(); }
        return;
      }
      const b = e.target.closest('[data-periodo]');
      if (b) { S.periodo = b.dataset.periodo; render(); BJIcons.hydrate(c); $(`[data-periodo="${S.periodo}"]`).focus(); }
    };
    c.onsubmit = async (e) => {
      const form = e.target.closest('#form-abrir-caixa, #form-fechar-caixa');
      if (!form) return;
      e.preventDefault();
      if (form.id === 'form-abrir-caixa') {
        const valor = centavos(numBR($('#caixa-abertura').value) ?? 0);
        if (!(valor >= 0)) return toast('Informe o troco inicial (pode ser 0).', false);
        const ok = await seguro(() => Api.abrirCaixa(dia, valor, $('#caixa-observacao').value.trim()));
        if (ok) { toast('Caixa aberto.'); refazer(); }
      } else {
        const txt = $('#caixa-contado').value;
        if (txt.trim() === '') { $('#caixa-contado').focus(); return toast('Informe quanto dinheiro foi contado na gaveta.', false); }
        const valor = centavos(numBR(txt));
        if (!(valor >= 0)) return toast('Informe um valor válido.', false);
        const dif = centavos(valor - Number(caixaDia.valor_esperado || 0));
        if (dif !== 0 && !(await confirma([`O valor contado (${A.fmtBRL(valor)}) é diferente do esperado (${A.fmtBRL(caixaDia.valor_esperado)}).`, dif < 0 ? `Faltam ${A.fmtBRL(-dif)}. Deseja fechar mesmo assim?` : `Sobram ${A.fmtBRL(dif)}. Deseja fechar mesmo assim?`], 'Fechar caixa', false))) return;
        const r = await seguro(() => Api.fecharCaixa(dia, valor));
        if (r) { toast(Number(r.diferenca) === 0 ? 'Caixa fechado. Bateu certinho!' : 'Caixa fechado com diferença registrada.'); refazer(); }
      }
    };
  }

  /* ================================================================= Clientes */
  async function vClientes(c) {
    const r = await Api.clientes();
    const clientes = r.clientes || [];
    const semana = r.semana || [];
    const abertos = new Set((r.abertos || []).map(Number));
    const comVisita = clientes.filter((x) => x.visitas > 0);
    const fiel = comVisita.slice().sort((a, b) => b.visitas - a.visitas || b.total_gasto - a.total_gasto)[0];
    const maiorValor = comVisita.slice().sort((a, b) => b.total_gasto - a.total_gasto)[0];
    const recorrentes = clientes.filter((x) => x.visitas >= 2).length;
    const ordemSemana = [1, 2, 3, 4, 5, 6, 0].map((d) => semana.find((s) => s.dia === d) || { dia: d, agendamentos: 0 });
    const maxSemana = Math.max(0, ...ordemSemana.map((s) => s.agendamentos));
    const abertosMov = ordemSemana.filter((s) => abertos.has(s.dia));
    const maxAberto = Math.max(0, ...abertosMov.map((s) => s.agendamentos));
    const minAberto = Math.min(...abertosMov.map((s) => s.agendamentos));
    const temDiferenca = maxAberto > 0 && minAberto < maxAberto;
    const nomesDias = (v) => {
      const l = abertosMov.filter((s) => s.agendamentos === v).map((s) => A.DIAS[s.dia]);
      return l.length > 1 ? l.slice(0, -1).join(', ') + ' e ' + l[l.length - 1] : l[0];
    };

    c.innerHTML = `<div class="pg-topo"><div><h1>Clientes</h1><p>Quem mais frequenta, quanto cada cliente já movimentou e os dias de maior procura.</p></div>
        <div class="pg-acoes"><button type="button" class="btn btn--solid" data-novo-cli><i data-icon="plus"></i>Novo cliente</button></div></div>
      <div class="kpis">
        ${kpi('Clientes', clientes.length, comVisita.length ? `${comVisita.length} já atendidos` : '')}
        ${kpi('Voltaram 2+ vezes', recorrentes, comVisita.length ? Math.round((recorrentes / comVisita.length) * 100) + '% dos atendidos' : '')}
        ${kpi('Mais fiel', fiel ? esc(fiel.nome.split(' ')[0]) : '—', fiel ? plural(fiel.visitas, 'visita', 'visitas') : '', 'kpi--texto')}
        ${kpi('Maior valor', maiorValor ? esc(maiorValor.nome.split(' ')[0]) : '—', maiorValor ? A.fmtBRL(maiorValor.total_gasto) : '', 'kpi--texto')}
      </div>
      <div class="cartao cartao__pad"><div class="cartao__cab cartao__cab--sem-borda"><h2>Movimento por dia da semana</h2>
          ${temDiferenca ? `<p>Mais cheio: <b>${nomesDias(maxAberto)}</b> · Mais vazio: <b>${nomesDias(minAberto)}</b></p>` : ''}</div>
        ${maxSemana ? `<div class="colunas" role="img" aria-label="Atendimentos por dia da semana: ${ordemSemana.map((s) => `${A.DIAS[s.dia]} ${s.agendamentos}`).join(', ')}">${ordemSemana.map((s) => {
          const cls = !abertos.has(s.dia) ? ' fechado' : temDiferenca && s.agendamentos === maxAberto ? ' top' : temDiferenca && s.agendamentos === minAberto ? ' baixo' : '';
          return `<div class="coluna${cls}"><b>${abertos.has(s.dia) || s.agendamentos ? s.agendamentos : ''}</b><span class="coluna__barra" style="height:${s.agendamentos ? Math.max(4, Math.round((s.agendamentos / maxSemana) * 100)) : 0}%"></span><small>${A.DIAS_CURTOS[s.dia]}</small></div>`;
        }).join('')}</div>` : vazio('chart', 'Ainda não há atendimentos realizados', 'O gráfico aparece depois dos primeiros atendimentos.')}</div>
      <div class="cartao" id="cli-sumidos"></div>
      <div class="cartao"><div class="cartao__cab"><h2>Todos os clientes</h2>
          <div class="ferramentas"><label class="busca">${BJIcons.svg('search')}<input type="search" id="cli-busca" placeholder="Buscar por nome ou telefone" value="${esc(S.buscaCli)}" aria-label="Buscar cliente"></label>
            <select id="cli-ordem" aria-label="Ordenar por">${[['visitas', 'Mais visitas'], ['gasto', 'Maior valor'], ['recente', 'Visita mais recente'], ['nome', 'Nome (A–Z)']].map(([k, v]) => `<option value="${k}" ${S.ordemCli === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div></div>
        <div id="cli-lista"></div></div>`;

    /** Já vieram, não têm horário marcado e não aparecem há mais de S.diasSumido dias. Os mais frequentes primeiro. */
    const diasDesde = (iso) => Math.round((Date.parse(hojeIso() + 'T12:00:00Z') - Date.parse(iso + 'T12:00:00Z')) / 864e5);
    const linkAgendar = new URL('agendamento.html', location.href).href;
    const sumidos = () => {
      const lista = clientes
        .filter((x) => x.visitas > 0 && !x.proxima_visita && x.ultima_visita && diasDesde(x.ultima_visita) > S.diasSumido)
        .sort((a, b) => b.visitas - a.visitas || b.total_gasto - a.total_gasto);
      const vis = S.todosSumidos ? lista : lista.slice(0, 8);
      const msg = (x) => `Olá, ${x.nome.split(' ')[0]}! Aqui é da ${D.config.nome || 'Barbearia do Juan'}. Faz um tempinho que você não aparece, sentimos sua falta! Que tal marcar um horário? ${linkAgendar}`;
      $('#cli-sumidos').innerHTML = `<div class="cartao__cab"><div><h2>Clientes sumidos</h2>
          <p>${lista.length ? `${plural(lista.length, 'cliente', 'clientes')} sem vir há mais de ${S.diasSumido} dias e sem horário marcado` : `Ninguém sumido há mais de ${S.diasSumido} dias`}</p></div>
          <div class="seg" role="tablist" aria-label="Sem vir há mais de">${[30, 45, 60].map((n) => `<button type="button" role="tab" aria-selected="${n === S.diasSumido}" data-sumido="${n}">${n} dias</button>`).join('')}</div></div>
        ${lista.length ? `<ul class="sumidos">${vis.map((x) => `<li>
            <span class="avatar avatar--sm">${esc(iniciais(x.nome))}</span>
            <span class="sumidos__txt"><b>${esc(x.nome)}</b><small>Última visita há ${diasDesde(x.ultima_visita)} dias · ${plural(x.visitas, 'visita', 'visitas')} · ${A.fmtBRL(x.total_gasto)}</small></span>
            ${telValido(digitos(x.whatsapp)) ? `<a class="btn btn--sm btn--sec" href="${esc(waCliente(x.whatsapp))}?text=${encodeURIComponent(msg(x))}" target="_blank" rel="noopener">${BJIcons.svg('whatsapp')}Chamar</a>` : '<span class="sumidos__sem">Sem telefone</span>'}</li>`).join('')}</ul>
          ${lista.length > vis.length ? `<div class="mais"><button type="button" class="btn btn--sm btn--sec" data-todos-sumidos>Mostrar todos (${lista.length})</button></div>` : ''}`
          : `<p class="vendas-vazio">Bom sinal: todos os clientes atendidos voltaram ou já têm horário marcado.</p>`}`;
    };
    sumidos();

    const lista = () => {
      const q = S.buscaCli.trim().toLowerCase();
      const qd = digitos(q);
      const ordem = {
        visitas: (a, b) => b.visitas - a.visitas || b.total_gasto - a.total_gasto,
        gasto: (a, b) => b.total_gasto - a.total_gasto,
        recente: (a, b) => String(b.ultima_visita || '').localeCompare(String(a.ultima_visita || '')),
        nome: (a, b) => a.nome.localeCompare(b.nome, 'pt-BR'),
      }[S.ordemCli];
      const filtrados = clientes.filter((x) => !q || x.nome.toLowerCase().includes(q) || (qd && digitos(x.whatsapp).includes(qd))).sort(ordem);
      const vis = filtrados.slice(0, S.limiteCli);
      $('#cli-lista').innerHTML = filtrados.length ? `<div class="tabela" role="table" aria-label="Clientes">
          <div class="tabela__cab" role="row"><span role="columnheader">Cliente</span><span role="columnheader">Visitas</span><span role="columnheader">Total</span><span role="columnheader">Última visita</span><span role="columnheader">Próxima</span><span role="columnheader"><span class="sr-only">WhatsApp</span></span></div>
          ${vis.map((x) => `<div class="tabela__linha" role="row">
            <span class="cli" role="cell"><span class="avatar avatar--sm">${esc(iniciais(x.nome))}</span><span><b>${esc(x.nome)}</b><small>${x.whatsapp ? esc(fmtTel(x.whatsapp)) : 'Sem telefone'}</small></span></span>
            <span role="cell" data-rot="Visitas">${x.visitas}${x.visitas >= 5 ? ' <span class="pill pill--ok">Fiel</span>' : ''}${x.faltas ? ` <span class="pill pill--warn" title="Marcou e não veio">${plural(x.faltas, 'falta', 'faltas')}</span>` : ''}</span>
            <span role="cell" data-rot="Total">${A.fmtBRL(x.total_gasto)}</span>
            <span role="cell" data-rot="Última visita">${x.ultima_visita ? A.fmtData(x.ultima_visita) : '—'}</span>
            <span role="cell" data-rot="Próxima">${x.proxima_visita ? A.fmtData(x.proxima_visita) : '—'}</span>
            <span role="cell" class="tabela__acao"><button type="button" class="icone icone--editar" data-editar-cli="${x.id}" aria-label="Editar contato de ${esc(x.nome)}">${BJIcons.svg('edit')}</button>${telValido(digitos(x.whatsapp)) ? `<a class="icone" href="${esc(waCliente(x.whatsapp))}" target="_blank" rel="noopener" aria-label="WhatsApp de ${esc(x.nome)}">${BJIcons.svg('whatsapp')}</a>` : ''}</span>
          </div>`).join('')}</div>
          ${filtrados.length > vis.length ? `<div class="mais"><button type="button" class="btn btn--sm btn--sec" data-mais>Mostrar mais (${filtrados.length - vis.length})</button></div>` : ''}`
        : vazio('users', q ? 'Nenhum cliente encontrado' : 'Nenhum cliente ainda', q ? 'Tente outro nome ou telefone.' : 'Os clientes são cadastrados automaticamente ao agendar.');
    };
    lista();
    c.oninput = (e) => { if (e.target.id === 'cli-busca') { S.buscaCli = e.target.value; S.limiteCli = 30; lista(); } };
    c.onchange = (e) => { if (e.target.id === 'cli-ordem') { S.ordemCli = e.target.value; lista(); } };
    c.onclick = (e) => {
      if (e.target.closest('[data-mais]')) { S.limiteCli += 30; lista(); return; }
      const sm = e.target.closest('[data-sumido]');
      if (sm) { S.diasSumido = Number(sm.dataset.sumido); S.todosSumidos = false; sumidos(); $(`[data-sumido="${S.diasSumido}"]`).focus(); return; }
      if (e.target.closest('[data-todos-sumidos]')) { S.todosSumidos = true; sumidos(); return; }
      if (e.target.closest('[data-novo-cli]')) return formCliente(null, refazer);
      const ed = e.target.closest('[data-editar-cli]');
      if (ed) formCliente(clientes.find((x) => String(x.id) === ed.dataset.editarCli), refazer);
    };
  }

  /** Cria (cli = null) ou edita um contato. */
  function formCliente(cli, aoSalvar) {
    const novo = !cli;
    const atual = novo ? '' : digitos(cli.whatsapp);
    const foraDoPadrao = atual && !telValido(atual.length > 11 && atual.startsWith('55') ? atual.slice(2) : atual);
    abrirModal({
      titulo: novo ? 'Novo cliente' : 'Editar contato',
      corpo: `${novo ? '<p class="sub">Cadastre um cliente para encontrá-lo depois ao agendar pelo painel.</p>' : `<div class="det-cab"><span class="avatar">${esc(iniciais(cli.nome))}</span><div class="det-cab__txt"><strong>${esc(cli.nome)}</strong>
          <span>${plural(cli.visitas, 'visita', 'visitas')}${cli.faltas ? ' · ' + plural(cli.faltas, 'falta', 'faltas') : ''}${cli.ultima_visita ? ' · última em ' + A.fmtData(cli.ultima_visita) : ''}</span></div></div>`}
        <div class="campo"><label for="cli-nome">Nome</label><input id="cli-nome" maxlength="80" autocomplete="off" value="${esc(novo ? '' : cli.nome)}" placeholder="Nome e sobrenome" required></div>
        <div class="campo"><label for="cli-whats">WhatsApp <span class="opcional">opcional</span></label><input id="cli-whats" ${CAMPO_TEL} value="${esc(foraDoPadrao ? atual : BJ.tel(atual))}">
          ${foraDoPadrao ? `<small class="aviso-campo">O número salvo (${esc(atual)}) está fora do padrão. Confira e corrija.</small>` : '<small>DDD + número. Deixe vazio se o cliente não tiver.</small>'}</div>
        <div class="grade2"><div class="campo"><label for="cli-email">E-mail <span class="opcional">opcional</span></label><input id="cli-email" type="email" inputmode="email" maxlength="120" autocomplete="off" placeholder="nome@gmail.com" value="${esc(novo ? '' : cli.email || '')}"></div>
          <div class="campo"><label for="cli-aniv">Aniversário <span class="opcional">opcional</span></label><input id="cli-aniv" type="date" min="1900-01-01" max="${hojeIso()}" value="${esc(novo ? '' : cli.aniversario || '')}"></div></div>`,
      rodape: `<button type="button" class="btn" data-fechar>Cancelar</button><button type="submit" class="btn btn--solid">${novo ? 'Cadastrar cliente' : 'Salvar contato'}</button>`,
      aberto() { const i = $(novo ? '#cli-nome' : '#cli-whats'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); },
      async enviar() {
        const nome = BJ.nome($('#cli-nome').value);
        const whatsapp = digitos($('#cli-whats').value);
        if (!nome) { $('#cli-nome').focus(); return toast('Informe o nome do cliente.', false); }
        if (whatsapp && !telValido(whatsapp)) { $('#cli-whats').focus(); return toast('WhatsApp incompleto: use DDD + número, ex.: (11)98765-4321.', false); }
        const email = $('#cli-email').value.trim();
        if (email && !$('#cli-email').checkValidity()) { $('#cli-email').focus(); return toast('E-mail inválido. Ex.: nome@gmail.com', false); }
        const aniversario = $('#cli-aniv').value;
        if (aniversario && aniversario > hojeIso()) { $('#cli-aniv').focus(); return toast('A data de aniversário não pode estar no futuro.', false); }
        const ok = await seguro(() => Api.salvarCliente(novo ? null : cli.id, { nome, whatsapp, email, aniversario }).then(() => true));
        if (ok) { fecharModal(); toast(novo ? `${nome} cadastrado.` : 'Contato atualizado.'); aoSalvar(); }
      },
    });
  }

  /* ============================================================ Serviços */
  const COLS_SERVICO = ['id', 'nome', 'descricao', 'duracao_min', 'preco', 'foto', 'ordem', 'ativo'];
  async function vServicos(c) {
    c.innerHTML = `<div class="pg-topo"><div><h1>Serviços</h1><p>Nome, duração, preço e foto de cada serviço. Preço vazio aparece como “Sob consulta”.</p></div><button class="btn btn--solid" data-novo><i data-icon="plus"></i>Novo serviço</button></div>
      <div class="cartao">${D.servicos.length ? `<div class="lista">${D.servicos.map((s) => `
        <div class="item${s.ativo ? '' : ' inativo'}"><div class="item__foto">${BJ.src(s.foto) ? `<img src="${esc(BJ.src(s.foto))}" alt="">` : ''}</div>
          <div><div class="item__nome">${esc(s.nome)}${s.ativo ? '' : '<span class="tag">Inativo</span>'}</div><div class="item__meta">${s.duracao_min} min · ${esc(brl(s.preco))}</div></div>
          <div class="item__acoes"><label class="chave" title="Ativo"><input type="checkbox" data-ativo="${s.id}" ${s.ativo ? 'checked' : ''} aria-label="Ativo: ${esc(s.nome)}"><span></span></label>
            <button class="icone" data-edit="${s.id}" aria-label="Editar ${esc(s.nome)}"><i data-icon="edit"></i></button>
            <button class="icone perigo" data-del="${s.id}" aria-label="Excluir ${esc(s.nome)}"><i data-icon="trash"></i></button></div></div>`).join('')}</div>` : '<p class="vazio">Nenhum serviço cadastrado.</p>'}</div>`;
    c.onclick = (e) => {
      if (e.target.closest('[data-novo]')) return formServico(null);
      const ed = e.target.closest('[data-edit]'); if (ed) return formServico(D.servicos.find((s) => s.id === Number(ed.dataset.edit)));
      const del = e.target.closest('[data-del]');
      if (del) excluirServico(D.servicos.find((s) => s.id === Number(del.dataset.del)));
    };
    c.onchange = async (e) => {
      const t = e.target.closest('[data-ativo]'); if (!t) return;
      const s = D.servicos.find((x) => x.id === Number(t.dataset.ativo));
      const ok = await seguro(() => Api.salvar('servicos', { ...pick(s, COLS_SERVICO), ativo: t.checked }).then(() => true), 'Não foi possível alterar.');
      if (ok) { await recarregar(); toast(t.checked ? 'Serviço ativado.' : 'Serviço desativado.'); }
      refazer();
    };
  }
  async function excluirServico(s) {
    if (!(await confirma(`Excluir o serviço “${s.nome}”? Agendamentos antigos continuam com o nome guardado. Se preferir, apenas desative.`, 'Excluir'))) return;
    const ok = await seguro(() => Api.excluir('servicos', s.id).then(() => true), 'Não foi possível excluir.');
    if (ok) { await recarregar(); toast('Serviço excluído.'); refazer(); }
  }
  function formServico(s) {
    let foto = s ? s.foto : '';
    abrirModal({
      titulo: s ? 'Editar serviço' : 'Novo serviço',
      corpo: `<div class="campo"><label for="f-nome">Nome</label><input id="f-nome" value="${esc(s ? s.nome : '')}" maxlength="60" required></div>
        <div class="grade2"><div class="campo"><label for="f-dur">Duração (minutos)</label><input id="f-dur" type="number" min="5" max="600" step="5" value="${s ? s.duracao_min : 30}" required></div>
        <div class="campo"><label for="f-preco">Preço</label><div class="campo-moeda"><span>R$</span><input id="f-preco" inputmode="decimal" placeholder="Sob consulta" value="${esc(s ? fmtNum(s.preco) : '')}"></div><small>Deixe vazio para “sob consulta”.</small></div></div>
        <div class="campo"><label for="f-desc">Descrição (opcional)</label><textarea id="f-desc" maxlength="300">${esc(s ? s.descricao : '')}</textarea></div>
        ${uploadHtml('f-foto', foto, { rotulo: 'Foto' })}
        <div class="grade2"><div class="campo"><label for="f-ordem">Ordem de exibição</label><input id="f-ordem" type="number" value="${s ? s.ordem : (D.servicos.reduce((m, x) => Math.max(m, x.ordem || 0), 0) + 1)}"></div>
        <div class="campo"><span class="rotulo">Ativo</span><label class="chave" style="margin-top:6px"><input type="checkbox" id="f-ativo" ${!s || s.ativo ? 'checked' : ''} aria-label="Ativo"><span></span></label></div></div>`,
      rodape: '<button type="button" class="btn" data-fechar>Cancelar</button><button type="submit" class="btn btn--solid">Salvar</button>',
      aberto() { ligarUpload('f-foto', { max: 800 }, (u) => { foto = u; }); },
      async enviar() {
        const nome = $('#f-nome').value.trim(), dur = Number($('#f-dur').value), preco = numBR($('#f-preco').value);
        if (!nome) return toast('Informe o nome do serviço.', false);
        if (!(dur >= 5 && dur <= 600)) return toast('A duração deve ficar entre 5 e 600 minutos.', false);
        if (preco !== null && !(preco >= 0)) return toast('Preço inválido.', false);
        const linha = { ...(s ? { id: s.id } : {}), nome, descricao: $('#f-desc').value.trim(), duracao_min: Math.round(dur), preco, foto, ordem: Number($('#f-ordem').value) || 0, ativo: $('#f-ativo').checked };
        const ok = await seguro(() => Api.salvar('servicos', linha).then(() => true), 'Não foi possível salvar.');
        if (ok) { fecharModal(); await recarregar(); toast('Serviço salvo.'); refazer(); }
      },
    });
  }

  /* ============================================================ Produtos */
  const COLS_PRODUTO = ['id', 'nome', 'descricao', 'preco', 'estoque_minimo', 'ativo'];
  async function vProdutos(c) {
    const produtos = D.produtos || [];
    const baixos = produtos.filter((p) => p.ativo && p.estoque <= p.estoque_minimo).length;
    const estoqueTag = (p) => (p.estoque === 0 ? pill(['Sem estoque', 'err']) : p.estoque <= p.estoque_minimo ? pill(['Estoque baixo', 'warn']) : '');
    c.innerHTML = `<div class="pg-topo"><div><h1>Produtos</h1><p>Itens vendidos no balcão. Venda junto com o atendimento pelo detalhe do agendamento, ou sozinha em Venda avulsa. O estoque baixa automaticamente.</p></div>
        <div class="pg-acoes"><button type="button" class="btn btn--sec" data-venda-avulsa><i data-icon="box"></i>Venda avulsa</button><button type="button" class="btn btn--solid" data-produto-novo><i data-icon="plus"></i>Novo produto</button></div></div>
      ${baixos ? `<div class="aviso-barra aviso-barra--alerta">${BJIcons.svg('alert')}<span><b>${plural(baixos, 'produto está', 'produtos estão')} com estoque baixo.</b> Registre a reposição para continuar vendendo.</span></div>` : ''}
      <div class="cartao">${produtos.length ? `<div class="lista">${produtos.map((p) => `
        <div class="item${p.ativo ? '' : ' inativo'}"><div class="item__foto item__foto--ic"><i data-icon="box"></i></div>
          <div><div class="item__nome">${esc(p.nome)}${estoqueTag(p)}${p.ativo ? '' : '<span class="tag">Inativo</span>'}</div>
            <div class="item__meta">${A.fmtBRL(p.preco)} · ${plural(p.estoque, 'unidade', 'unidades')} · mínimo ${p.estoque_minimo}</div></div>
          <div class="item__acoes"><label class="chave" title="Disponível para venda"><input type="checkbox" data-produto-ativo="${p.id}" ${p.ativo ? 'checked' : ''} aria-label="Disponível para venda: ${esc(p.nome)}"><span></span></label>
            <button type="button" class="btn btn--sm btn--sec" data-estoque="${p.id}">Estoque</button>
            <button type="button" class="icone" data-produto-editar="${p.id}" aria-label="Editar ${esc(p.nome)}"><i data-icon="edit"></i></button>
            <button type="button" class="icone perigo" data-produto-excluir="${p.id}" aria-label="Excluir ${esc(p.nome)}"><i data-icon="trash"></i></button></div>
        </div>`).join('')}</div>` : vazio('box', 'Nenhum produto cadastrado', 'Cadastre pomadas, óleos e outros itens para vender junto com o atendimento.', '<button type="button" class="btn btn--sm btn--sec" data-produto-novo>Cadastrar produto</button>')}</div>`;
    c.onclick = async (e) => {
      if (e.target.closest('[data-venda-avulsa]')) return formVendaAvulsa(() => refazer());
      if (e.target.closest('[data-produto-novo]')) return formProduto(null);
      const ed = e.target.closest('[data-produto-editar]');
      if (ed) return formProduto(produtos.find((p) => p.id === Number(ed.dataset.produtoEditar)));
      const mov = e.target.closest('[data-estoque]');
      if (mov) return formMovimentoEstoque(produtos.find((p) => p.id === Number(mov.dataset.estoque)));
      const del = e.target.closest('[data-produto-excluir]');
      if (del) {
        const p = produtos.find((x) => x.id === Number(del.dataset.produtoExcluir));
        if (!(await confirma([`Excluir o produto “${p.nome}”?`, 'Se ele já teve vendas ou movimentações, não poderá ser excluído; nesse caso, desative-o.'], 'Excluir'))) return;
        if (await seguro(() => Api.excluir('produtos', p.id).then(() => true))) { await recarregar(); toast('Produto excluído.'); refazer(); }
      }
    };
    c.onchange = async (e) => {
      const toggle = e.target.closest('[data-produto-ativo]');
      if (!toggle) return;
      const produto = produtos.find((p) => p.id === Number(toggle.dataset.produtoAtivo));
      const ok = await seguro(() => Api.salvar('produtos', { ...pick(produto, COLS_PRODUTO), ativo: toggle.checked }).then(() => true), 'Não foi possível alterar o produto.');
      if (ok) { await recarregar(); toast(toggle.checked ? 'Produto ativado.' : 'Produto desativado.'); }
      refazer();
    };
  }
  function formProduto(produto) {
    abrirModal({
      titulo: produto ? 'Editar produto' : 'Novo produto',
      corpo: `<div class="campo"><label for="p-nome">Nome</label><input id="p-nome" maxlength="80" value="${esc(produto ? produto.nome : '')}" required></div>
        <div class="campo"><label for="p-desc">Descrição</label><textarea id="p-desc" maxlength="240">${esc(produto ? produto.descricao : '')}</textarea></div>
        <div class="grade2"><div class="campo"><label for="p-preco">Preço de venda</label><div class="campo-moeda"><span>R$</span><input id="p-preco" inputmode="decimal" placeholder="0,00" value="${esc(produto ? fmtNum(produto.preco) : '')}" required></div></div>
        <div class="campo"><label for="p-min">Estoque mínimo</label><input id="p-min" type="number" min="0" step="1" value="${produto ? produto.estoque_minimo : 0}" required></div></div>
        ${produto ? `<div class="mini-box">Estoque atual: <strong>${produto.estoque} unidades</strong>. Use “Movimentar estoque” para registrar reposições ou saídas.</div>` : '<div class="campo"><label for="p-estoque">Estoque inicial</label><input id="p-estoque" type="number" min="0" step="1" value="0" required></div>'}
        <div class="campo"><span class="rotulo">Ativo para venda</span><label class="chave"><input type="checkbox" id="p-ativo" ${!produto || produto.ativo ? 'checked' : ''} aria-label="Ativo para venda"><span></span></label></div>`,
      rodape: '<button type="button" class="btn" data-fechar>Voltar</button><button type="submit" class="btn btn--solid">Salvar produto</button>',
      async enviar() {
        const nome = $('#p-nome').value.trim();
        const preco = numBR($('#p-preco').value);
        const estoqueMinimo = Number($('#p-min').value);
        const estoque = produto ? undefined : Number($('#p-estoque').value);
        if (!nome || preco === null || !Number.isFinite(preco) || preco < 0) return toast('Informe o nome e um preço válido.', false);
        if (!Number.isInteger(estoqueMinimo) || estoqueMinimo < 0 || (!produto && (!Number.isInteger(estoque) || estoque < 0))) return toast('Estoque deve ser um número inteiro não negativo.', false);
        const linha = { ...(produto ? { id: produto.id } : { estoque }), nome, descricao: $('#p-desc').value.trim(), preco, estoque_minimo: estoqueMinimo, ativo: $('#p-ativo').checked };
        const ok = await seguro(() => Api.salvar('produtos', linha).then(() => true), 'Não foi possível salvar o produto.');
        if (ok) { fecharModal(); await recarregar(); toast('Produto salvo.'); refazer(); }
      },
    });
  }
  function formMovimentoEstoque(produto) {
    abrirModal({
      titulo: 'Movimentar estoque',
      corpo: `<p class="sub">${esc(produto.nome)} · estoque atual: <strong>${produto.estoque}</strong></p>
        <div class="campo"><label for="m-tipo">Movimento</label><select id="m-tipo"><option value="entrada">Entrada</option><option value="ajuste">Saída</option></select></div>
        <div class="campo"><label for="m-qtd">Quantidade de unidades</label><input id="m-qtd" type="number" min="1" step="1" value="1" required></div>
        <div class="campo"><label for="m-motivo">Observação</label><input id="m-motivo" maxlength="120" placeholder="Ex.: compra de reposição"></div>
        <div class="campo"><span class="rotulo">Movimentações recentes</span><div class="mini-box" id="m-historico">Carregando histórico...</div></div>`,
      rodape: '<button type="button" class="btn" data-fechar>Voltar</button><button type="submit" class="btn btn--solid">Registrar movimento</button>',
      aberto() {
        seguro(async () => {
          const movimentos = await Api.movimentosEstoque(produto.id);
          const labels = { entrada: 'Entrada', ajuste: 'Saída', venda: 'Venda' };
          const html = movimentos.length ? movimentos.map((m) => `<div class="det__pagamento"><span>${esc(labels[m.tipo] || m.tipo)}${m.agendamento_codigo ? ` · ${esc(m.agendamento_codigo)}` : ''}<small style="display:block;color:var(--muted)">${esc(m.motivo)} · ${new Date(m.criado_em.replace(' ', 'T')).toLocaleString('pt-BR')}</small></span><strong>${m.quantidade > 0 ? '+' : ''}${m.quantidade} un.</strong></div>`).join('') : 'Nenhum movimento registrado.';
          const host = $('#m-historico');
          if (host) host.innerHTML = html;
        }, 'Não foi possível carregar o histórico.');
      },
      async enviar() {
        const quantidade = Number($('#m-qtd').value);
        if (!Number.isInteger(quantidade) || quantidade < 1) return toast('Informe uma quantidade inteira maior que zero.', false);
        const ok = await seguro(() => Api.movimentarEstoque(produto.id, quantidade, $('#m-tipo').value, $('#m-motivo').value.trim()).then(() => true), 'Não foi possível atualizar o estoque.');
        if (ok) { fecharModal(); await recarregar(); toast('Movimento de estoque registrado.'); refazer(); }
      },
    });
  }

  /* ============================================================== Combos */
  const COLS_COMBO = ['id', 'nome', 'descricao', 'preco', 'duracao_min', 'foto', 'ordem', 'ativo'];
  async function vCombos(c) {
    const nomes = (ids) => ids.map((i) => (D.servicos.find((s) => s.id === i) || {}).nome).filter(Boolean).join(' + ');
    c.innerHTML = `<div class="pg-topo"><div><h1>Combos</h1><p>Quando o cliente marca todos os serviços de um combo, o preço do combo substitui a soma dos serviços.</p></div><button class="btn btn--solid" data-novo><i data-icon="plus"></i>Novo combo</button></div>
      <div class="cartao">${D.combos.length ? `<div class="lista">${D.combos.map((b) => `
        <div class="item${b.ativo ? '' : ' inativo'}"><div class="item__foto">${BJ.src(b.foto) ? `<img src="${esc(BJ.src(b.foto))}" alt="">` : ''}</div>
          <div><div class="item__nome">${esc(b.nome)}${b.ativo ? '' : '<span class="tag">Inativo</span>'}</div><div class="item__meta">${esc(nomes(b.servico_ids))} · ${b.duracao_min != null ? b.duracao_min + ' min' : 'duração = soma'} · ${A.fmtBRL(b.preco)}</div></div>
          <div class="item__acoes"><label class="chave"><input type="checkbox" data-ativo="${b.id}" ${b.ativo ? 'checked' : ''} aria-label="Ativo: ${esc(b.nome)}"><span></span></label>
            <button class="icone" data-edit="${b.id}" aria-label="Editar ${esc(b.nome)}"><i data-icon="edit"></i></button>
            <button class="icone perigo" data-del="${b.id}" aria-label="Excluir ${esc(b.nome)}"><i data-icon="trash"></i></button></div></div>`).join('')}</div>` : '<p class="vazio">Nenhum combo cadastrado.</p>'}</div>`;
    c.onclick = (e) => {
      if (e.target.closest('[data-novo]')) return formCombo(null);
      const ed = e.target.closest('[data-edit]'); if (ed) return formCombo(D.combos.find((x) => x.id === Number(ed.dataset.edit)));
      const del = e.target.closest('[data-del]');
      if (del) (async () => {
        const b = D.combos.find((x) => x.id === Number(del.dataset.del));
        if (!(await confirma(`Excluir o combo “${b.nome}”?`, 'Excluir'))) return;
        if (await seguro(() => Api.excluir('combos', b.id).then(() => true), 'Não foi possível excluir.')) { await recarregar(); toast('Combo excluído.'); refazer(); }
      })();
    };
    c.onchange = async (e) => {
      const t = e.target.closest('[data-ativo]'); if (!t) return;
      const b = D.combos.find((x) => x.id === Number(t.dataset.ativo));
      if (await seguro(() => Api.salvar('combos', { ...pick(b, COLS_COMBO), ativo: t.checked }).then(() => true), 'Não foi possível alterar.')) await recarregar();
      refazer();
    };
  }
  function formCombo(b) {
    let foto = b ? b.foto : '';
    abrirModal({
      titulo: b ? 'Editar combo' : 'Novo combo',
      corpo: `<div class="campo"><label for="c-nome">Nome</label><input id="c-nome" value="${esc(b ? b.nome : '')}" maxlength="60" placeholder="Ex.: Corte + Barba" required></div>
        <div class="campo"><span class="rotulo" id="c-srv-r">Serviços do combo (mínimo 2)</span><div class="checks" role="group" aria-labelledby="c-srv-r">${D.servicos.map((s) => `<label><input type="checkbox" name="c-srv" value="${s.id}" ${b && b.servico_ids.includes(s.id) ? 'checked' : ''}>${esc(s.nome)} <span style="color:var(--muted);margin-left:auto;font-size:12px">${s.duracao_min} min · ${esc(brl(s.preco))}</span></label>`).join('')}</div></div>
        <div class="grade2"><div class="campo"><label for="c-preco">Preço do combo</label><div class="campo-moeda"><span>R$</span><input id="c-preco" inputmode="decimal" placeholder="0,00" value="${esc(b ? fmtNum(b.preco) : '')}" required></div></div>
        <div class="campo"><label for="c-dur">Duração (minutos)</label><input id="c-dur" type="number" min="5" max="900" placeholder="vazio = soma" value="${b && b.duracao_min != null ? b.duracao_min : ''}"><small>Vazio = soma das durações.</small></div></div>
        <div class="campo"><label for="c-desc">Descrição</label><textarea id="c-desc" maxlength="300">${esc(b ? b.descricao : '')}</textarea></div>
        ${uploadHtml('c-foto', foto, { rotulo: 'Foto do combo' })}
        <div class="campo"><span class="rotulo">Ativo</span><label class="chave"><input type="checkbox" id="c-ativo" ${!b || b.ativo ? 'checked' : ''} aria-label="Ativo"><span></span></label></div>`,
      rodape: '<button type="button" class="btn" data-fechar>Cancelar</button><button type="submit" class="btn btn--solid">Salvar</button>',
      aberto() { ligarUpload('c-foto', { max: 800 }, (u) => { foto = u; }); },
      async enviar() {
        const nome = $('#c-nome').value.trim(), preco = numBR($('#c-preco').value), durTxt = $('#c-dur').value.trim();
        const ids = $$('input[name="c-srv"]:checked').map((i) => Number(i.value));
        if (!nome) return toast('Informe o nome do combo.', false);
        if (ids.length < 2) return toast('Escolha pelo menos 2 serviços.', false);
        if (preco === null || !(preco >= 0)) return toast('Informe o preço do combo.', false);
        const dur = durTxt === '' ? null : Math.round(Number(durTxt));
        if (dur !== null && !(dur >= 5)) return toast('Duração inválida.', false);
        const linha = { ...(b ? { id: b.id } : {}), nome, descricao: $('#c-desc').value.trim(), preco, duracao_min: dur, foto, ordem: b ? b.ordem : D.combos.length + 1, ativo: $('#c-ativo').checked };
        const ok = await seguro(async () => { const r = await Api.salvar('combos', linha); await Api.comboServicos(b ? b.id : r.id, ids); return true; }, 'Não foi possível salvar.');
        if (ok) { fecharModal(); await recarregar(); toast('Combo salvo.'); refazer(); }
      },
    });
  }

  /* ============================================================ Horários */
  const nomeDia = (d) => A.DIAS[d] + (d === 6 || d === 0 ? '' : '-feira');
  async function vHorarios(c) {
    const cfg = D.config;
    const h = (d) => D.horarios.find((x) => x.dia_semana === d) || { dia_semana: d, ativo: false, inicio_min: 480, fim_min: 1080 };
    c.innerHTML = `<div class="pg-topo"><div><h1>Horários</h1><p>Dias e horas de atendimento, almoço e regras de agendamento. As alterações valem para novos agendamentos.</p></div></div>
      <form id="form-horarios" novalidate>
      <div class="cartao cartao__pad"><h2>Horários de funcionamento</h2><div class="dias">${ordemDias.map((d) => { const x = h(d); return `
        <div class="dia-linha${x.ativo ? '' : ' fechado'}" data-d="${d}"><label class="chave"><input type="checkbox" class="h-ativo" ${x.ativo ? 'checked' : ''} aria-label="${A.DIAS[d]} aberto"><span></span></label>
          <span class="nome-dia">${A.DIAS[d]}</span>
          <input type="time" class="h-ini" value="${A.fmtMin(x.inicio_min)}" aria-label="${A.DIAS[d]}: abre às" ${x.ativo ? '' : 'disabled'}>
          <input type="time" class="h-fim" value="${A.fmtMin(x.fim_min)}" aria-label="${A.DIAS[d]}: fecha às" ${x.ativo ? '' : 'disabled'}></div>`; }).join('')}</div></div>
      <div class="cartao cartao__pad"><h2>Intervalo de almoço</h2><p class="sub">Nenhum cliente consegue agendar durante o almoço (vale para todos os dias).</p>
        <div class="grade3"><div class="campo"><span class="rotulo">Almoço ativo</span><label class="chave" style="margin-top:6px"><input type="checkbox" id="al-ativo" ${cfg.almoco_ativo === '1' ? 'checked' : ''} aria-label="Almoço ativo"><span></span></label></div>
        <div class="campo"><label for="al-ini">De</label><input type="time" id="al-ini" value="${esc(cfg.almoco_inicio || '12:00')}"></div>
        <div class="campo"><label for="al-fim">Até</label><input type="time" id="al-fim" value="${esc(cfg.almoco_fim || '13:00')}"></div></div></div>
      <div class="cartao cartao__pad"><h2>Regras de agendamento</h2>
        <div class="grade3"><div class="campo"><label for="r-passo">Intervalo entre horários</label><select id="r-passo">${[10, 15, 20, 30, 40, 45, 60].map((n) => `<option value="${n}" ${Number(cfg.passo_min || 20) === n ? 'selected' : ''}>${n} min</option>`).join('')}</select></div>
        <div class="campo"><label for="r-antec">Antecedência mínima (min)</label><input id="r-antec" type="number" min="0" max="1440" step="5" value="${esc(cfg.antecedencia_min || 0)}"></div>
        <div class="campo"><label for="r-dias">Agenda aberta por (dias)</label><input id="r-dias" type="number" min="1" max="365" value="${esc(cfg.dias_agenda || 60)}"></div></div></div>
      <div class="barra-salvar"><button class="btn btn--solid" type="submit">Salvar horários</button></div></form>`;
    c.onchange = (e) => {
      const t = e.target;
      if (t.classList.contains('h-ativo')) {
        const l = t.closest('.dia-linha'); l.classList.toggle('fechado', !t.checked);
        $$('input[type="time"]', l).forEach((i) => { i.disabled = !t.checked; });
      }
    };
    c.onsubmit = async (e) => {
      e.preventDefault();
      const linhas = $$('.dia-linha', c).map((l) => ({ dia_semana: Number(l.dataset.d), ativo: $('.h-ativo', l).checked, inicio_min: A.toMin($('.h-ini', l).value), fim_min: A.toMin($('.h-fim', l).value) }));
      for (const l of linhas) {
        if (isNaN(l.inicio_min) || isNaN(l.fim_min)) return toast(`Informe os horários de ${A.DIAS[l.dia_semana]}.`, false);
        if (l.ativo && l.fim_min <= l.inicio_min) return toast(`${A.DIAS[l.dia_semana]}: o horário final precisa ser depois do inicial.`, false);
        if (!l.ativo && l.fim_min <= l.inicio_min) { l.inicio_min = 480; l.fim_min = 1080; }
      }
      const ai = A.toMin($('#al-ini').value), af = A.toMin($('#al-fim').value);
      if ($('#al-ativo').checked && (isNaN(ai) || isNaN(af) || af <= ai)) return toast('Almoço: o horário final precisa ser depois do inicial.', false);
      const antec = Number($('#r-antec').value), dias = Number($('#r-dias').value);
      if (!(antec >= 0) || !(dias >= 1)) return toast('Confira as regras de agendamento.', false);
      const btn = $('button[type="submit"]', c); btn.disabled = true;
      const ok = await seguro(async () => {
        for (const l of linhas) await Api.salvar('horarios_funcionamento', l);
        await Api.salvarConfig({ almoco_ativo: $('#al-ativo').checked ? '1' : '0', almoco_inicio: $('#al-ini').value || '12:00', almoco_fim: $('#al-fim').value || '13:00', passo_min: $('#r-passo').value, antecedencia_min: String(antec), dias_agenda: String(dias) });
        return true;
      }, 'Não foi possível salvar.');
      btn.disabled = false;
      if (ok) { await recarregar(); toast('Horários salvos.'); }
    };
  }

  /* ========================================================== Bloqueios */
  async function vBloqueios(c) {
    const hoje = hojeIso();
    const lista = D.bloqueios.filter((b) => S.mostrarPassados || b.data >= hoje).sort((a, b) => a.data.localeCompare(b.data) || a.inicio_min - b.inicio_min);
    c.innerHTML = `<div class="pg-topo"><div><h1>Bloqueios</h1><p>Períodos em que ninguém pode agendar. Você pode criar vários no mesmo dia.</p></div></div>
      <form class="cartao cartao__pad" id="form-bloq" novalidate><h2>Novo bloqueio</h2>
        <div class="grade3"><div class="campo"><label for="b-data">Data</label><input type="date" id="b-data" min="${hoje}" value="${S.dia || hoje}" required></div>
          <div class="campo"><label for="b-ini">De</label><input type="time" id="b-ini" value="15:00"></div>
          <div class="campo"><label for="b-fim">Até</label><input type="time" id="b-fim" value="16:30"></div></div>
        <div class="campo"><label style="display:flex;align-items:center;gap:10px"><span class="chave"><input type="checkbox" id="b-dia"><span></span></span>Bloquear o dia inteiro</label></div>
        <div class="campo"><label for="b-motivo">Motivo (só você vê)</label><input id="b-motivo" maxlength="120" placeholder="Ex.: Compromisso pessoal"></div>
        <button class="btn btn--solid" type="submit">Bloquear período</button></form>
      <div class="cartao" style="margin-top:16px"><div class="cartao__pad" style="display:flex;justify-content:space-between;align-items:center;gap:12px;border-bottom:1px solid var(--line)"><h2 style="margin:0">Bloqueios ${S.mostrarPassados ? '' : 'futuros'}</h2>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted)"><span class="chave"><input type="checkbox" id="b-passados" ${S.mostrarPassados ? 'checked' : ''}><span></span></span>Mostrar passados</label></div>
        ${lista.length ? `<div class="lista">${lista.map((b) => `<div class="item" style="grid-template-columns:minmax(0,1fr) auto"><div><div class="item__nome">${A.fmtData(b.data)} · ${b.inicio_min === 0 && b.fim_min === 1440 ? 'Dia inteiro' : A.fmtMin(b.inicio_min) + ' às ' + A.fmtMin(b.fim_min)}</div><div class="item__meta">${esc(cap(dataLonga(b.data)))}${b.motivo ? ' · ' + esc(b.motivo) : ''}</div></div>
          <button class="icone perigo" data-del="${b.id}" aria-label="Remover bloqueio de ${A.fmtData(b.data)}"><i data-icon="trash"></i></button></div>`).join('')}</div>` : '<p class="vazio">Nenhum bloqueio.</p>'}</div>`;
    c.onchange = (e) => {
      if (e.target.id === 'b-dia') $$('#b-ini, #b-fim').forEach((i) => { i.disabled = e.target.checked; });
      if (e.target.id === 'b-passados') { S.mostrarPassados = e.target.checked; refazer(); }
    };
    c.onclick = async (e) => {
      const d = e.target.closest('[data-del]'); if (!d) return;
      const b = D.bloqueios.find((x) => x.id === Number(d.dataset.del));
      if (!(await confirma(`Remover o bloqueio de ${A.fmtData(b.data)}? O período volta a ficar disponível.`, 'Remover'))) return;
      if (await seguro(() => Api.excluir('bloqueios', b.id).then(() => true), 'Não foi possível remover.')) { await recarregar(); toast('Bloqueio removido.'); refazer(); }
    };
    c.onsubmit = async (e) => {
      e.preventDefault();
      const data = $('#b-data').value, inteiro = $('#b-dia').checked;
      const ini = inteiro ? 0 : A.toMin($('#b-ini').value), fim = inteiro ? 1440 : A.toMin($('#b-fim').value);
      if (!data) return toast('Escolha a data.', false);
      if (isNaN(ini) || isNaN(fim) || fim <= ini) return toast('O horário final precisa ser depois do inicial.', false);
      const ok = await seguro(async () => {
        await Api.salvar('bloqueios', { data, inicio_min: ini, fim_min: fim, motivo: $('#b-motivo').value.trim() });
        const ags = (await Api.agendamentos(data, data)).filter((a) => a.status === 'confirmado' && a.inicio_min < fim && ini < a.fim_min);
        return { conflitos: ags.length };
      }, 'Não foi possível bloquear.');
      if (!ok) return;
      await recarregar();
      toast(ok.conflitos ? `Período bloqueado. Atenção: já existe(m) ${ok.conflitos} agendamento(s) nesse horário — cancele em Agendamentos, se necessário.` : 'Período bloqueado.', !ok.conflitos);
      refazer();
    };
  }

  /* ============================================================= Galeria */
  async function vGaleria(c) {
    c.innerHTML = `<div class="pg-topo"><div><h1>Galeria</h1><p>Fotos exibidas na página inicial. Desative para esconder sem apagar.</p></div>
      <label class="btn btn--solid" style="cursor:pointer"><i data-icon="plus"></i>Adicionar fotos<input type="file" id="g-novas" accept="image/*" multiple hidden></label></div>
      ${D.galeria.length ? `<div class="g-grid">${D.galeria.map((g) => `<div class="g-card${g.ativo ? '' : ' inativo'}"><img src="${esc(BJ.src(g.foto))}" alt="Foto da galeria ${g.id}" loading="lazy">
        <div class="g-card__acoes"><label class="chave"><input type="checkbox" data-ativo="${g.id}" ${g.ativo ? 'checked' : ''} aria-label="Exibir foto ${g.id}"><span></span></label>
          <span style="display:flex;gap:6px"><label class="icone" title="Trocar foto" style="cursor:pointer"><i data-icon="edit"></i><input type="file" data-troca="${g.id}" accept="image/*" hidden></label>
          <button class="icone perigo" data-del="${g.id}" aria-label="Remover foto ${g.id}"><i data-icon="trash"></i></button></span></div></div>`).join('')}</div>` : '<div class="cartao"><p class="vazio">Nenhuma foto. Adicione a primeira.</p></div>'}`;
    const linhaG = (g, extra) => ({ id: g.id, ...pick(g, ['foto', 'legenda', 'ordem', 'ativo']), ...extra });
    c.onclick = async (e) => {
      const d = e.target.closest('[data-del]'); if (!d) return;
      if (!(await confirma('Remover esta foto da galeria?', 'Remover'))) return;
      if (await seguro(() => Api.excluir('galeria', Number(d.dataset.del)).then(() => true), 'Não foi possível remover.')) { await recarregar(); toast('Foto removida.'); refazer(); }
    };
    c.onchange = async (e) => {
      const t = e.target;
      if (t.id === 'g-novas') {
        const arqs = [...t.files]; if (!arqs.length) return;
        toast('Enviando fotos…');
        let ordem = D.galeria.reduce((m, x) => Math.max(m, x.ordem || 0), 0);
        const ok = await seguro(async () => {
          for (const f of arqs) { const foto = await BJ.lerImagem(f, { max: 1100 }); await Api.salvar('galeria', { foto, legenda: '', ordem: ++ordem, ativo: true }); }
          return true;
        }, 'Não foi possível enviar.');
        if (ok) { await recarregar(); toast(arqs.length > 1 ? 'Fotos adicionadas.' : 'Foto adicionada.'); refazer(); }
      } else if (t.dataset.ativo) {
        const g = D.galeria.find((x) => x.id === Number(t.dataset.ativo));
        if (await seguro(() => Api.salvar('galeria', linhaG(g, { ativo: t.checked })).then(() => true), 'Não foi possível alterar.')) await recarregar();
        refazer();
      } else if (t.dataset.troca) {
        const g = D.galeria.find((x) => x.id === Number(t.dataset.troca));
        const ok = await seguro(async () => { const foto = await BJ.lerImagem(t.files[0], { max: 1100 }); await Api.salvar('galeria', linhaG(g, { foto })); return true; }, 'Não foi possível trocar.');
        if (ok) { await recarregar(); toast('Foto trocada.'); refazer(); }
      }
    };
  }

  /* ========================================================= Configurações */
  async function vConfig(c) {
    const g = D.config;
    const v = (k) => esc(g[k] || '');
    const novas = {};
    c.innerHTML = `<div class="pg-topo"><div><h1>Configurações</h1><p>Dados exibidos no site. Ao salvar, a página inicial é atualizada.</p></div></div>
      <form id="form-config" novalidate>
      <div class="cartao cartao__pad"><h2>Barbearia</h2>
        <div class="grade2"><div class="campo"><label for="k-nome">Nome da barbearia</label><input id="k-nome" value="${v('nome')}" maxlength="60"></div>
          <div class="campo"><label for="k-slogan">Slogan</label><input id="k-slogan" value="${v('slogan')}" maxlength="80"></div></div>
        <div class="grade2"><div class="campo"><label for="k-desde">Atuando desde (ano)</label><input id="k-desde" type="number" min="1950" max="2100" value="${v('desde')}"></div>
          <div class="campo"><label for="k-sub">Subtítulo da seção Serviços</label><input id="k-sub" value="${v('servicos_subtitulo')}" maxlength="100"></div></div>
        <div class="campo"><label for="k-hero">Texto de apresentação (início)</label><textarea id="k-hero" maxlength="240">${v('hero_texto')}</textarea></div>
        <div class="campo"><label for="k-st">Título da seção Sobre</label><input id="k-st" value="${v('sobre_titulo')}" maxlength="100"></div>
        <div class="campo"><label for="k-sx">Texto da seção Sobre</label><textarea id="k-sx" maxlength="500">${v('sobre_texto')}</textarea></div></div>
      <div class="cartao cartao__pad"><h2>Contato</h2>
        <div class="grade2"><div class="campo"><label for="k-tel">Telefone (exibido no site)</label><input id="k-tel" ${CAMPO_TEL} value="${esc(BJ.tel(g.telefone))}"></div>
          <div class="campo"><label for="k-wa">WhatsApp da barbearia</label><input id="k-wa" ${CAMPO_TEL} value="${esc(BJ.tel(g.whatsapp))}"><small>DDD + número. O código do Brasil (55) é incluído automaticamente.</small></div></div>
        <div class="campo"><label for="k-end">Endereço</label><input id="k-end" value="${v('endereco')}" maxlength="120"></div>
        <div class="grade2"><div class="campo"><label for="k-ig">Instagram</label><input id="k-ig" value="${v('instagram')}" placeholder="@barbeariadojuan_"></div>
          <div class="campo"><label for="k-igu">Link do Instagram</label><input id="k-igu" type="url" value="${v('instagram_url')}" placeholder="https://www.instagram.com/…"></div></div>
        <div class="campo"><label for="k-wam">Mensagem padrão do botão de WhatsApp</label><input id="k-wam" value="${v('whatsapp_msg')}" maxlength="200"></div></div>
      <div class="cartao cartao__pad"><h2>Imagens</h2>
        ${uploadHtml('k-logo', g.logo, { logo: true, rotulo: 'Logo (PNG com fundo transparente)' })}
        ${uploadHtml('k-hf', g.hero_foto, { rotulo: 'Foto principal (início)' })}
        ${uploadHtml('k-sf', g.sobre_foto, { rotulo: 'Foto da seção Sobre' })}</div>
      <div class="barra-salvar"><button class="btn btn--solid" type="submit">Salvar configurações</button></div></form>`;
    ligarUpload('k-logo', { max: 900, png: true }, (u) => { novas.logo = u; });
    ligarUpload('k-hf', { max: 1600 }, (u) => { novas.hero_foto = u; });
    ligarUpload('k-sf', { max: 1200 }, (u) => { novas.sobre_foto = u; });
    c.onsubmit = async (e) => {
      e.preventDefault();
      const waLocal = digitos($('#k-wa').value);
      if (!telValido(waLocal)) { $('#k-wa').focus(); return toast('WhatsApp inválido: use DDD + número, ex.: (11)98811-8988.', false); }
      const wa = '55' + waLocal;
      const tel = digitos($('#k-tel').value);
      if (tel && !telValido(tel)) { $('#k-tel').focus(); return toast('Telefone incompleto: use DDD + número, ex.: (11)98811-8988.', false); }
      let ig = $('#k-ig').value.trim(); if (ig && !ig.startsWith('@')) ig = '@' + ig;
      let igu = $('#k-igu').value.trim();
      if (!igu && ig) igu = `https://www.instagram.com/${ig.slice(1)}/`;
      if (igu && !/^https:\/\/(www\.)?instagram\.com\//.test(igu)) return toast('O link do Instagram deve começar com https://www.instagram.com/', false);
      if (!$('#k-nome').value.trim()) return toast('Informe o nome da barbearia.', false);
      const obj = {
        nome: $('#k-nome').value.trim(), slogan: $('#k-slogan').value.trim(), desde: $('#k-desde').value, servicos_subtitulo: $('#k-sub').value.trim(),
        hero_texto: $('#k-hero').value.trim(), sobre_titulo: $('#k-st').value.trim(), sobre_texto: $('#k-sx').value.trim(),
        telefone: BJ.tel(tel), whatsapp: wa, endereco: $('#k-end').value.trim(), instagram: ig, instagram_url: igu, whatsapp_msg: $('#k-wam').value.trim(), ...novas,
      };
      const btn = $('button[type="submit"]', c); btn.disabled = true;
      const ok = await seguro(() => Api.salvarConfig(obj).then(() => true), 'Não foi possível salvar.');
      btn.disabled = false;
      if (ok) { await recarregar(); toast('Configurações salvas.'); }
    };
  }

  /* ---------------------------------------------------------------- início */
  (async function boot() {
    if (!Api.logado()) return mostrarLogin();
    try { await recarregar(); mostrarPainel(); } catch { mostrarLogin(); }
  })();
})();
