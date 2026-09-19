/* Painel administrativo — Dashboard, Agendamentos, Serviços, Combos, Horários, Bloqueios, Galeria, Configurações. */
(function () {
  'use strict';
  const A = window.BJAvail;
  const esc = BJ.esc;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  let D = { config: {}, servicos: [], combos: [], horarios: [], galeria: [], bloqueios: [] };
  const S = { dia: null, mes: null, diaAg: null, mostrarCancelados: false, mostrarPassados: false, ag: new Map() };
  let rotaAtual = 'dashboard';
  let ordemDias = [1, 2, 3, 4, 5, 6, 0];

  BJIcons.hydrate();

  /* ------------------------------------------------------------ utilidades */
  const hojeIso = () => A.isoDate(new Date());
  const dataLonga = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); };
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const brl = (v) => (v == null ? 'Sob consulta' : A.fmtBRL(v));
  const numBR = (s) => { s = String(s).trim().replace(/\./g, '').replace(',', '.'); return s === '' ? null : Number(s); };
  const fmtNum = (v) => (v == null ? '' : String(v).replace('.', ','));
  const digitos = (s) => String(s || '').replace(/\D/g, '');
  function fmtTel(s) {
    let d = digitos(s); if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
    if (d.length === 11) return `(${d.slice(0, 2)}) ${d[2]} ${d.slice(3, 7)}-${d.slice(7)}`;
    if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return s;
  }
  const waCliente = (s) => { let d = digitos(s); if (d.length <= 11) d = '55' + d; return 'https://wa.me/' + d; };
  const pick = (o, cols) => Object.fromEntries(cols.filter((c) => c in o).map((c) => [c, o[c]]));

  function toast(msg, ok = true) {
    const t = $('#toast');
    t.textContent = msg; t.className = 'toast' + (ok ? ' ok' : ''); t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ok ? 3500 : 7000);
  }

  /** Executa uma ação; trata sessão expirada e mostra erros. */
  async function seguro(fn, msgErro) {
    try { return await fn(); } catch (e) {
      if (e.status === 401) { mostrarLogin('Sua sessão expirou. Entre novamente.'); return undefined; }
      toast((msgErro ? msgErro + ' ' : '') + (e.message || 'Erro inesperado.'), false);
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
    $('#modal-rodape').innerHTML = rodape || '<button type="button" class="btn" data-fechar>Fechar</button>';
    aoEnviar = enviar || null;
    BJIcons.hydrate(modal);
    if (!modal.open) modal.showModal();
    if (aberto) aberto();
  }
  const fecharModal = () => { if (modal.open) modal.close(); };
  $('#modal-x').addEventListener('click', fecharModal);
  modal.addEventListener('click', (e) => { if (e.target === modal || e.target.closest('[data-fechar]')) fecharModal(); });
  $('#modal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!aoEnviar) return;
    const btn = $('#modal-rodape button[type="submit"]');
    if (btn) btn.disabled = true;
    try { await aoEnviar(); } finally { if (btn) btn.disabled = false; }
  });

  function confirma(texto, rotulo = 'Confirmar', perigo = true) {
    return new Promise((ok) => {
      const d = document.createElement('dialog');
      d.className = 'modal';
      d.setAttribute('aria-label', 'Confirmação');
      d.innerHTML = `<div class="modal__box"><div class="modal__corpo"><p>${esc(texto)}</p></div>
        <div class="modal__rodape"><button type="button" class="btn" data-r="0">Voltar</button><button type="button" class="btn ${perigo ? 'btn--perigo' : 'btn--solid'}" data-r="1">${esc(rotulo)}</button></div></div>`;
      document.body.appendChild(d);
      const fim = (v) => { d.close(); d.remove(); ok(v); };
      d.addEventListener('click', (e) => { const b = e.target.closest('[data-r]'); if (b) fim(b.dataset.r === '1'); else if (e.target === d) fim(false); });
      d.addEventListener('cancel', (e) => { e.preventDefault(); fim(false); });
      d.showModal();
      $('[data-r="0"]', d).focus();
    });
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
    if (Api.logado()) Api.sair();
    setTimeout(() => $('#l-user').focus(), 30);
  }
  function mostrarPainel() {
    $('#login').hidden = true; $('#painel').hidden = false;
    rotear();
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
      er.textContent = err.codigo === 'CREDENCIAIS' ? 'Usuário ou senha incorretos.' : err.codigo === 'MUITAS_TENTATIVAS' ? 'Muitas tentativas. Aguarde 1 minuto.' : (err.message || 'Não foi possível entrar.');
    } finally { btn.disabled = false; btn.textContent = 'Entrar'; }
  });
  $('#sair').addEventListener('click', () => mostrarLogin());

  async function recarregar() { D = await Api.carregarAdmin(); }

  /* --------------------------------------------------------------- roteador */
  const VIEWS = {
    dashboard: ['Dashboard', vDashboard], agendamentos: ['Agendamentos', vAgendamentos], servicos: ['Serviços', vServicos], combos: ['Combos', vCombos],
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
    c.innerHTML = '<p class="vazio">Carregando…</p>';
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

  /* =================================================== Dashboard / Agenda */
  function linhaAg(a) {
    const nomes = a.servicos.map((s) => s.nome).join(' + ');
    return `<button type="button" class="ag-row${a.status === 'cancelado' ? ' cancelado' : ''}" data-ag="${a.id}">
      <span class="ag-hora">${A.fmtMin(a.inicio_min)}<small>até ${A.fmtMin(a.fim_min)}</small></span>
      <span><span class="ag-nome">${esc(a.cliente.nome)}${a.status === 'cancelado' ? '<span class="tag off">Cancelado</span>' : ''}</span><span class="ag-serv" style="display:block">${esc(nomes)}</span></span>
      <span class="ag-preco">${a.valor_consulta ? (Number(a.valor_total) ? A.fmtBRL(a.valor_total) + ' +' : 'A consultar') : A.fmtBRL(a.valor_total)}</span></button>`;
  }
  function detalheAg(a, aoMudar) {
    S.ag.set(String(a.id), a);
    const itens = a.servicos.map((s) => `${esc(s.nome)} (${s.duracao_min} min)`).join('<br>');
    abrirModal({
      titulo: 'Agendamento ' + a.codigo,
      corpo: `<dl class="det">
        <div><dt>Status</dt><dd>${a.status === 'cancelado' ? '<span class="tag off">Cancelado</span>' : 'Confirmado'}</dd></div>
        <div><dt>Cliente</dt><dd>${esc(a.cliente.nome)}</dd></div>
        <div><dt>WhatsApp</dt><dd><a href="${esc(waCliente(a.cliente.whatsapp))}" target="_blank" rel="noopener" style="color:var(--gold-2)">${esc(fmtTel(a.cliente.whatsapp))}</a></dd></div>
        <div><dt>Data</dt><dd>${esc(cap(dataLonga(a.data)))}</dd></div>
        <div><dt>Horário</dt><dd>${A.fmtMin(a.inicio_min)} às ${A.fmtMin(a.fim_min)}</dd></div>
        <div><dt>Serviços</dt><dd>${itens}${a.combos_aplicados ? `<br><small style="color:var(--gold-2)">Combo: ${esc(a.combos_aplicados)}</small>` : ''}</dd></div>
        <div><dt>Duração</dt><dd>${A.fmtDur(a.duracao_min)}</dd></div>
        <div><dt>Valor</dt><dd>${a.valor_consulta ? (Number(a.valor_total) ? A.fmtBRL(a.valor_total) + ' + a consultar' : 'A consultar') : A.fmtBRL(a.valor_total)}</dd></div>
      </dl>`,
      rodape: `<a class="btn" href="${esc(waCliente(a.cliente.whatsapp))}" target="_blank" rel="noopener"><i data-icon="whatsapp"></i>WhatsApp</a>
        ${a.status === 'confirmado' ? '<button type="button" class="btn btn--perigo" id="cancelar-ag"><i data-icon="ban"></i>Cancelar agendamento</button>' : ''}
        <button type="button" class="btn" data-fechar>Fechar</button>`,
      aberto() {
        const b = $('#cancelar-ag');
        if (b) b.addEventListener('click', async () => {
          if (!(await confirma(`Cancelar o agendamento de ${a.cliente.nome} (${A.fmtData(a.data)} às ${A.fmtMin(a.inicio_min)})? O horário volta a ficar disponível.`, 'Cancelar agendamento'))) return;
          const ok = await seguro(() => Api.cancelar(a.id).then(() => true), 'Não foi possível cancelar.');
          if (ok) { fecharModal(); toast('Agendamento cancelado.'); aoMudar(); }
        });
      },
    });
  }

  async function vDashboard(c) {
    const dia = S.dia || hojeIso();
    S.dia = dia;
    const todos = await Api.agendamentos(dia, dia);
    const ativos = todos.filter((a) => a.status === 'confirmado');
    const previsto = ativos.reduce((s, a) => s + Number(a.valor_total), 0);
    const mins = ativos.reduce((s, a) => s + a.duracao_min, 0);
    const ehHoje = dia === hojeIso();
    c.innerHTML = `<div class="pg-topo"><div><h1>${ehHoje ? 'Hoje' : esc(cap(dataLonga(dia)))}</h1><p>${ativos.length} ${ativos.length === 1 ? 'agendamento' : 'agendamentos'}${ehHoje ? ' · ' + esc(cap(dataLonga(dia))) : ''}</p></div>
      <div class="dia-nav"><button class="icone" data-d="-1" aria-label="Dia anterior"><i data-icon="left"></i></button>
        <input type="date" id="dash-data" value="${dia}" aria-label="Escolher dia">
        <button class="icone" data-d="1" aria-label="Próximo dia"><i data-icon="right"></i></button>
        ${ehHoje ? '' : '<button class="btn btn--sm" data-d="0">Hoje</button>'}</div></div>
      <div class="kpis"><div class="kpi"><span>Agendamentos</span><b>${ativos.length}</b></div><div class="kpi"><span>Faturamento previsto</span><b>${A.fmtBRL(previsto)}</b></div><div class="kpi"><span>Tempo ocupado</span><b>${mins ? A.fmtDur(mins) : '—'}</b></div></div>
      <div class="cartao">${ativos.length ? `<div class="lista">${ativos.map(linhaAg).join('')}</div>` : '<p class="vazio">Nenhum agendamento neste dia.</p>'}</div>
      <p style="margin-top:16px"><a class="btn btn--sm" href="#/agendamentos">Ver todos os agendamentos</a></p>`;
    todos.forEach((a) => S.ag.set(String(a.id), a));
    c.onclick = (e) => {
      const r = e.target.closest('[data-ag]');
      if (r) return detalheAg(S.ag.get(r.dataset.ag), refazer);
      const d = e.target.closest('[data-d]');
      if (d) { const k = Number(d.dataset.d); S.dia = k === 0 ? hojeIso() : A.addDays(S.dia, k); refazer(); }
    };
    c.onchange = (e) => { if (e.target.id === 'dash-data' && e.target.value) { S.dia = e.target.value; refazer(); } };
  }

  async function vAgendamentos(c) {
    if (!S.mes) { const [y, m] = hojeIso().split('-').map(Number); S.mes = { y, m: m - 1 }; }
    const { y, m } = S.mes;
    const ultimo = new Date(y, m + 1, 0).getDate();
    const p2 = (n) => String(n).padStart(2, '0');
    const lista = await Api.agendamentos(`${y}-${p2(m + 1)}-01`, `${y}-${p2(m + 1)}-${p2(ultimo)}`);
    lista.forEach((a) => S.ag.set(String(a.id), a));
    const ativos = lista.filter((a) => a.status === 'confirmado');
    const porDia = {};
    ativos.forEach((a) => { porDia[a.data] = (porDia[a.data] || 0) + 1; });
    if (!S.diaAg || S.diaAg.slice(0, 7) !== `${y}-${p2(m + 1)}`) S.diaAg = hojeIso().slice(0, 7) === `${y}-${p2(m + 1)}` ? hojeIso() : `${y}-${p2(m + 1)}-01`;
    const primeiro = new Date(y, m, 1).getDay();
    let cel = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'].map((l) => `<span class="sem" aria-hidden="true">${l}</span>`).join('') + '<span class="vazio-c"></span>'.repeat(primeiro);
    for (let d = 1; d <= ultimo; d++) {
      const iso = `${y}-${p2(m + 1)}-${p2(d)}`;
      cel += `<button type="button" data-dia="${iso}" class="${iso === S.diaAg ? 'sel' : ''}${iso === hojeIso() ? ' hoje' : ''}" aria-label="${esc(dataLonga(iso))}${porDia[iso] ? ', ' + porDia[iso] + ' agendamentos' : ''}" ${iso === S.diaAg ? 'aria-pressed="true"' : ''}>${d}${porDia[iso] ? `<i>${'●'.repeat(Math.min(porDia[iso], 3))}${porDia[iso] > 3 ? '+' : ''}</i>` : ''}</button>`;
    }
    const doDia = lista.filter((a) => a.data === S.diaAg && (S.mostrarCancelados || a.status === 'confirmado'));
    c.innerHTML = `<div class="pg-topo"><div><h1>Agendamentos</h1><p>Toque em um dia para ver os horários marcados.</p></div></div>
      <div class="duas-col"><div class="cartao cartao__pad">
        <div class="cal-topo"><button class="icone" data-mes="-1" aria-label="Mês anterior"><i data-icon="left"></i></button><strong>${A.MESES[m]} ${y}</strong><button class="icone" data-mes="1" aria-label="Próximo mês"><i data-icon="right"></i></button></div>
        <div class="cal-adm" role="group" aria-label="Calendário">${cel}</div>
        <p style="margin-top:12px;font-size:12px;color:var(--muted)">● = agendamentos no dia · ${ativos.length} no mês</p></div>
      <div class="cartao"><div class="cartao__pad" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;border-bottom:1px solid var(--line)">
        <div><h2 style="margin:0">${esc(cap(dataLonga(S.diaAg)))}</h2></div>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted)"><span class="chave"><input type="checkbox" id="ver-canc" ${S.mostrarCancelados ? 'checked' : ''}><span></span></span>Mostrar cancelados</label></div>
        ${doDia.length ? `<div class="lista">${doDia.map(linhaAg).join('')}</div>` : '<p class="vazio">Nenhum agendamento neste dia.</p>'}</div></div>`;
    c.onclick = (e) => {
      const r = e.target.closest('[data-ag]'); if (r) return detalheAg(S.ag.get(r.dataset.ag), refazer);
      const d = e.target.closest('[data-dia]'); if (d) { S.diaAg = d.dataset.dia; return refazer(); }
      const mm = e.target.closest('[data-mes]');
      if (mm) { const t = new Date(S.mes.y, S.mes.m + Number(mm.dataset.mes), 1); S.mes = { y: t.getFullYear(), m: t.getMonth() }; refazer(); }
    };
    c.onchange = (e) => { if (e.target.id === 'ver-canc') { S.mostrarCancelados = e.target.checked; refazer(); } };
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
        <div class="campo"><label for="f-preco">Preço (R$)</label><input id="f-preco" inputmode="decimal" placeholder="vazio = sob consulta" value="${esc(s ? fmtNum(s.preco) : '')}"></div></div>
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
        <div class="grade2"><div class="campo"><label for="c-preco">Preço do combo (R$)</label><input id="c-preco" inputmode="decimal" value="${esc(b ? fmtNum(b.preco) : '')}" required></div>
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
        <div class="grade2"><div class="campo"><label for="k-tel">Telefone (exibição)</label><input id="k-tel" value="${v('telefone')}" placeholder="(11) 98811-8988"></div>
          <div class="campo"><label for="k-wa">WhatsApp (com DDI)</label><input id="k-wa" inputmode="numeric" value="${v('whatsapp')}" placeholder="5511988118988"><small>Só números. Ex.: 55 + DDD + número.</small></div></div>
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
      let wa = digitos($('#k-wa').value);
      if (wa.length >= 10 && wa.length <= 11) wa = '55' + wa;
      if (wa.length < 12 || wa.length > 13) return toast('WhatsApp inválido. Use DDI + DDD + número (ex.: 5511988118988).', false);
      let ig = $('#k-ig').value.trim(); if (ig && !ig.startsWith('@')) ig = '@' + ig;
      let igu = $('#k-igu').value.trim();
      if (!igu && ig) igu = `https://www.instagram.com/${ig.slice(1)}/`;
      if (igu && !/^https:\/\/(www\.)?instagram\.com\//.test(igu)) return toast('O link do Instagram deve começar com https://www.instagram.com/', false);
      if (!$('#k-nome').value.trim()) return toast('Informe o nome da barbearia.', false);
      const obj = {
        nome: $('#k-nome').value.trim(), slogan: $('#k-slogan').value.trim(), desde: $('#k-desde').value, servicos_subtitulo: $('#k-sub').value.trim(),
        hero_texto: $('#k-hero').value.trim(), sobre_titulo: $('#k-st').value.trim(), sobre_texto: $('#k-sx').value.trim(),
        telefone: $('#k-tel').value.trim(), whatsapp: wa, endereco: $('#k-end').value.trim(), instagram: ig, instagram_url: igu, whatsapp_msg: $('#k-wam').value.trim(), ...novas,
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
