/* Fluxo de agendamento: serviços → data → horário → dados → confirmação. */
(function () {
  'use strict';
  const A = window.BJAvail;
  const esc = BJ.esc;
  const $ = (s) => document.querySelector(s);
  const ETAPAS = ['Serviços', 'Data', 'Horário', 'Dados', 'Confirmar'];
  const CONFLITOS = ['HORARIO_OCUPADO', 'ALMOCO', 'BLOQUEADO', 'FORA_DO_EXPEDIENTE', 'PASSADO'];

  const S = {
    etapa: 1, site: null, ids: new Set(), data: null, mes: null, inicio: null,
    ocupados: [], carregandoHorarios: false, erroHorarios: false,
    nome: '', whats: '', erros: {}, enviando: false, resultado: null, alerta: null,
  };

  BJIcons.hydrate();

  /* ------------------------------------------------------------ utilidades */
  const agora = () => { const d = new Date(); return { data: A.isoDate(d), min: d.getHours() * 60 + d.getMinutes() }; };
  const preco = () => A.calcPricing([...S.ids], S.site.servicos, S.site.combos);
  const totalTxt = (p) => {
    const total = Number(p.total || 0);
    return p.consulta ? (total ? A.fmtBRL(total) + ' + a consultar' : 'A consultar') : A.fmtBRL(total);
  };
  const dataLonga = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); };
  const dataCurta = (iso) => { const [y, m, d] = iso.split('-').map(Number); const s = new Date(y, m - 1, d).toLocaleDateString('pt-BR', { weekday: 'long' }); return s.charAt(0).toUpperCase() + s.slice(1, 3) + ', ' + A.fmtData(iso); };
  function toast(msg, ok) {
    const t = $('#toast');
    t.textContent = msg; t.className = 'toast' + (ok ? ' ok' : ''); t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 6000);
  }
  const mascara = (v) => BJ.tel(v); // (11)98765-4321 — mesma máscara do painel
  const whatsValido = (d) => (d.length === 11 && d[2] === '9' && d[0] !== '0') || (d.length === 10 && d[0] !== '0');

  /* ------------------------------------------------------------ navegação */
  function podeIr(n) {
    if (n >= 2 && !S.ids.size) return 1;
    if (n >= 3 && !S.data) return 2;
    if (n >= 4 && S.inicio == null) return 3;
    if (n >= 5 && !(S.nome.trim().length >= 3 && whatsValido(S.whats.replace(/\D/g, '')))) return 4;
    if (n >= 6 && !S.resultado) return 5;
    return n;
  }
  function ir(n, { empilhar = true } = {}) {
    n = podeIr(n);
    S.etapa = n; S.alerta = null;
    if (empilhar) history.pushState({ etapa: n }, '');
    if (n === 3) carregarHorarios();
    render(true);
  }
  window.addEventListener('popstate', (e) => {
    if (S.etapa === 6) { location.href = 'index.html'; return; }
    S.etapa = podeIr((e.state && e.state.etapa) || 1);
    if (S.etapa === 3) carregarHorarios();
    render(true);
  });
  $('#voltar').addEventListener('click', () => {
    if (S.etapa === 1 || S.etapa === 6) location.href = 'index.html';
    else history.length > 1 && history.state && history.state.etapa ? history.back() : ir(S.etapa - 1, { empilhar: false });
  });
  $('#fechar-agendamento').addEventListener('click', () => { location.href = 'index.html'; });

  /* ----------------------------------------------------------- renderização */
  function stepper() {
    const el = $('#stepper');
    el.hidden = S.etapa === 6;
    el.innerHTML = ETAPAS.map((t, i) => `<li class="${i + 1 < S.etapa ? 'feito' : i + 1 === S.etapa ? 'atual' : ''}"${i + 1 === S.etapa ? ' aria-current="step"' : ''}><i></i>${t}</li>`).join('');
  }
  function rodape(html) {
    const f = $('#rodape');
    f.hidden = !html;
    f.innerHTML = html || '';
  }

  function telaServicos() {
    const p = preco();
    const linhas = S.site.servicos.map((s) => `
      <label class="linha"><input type="checkbox" value="${s.id}" ${S.ids.has(s.id) ? 'checked' : ''}>
        <span class="chk">${BJIcons.svg('check')}</span>
        <span class="nome">${esc(s.nome)}</span>
        <span class="preco${s.preco == null ? ' consulta' : ''}">${esc(BJ.preco(s))}</span></label>`).join('');
    const combos = p.linhas.filter((l) => l.tipo === 'combo');
    const aviso = combos.length ? `<div class="combo-aviso">${BJIcons.svg('star')}<div>Combo aplicado: <b>${esc(combos.map((c) => c.nome).join(', '))}</b>${p.economia ? ` — você economiza <b>${A.fmtBRL(p.economia)}</b>.` : '.'}</div></div>` : '';
    $('#tela').innerHTML = `<h1 tabindex="-1">Escolha os serviços</h1><p class="sub">Selecione um ou mais serviços.</p>
      <div class="linhas" role="group" aria-label="Serviços">${linhas || '<p class="vazio-msg">Nenhum serviço disponível no momento.</p>'}</div>${aviso}`;
    rodape(`<div class="total"><span>Total: <b>${esc(totalTxt(p))}</b></span></div>
      <button class="btn btn--solid" data-acao="continuar" ${S.ids.size ? '' : 'disabled'}>Continuar</button>`);
  }

  function atualizarServicosSemRedesenhar() {
    // mantém o foco no checkbox: só atualiza aviso de combo e rodapé
    const p = preco();
    const combos = p.linhas.filter((l) => l.tipo === 'combo');
    let av = $('.combo-aviso');
    if (combos.length) {
      const html = `${BJIcons.svg('star')}<div>Combo aplicado: <b>${esc(combos.map((c) => c.nome).join(', '))}</b>${p.economia ? ` — você economiza <b>${A.fmtBRL(p.economia)}</b>.` : '.'}</div>`;
      if (!av) { av = document.createElement('div'); av.className = 'combo-aviso'; $('#tela').appendChild(av); }
      av.innerHTML = html;
    } else if (av) av.remove();
    rodape(`<div class="total"><span>Total: <b>${esc(totalTxt(p))}</b></span></div>
      <button class="btn btn--solid" data-acao="continuar" ${S.ids.size ? '' : 'disabled'}>Continuar</button>`);
  }

  function diaLivreNoCalendario(iso, dur) {
    const hoje = agora();
    const cfg = S.site.config;
    if (iso < hoje.data || iso > A.addDays(hoje.data, Number(cfg.dias_agenda || 60))) return false;
    const j = A.janelaDoDia(iso, S.site.horarios);
    if (!j || j.fim - j.ini < dur) return false;
    if (iso === hoje.data && hoje.min + Number(cfg.antecedencia_min || 0) + dur > j.fim) return false;
    return true;
  }

  function telaData() {
    const p = preco();
    if (!S.mes) { const b = S.data ? S.data.split('-') : agora().data.split('-'); S.mes = { y: +b[0], m: +b[1] - 1 }; }
    const { y, m } = S.mes;
    const hoje = agora();
    const primeiro = new Date(y, m, 1).getDay();
    const n = new Date(y, m + 1, 0).getDate();
    const hj = hoje.data.split('-').map(Number);
    const noMesAtual = y === hj[0] && m === hj[1] - 1;
    const proxIso = A.isoDate(new Date(y, m + 1, 1));
    const maxIso = A.addDays(hoje.data, Number(S.site.config.dias_agenda || 60));
    let cel = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'].map((l, i) => `<span class="sem" aria-hidden="true">${l}</span>`).join('');
    for (let i = 0; i < primeiro; i++) cel += '<span class="dia vazio"></span>';
    for (let d = 1; d <= n; d++) {
      const iso = A.isoDate(new Date(y, m, d));
      const livre = diaLivreNoCalendario(iso, p.duracao);
      cel += `<button type="button" class="dia${iso === hoje.data ? ' hoje' : ''}${iso === S.data ? ' sel' : ''}" data-dia="${iso}" ${livre ? '' : 'disabled'} aria-label="${dataLonga(iso)}${livre ? '' : ', indisponível'}" ${iso === S.data ? 'aria-pressed="true"' : ''}>${d}</button>`;
    }
    $('#tela').innerHTML = `<h1 tabindex="-1">Escolha a data</h1><p class="sub">Selecione uma data disponível.</p>
      <div class="cal-nav"><button type="button" data-mes="-1" aria-label="Mês anterior" ${noMesAtual ? 'disabled' : ''}>${BJIcons.svg('left')}</button>
        <strong aria-live="polite">${A.MESES[m]} ${y}</strong>
        <button type="button" data-mes="1" aria-label="Próximo mês" ${proxIso > maxIso ? 'disabled' : ''}>${BJIcons.svg('right')}</button></div>
      <div class="cal" role="group" aria-label="Dias de ${A.MESES[m]} de ${y}">${cel}</div>
      <div class="legenda"><span><i></i>Disponível</span><span class="off"><i></i>Indisponível</span></div>`;
    rodape(`<button class="btn btn--solid" data-acao="continuar" ${S.data ? '' : 'disabled'}>Continuar</button>`);
  }

  async function carregarHorarios() {
    const dia = S.data;
    S.carregandoHorarios = true; S.erroHorarios = false;
    if (S.etapa === 3) render(false);
    try { S.ocupados = await Api.indisponiveis(dia); } catch { S.erroHorarios = true; S.ocupados = []; }
    if (dia !== S.data) return;
    S.carregandoHorarios = false;
    if (S.inicio != null) { // horário escolhido antes pode ter sido tomado por outra pessoa
      const r = A.validarHorario({ ...ctxHorario(), inicio_min: S.inicio });
      if (!r.ok) S.inicio = null;
    }
    if (S.etapa === 3) render(false);
  }
  function ctxHorario() {
    return { data: S.data, duracao: preco().duracao, horarios: S.site.horarios, config: S.site.config, bloqueios: [], ocupados: S.ocupados, agora: agora() };
  }

  function telaHorario() {
    let corpo;
    const al = A.almoco(S.site.config);
    if (S.carregandoHorarios) {
      corpo = `<div class="slots skel" aria-busy="true">${'<button class="slot" disabled></button>'.repeat(9)}</div>`;
    } else if (S.erroHorarios) {
      corpo = `<div class="vazio-msg">Não foi possível carregar os horários.<br><button class="btn btn--sm" style="margin-top:12px" data-acao="recarregar">Tentar novamente</button></div>`;
    } else {
      // Livres + horários ocupados (almoço, bloqueio ou cliente) aparecem; os que só "não cabem" ficam ocultos.
      const ocupados = [...(al ? [al] : []), ...S.ocupados.map((o) => ({ ini: Number(o.ini), fim: Number(o.fim) }))];
      const ocupado = (t) => ocupados.some((o) => o.ini <= t && t < o.fim);
      const slots = A.gerarHorarios(ctxHorario()).filter((s) => s.livre || (s.motivo !== 'PASSADO' && ocupado(s.inicio_min)));
      corpo = slots.some((s) => s.livre)
        ? `<div class="slots" role="group" aria-label="Horários">${slots.map((s) => `<button type="button" class="slot" data-h="${s.inicio_min}" ${s.livre ? '' : `disabled aria-label="${A.fmtMin(s.inicio_min)}, indisponível"`} aria-pressed="${S.inicio === s.inicio_min}">${A.fmtMin(s.inicio_min)}</button>`).join('')}</div>`
        : '<div class="vazio-msg">Não há horários disponíveis nesta data para os serviços escolhidos.<br>Escolha outra data.</div>';
    }
    $('#tela').innerHTML = `<h1 tabindex="-1">Horários disponíveis</h1>
      <div class="data-linha">${BJIcons.svg('calendar')}<span>${dataLonga(S.data)}</span></div>${corpo}`;
    rodape(`<button class="btn btn--solid" data-acao="continuar" ${S.inicio != null ? '' : 'disabled'}>Continuar</button>`);
  }

  function telaDados() {
    const e = S.erros;
    $('#tela').innerHTML = `<h1 tabindex="-1">Seus dados</h1><p class="sub">Usamos seu WhatsApp só para confirmar o horário e avisar se algo mudar.</p>
      <form id="form-dados" novalidate>
        <div class="campo"><label for="nome">Nome e sobrenome</label>
          <input id="nome" name="nome" type="text" autocomplete="name" placeholder="Digite seu nome e sobrenome" maxlength="80" value="${esc(S.nome)}" required ${e.nome ? 'aria-invalid="true" aria-describedby="e-nome"' : ''}>
          <span class="erro" id="e-nome">${esc(e.nome || '')}</span></div>
        <div class="campo"><label for="whats">WhatsApp</label>
          <input id="whats" name="whats" type="tel" inputmode="tel" autocomplete="tel-national" data-mascara="tel" placeholder="(11)98765-4321" value="${esc(S.whats)}" required ${e.whats ? 'aria-invalid="true" aria-describedby="e-whats"' : ''}>
          <span class="erro" id="e-whats">${esc(e.whats || '')}</span></div>
        <p class="privacidade">Seus dados ficam guardados apenas junto ao seu agendamento.</p>
      </form>`;
    rodape(`<button class="btn btn--solid" data-acao="continuar">Continuar</button>`);
  }

  function blocoResumo(o) {
    return `<div class="resumo">
      <h2>Agendamento</h2>
      <dl>
        <div class="par"><dt>Data</dt><dd>${esc(dataCurta(o.data))}</dd></div>
        <div class="par"><dt>Horário</dt><dd>${A.fmtMin(o.inicio)}</dd></div>
      </dl><div class="sep"></div>
      <dl>
        <div class="par" style="flex-direction:column;gap:2px"><dt>Serviços</dt><dd style="text-align:left">${o.linhas.map((l) => `<div class="item"><span>${esc(l.nome)}</span><span>${l.preco == null ? 'Sob consulta' : A.fmtBRL(l.preco)}</span></div>`).join('')}</dd></div>
        <div class="par tot"><dt>Valor total</dt><dd>${esc(o.total)}</dd></div>
      </dl>
      ${o.cliente ? `<div class="sep"></div><dl><div class="par"><dt>Nome</dt><dd>${esc(o.cliente.nome)}</dd></div><div class="par"><dt>WhatsApp</dt><dd>${esc(mascara(o.cliente.whatsapp))}</dd></div></dl>` : ''}
    </div>`;
  }

  function telaConfirmar() {
    const p = preco();
    const linhas = p.linhas.map((l) => (l.tipo === 'combo'
      ? { nome: l.nome + ' (combo)', preco: l.preco }
      : { nome: l.nome, preco: l.preco }));
    $('#tela').innerHTML = `<h1 tabindex="-1">Confirme seu agendamento</h1><p class="sub">Confira os dados antes de confirmar.</p>
      ${S.alerta ? `<div class="alerta" role="alert">${BJIcons.svg('close')}<div>${esc(S.alerta)}</div></div>` : ''}
      ${blocoResumo({ data: S.data, inicio: S.inicio, dur: p.duracao, linhas, total: totalTxt(p), cliente: { nome: BJ.nome(S.nome), whatsapp: S.whats } })}`;
    rodape(`<button class="btn btn--solid" data-acao="confirmar" ${S.enviando ? 'disabled' : ''}>${S.enviando ? '<span class="spinner" aria-hidden="true"></span>Confirmando…' : 'Confirmar agendamento'}</button>`);
  }

  function telaSucesso() {
    const a = S.resultado;
    const tot = a.valor_consulta ? (Number(a.valor_total) ? A.fmtBRL(a.valor_total) + ' + a consultar' : 'A consultar') : A.fmtBRL(a.valor_total);
    // linhas iguais às da confirmação (mesma regra de combo); o total exibido vem do servidor
    const linhas = preco().linhas.map((l) => ({ nome: l.tipo === 'combo' ? l.nome + ' (combo)' : l.nome, preco: l.preco }));
    const [y, m, d] = a.data.split('-').map(Number);
    const dia = new Date(y, m - 1, d);
    const semana = dia.toLocaleDateString('pt-BR', { weekday: 'long' });
    const end = S.site.config.endereco;
    $('#tela').innerHTML = `<div class="sucesso">
      <div class="selo">${BJIcons.svg('check')}</div>
      <h1 tabindex="-1">Horário confirmado!</h1>
      <p class="sub">Te esperamos, ${esc(String(a.cliente.nome).split(' ')[0])}.</p>
      <div class="ticket">
        <div class="ticket__quando">
          <div class="ticket__data"><span>${esc(semana.charAt(0).toUpperCase() + semana.slice(1))}</span><strong>${esc(dia.toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' }))}</strong></div>
          <div class="ticket__hora"><strong>${A.fmtMin(a.inicio_min)}</strong><span>até ${A.fmtMin(a.fim_min)}</span></div>
        </div>
        <ul class="ticket__itens">${linhas.map((l) => `<li><span>${esc(l.nome)}</span><span>${l.preco == null ? 'Sob consulta' : A.fmtBRL(l.preco)}</span></li>`).join('')}
          <li class="ticket__total"><span>Total</span><span>${esc(tot)}</span></li></ul>
        ${end ? `<a class="ticket__local" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(end)}" target="_blank" rel="noopener">${BJIcons.svg('pin')}<span>${esc(end)}</span>${BJIcons.svg('right')}</a>` : ''}
      </div>
      <div class="acoes">
        <button class="btn btn--solid" data-acao="ics">${BJIcons.svg('calendar')}Salvar na agenda</button>
        <a class="btn" href="${esc(waPosAgendamento(a))}" target="_blank" rel="noopener">${BJIcons.svg('whatsapp')}WhatsApp</a>
      </div>
      <button class="link" data-acao="novo">Fazer novo agendamento</button>
    </div>`;
    rodape(null);
  }

  function waPosAgendamento(a) {
    const msg = `Olá! Acabei de agendar pelo site da ${S.site.config.nome || 'Barbearia do Juan'}. Seguem os dados do meu agendamento:

*Data:* ${A.fmtData(a.data)}
*Horário:* ${A.fmtMin(a.inicio_min)}
*Serviços:* ${a.servicos.map((s) => s.nome).join(', ')}
*Nome:* ${a.cliente.nome}

Até lá!`;
    return BJ.waLink(S.site.config, msg);
  }

  function baixarIcs(a) {
    const pad = (n) => String(n).padStart(2, '0');
    const t = (m) => pad(Math.floor(m / 60)) + pad(m % 60) + '00';
    const d = a.data.replace(/-/g, '');
    const txt = (s) => String(s).replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
    const n = new Date();
    const stamp = n.getUTCFullYear() + pad(n.getUTCMonth() + 1) + pad(n.getUTCDate()) + 'T' + pad(n.getUTCHours()) + pad(n.getUTCMinutes()) + pad(n.getUTCSeconds()) + 'Z';
    const nome = S.site.config.nome || 'Barbearia do Juan';
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Barbearia do Juan//Agendamento//PT-BR', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
      `UID:${a.codigo}@barbeariadojuan`, `DTSTAMP:${stamp}`, `DTSTART;TZID=America/Sao_Paulo:${d}T${t(a.inicio_min)}`, `DTEND;TZID=America/Sao_Paulo:${d}T${t(a.fim_min)}`,
      `SUMMARY:${txt(nome + ' — ' + a.servicos.map((s) => s.nome).join(' + '))}`, `LOCATION:${txt(S.site.config.endereco || '')}`,
      `DESCRIPTION:${txt('Valor: ' + (a.valor_consulta ? 'a consultar' : A.fmtBRL(a.valor_total)))}`,
      'BEGIN:VALARM', 'TRIGGER:-PT1H', 'ACTION:DISPLAY', 'DESCRIPTION:Seu horário na barbearia é daqui a 1 hora', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
    const l = document.createElement('a');
    l.href = url; l.download = 'barbearia-' + a.data + '.ics';
    document.body.appendChild(l); l.click(); l.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function render(foco) {
    stepper();
    ({ 1: telaServicos, 2: telaData, 3: telaHorario, 4: telaDados, 5: telaConfirmar, 6: telaSucesso })[S.etapa]();
    BJIcons.hydrate($('#tela'));
    if (foco) { const h = $('#tela h1'); if (h) h.focus({ preventScroll: true }); $('#tela').scrollTop = 0; }
  }

  /* ---------------------------------------------------------------- eventos */
  $('#tela').addEventListener('change', (e) => {
    if (S.etapa !== 1 || e.target.type !== 'checkbox') return;
    const id = Number(e.target.value);
    e.target.checked ? S.ids.add(id) : S.ids.delete(id);
    S.data = null; S.inicio = null; // a duração mudou: recomeça data/horário
    atualizarServicosSemRedesenhar();
  });
  $('#tela').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.dia) { S.data = b.dataset.dia; S.inicio = null; render(false); const sel = $('.dia.sel'); if (sel) sel.focus(); }
    else if (b.dataset.mes) { const k = Number(b.dataset.mes); const d = new Date(S.mes.y, S.mes.m + k, 1); S.mes = { y: d.getFullYear(), m: d.getMonth() }; render(false); }
    else if (b.dataset.h) { S.inicio = Number(b.dataset.h); render(false); const sel = $('.slot[aria-pressed="true"]'); if (sel) sel.focus(); }
    else if (b.dataset.acao) acao(b.dataset.acao);
  });
  $('#rodape').addEventListener('click', (e) => { const b = e.target.closest('button[data-acao]'); if (b) acao(b.dataset.acao); });
  $('#tela').addEventListener('input', (e) => {
    if (e.target.id === 'whats') { e.target.value = mascara(e.target.value); S.whats = e.target.value; limparErro('whats', !erroWhats(S.whats)); }
    if (e.target.id === 'nome') { S.nome = e.target.value; limparErro('nome', !erroNome(S.nome)); }
  });
  $('#tela').addEventListener('submit', (e) => { e.preventDefault(); acao('continuar'); });

  function erroNome(v) {
    const n = v.trim().replace(/\s+/g, ' ');
    if (!n) return 'Digite seu nome.';
    if (!/\S+\s+\S+/.test(n)) return 'Digite também o sobrenome (ex.: João Silva).';
    if (n.length < 3) return 'Nome muito curto.';
    return '';
  }
  function erroWhats(v) {
    const d = v.replace(/\D/g, '');
    if (!d) return 'Digite seu WhatsApp.';
    if (d.length < 10) return 'Faltam números. Inclua o DDD: (11)98765-4321.';
    if (!whatsValido(d)) return 'Confira o número: celular tem 11 dígitos com DDD e começa com 9.';
    return '';
  }
  function validarDados() {
    const er = {};
    const n = erroNome(S.nome), w = erroWhats(S.whats);
    if (n) er.nome = n;
    if (w) er.whats = w;
    S.erros = er;
    return !Object.keys(er).length;
  }
  /** Remove a mensagem de erro assim que o campo fica correto, sem redesenhar a tela. */
  function limparErro(campo, valido) {
    if (!S.erros[campo] || !valido) return;
    delete S.erros[campo];
    const msg = $(campo === 'nome' ? '#e-nome' : '#e-whats'); if (msg) msg.textContent = '';
    const inp = $(campo === 'nome' ? '#nome' : '#whats'); if (inp) inp.removeAttribute('aria-invalid');
  }

  async function acao(a) {
    if (a === 'continuar') {
      if (S.etapa === 4) { if (!validarDados()) { render(false); const el = $('[aria-invalid="true"]'); if (el) el.focus(); return; } }
      return ir(S.etapa + 1);
    }
    if (a === 'recarregar') return carregarHorarios();
    if (a === 'novo') { location.href = 'agendamento.html'; return; }
    if (a === 'ics') return baixarIcs(S.resultado);
    if (a === 'confirmar') return confirmar();
  }

  async function confirmar() {
    if (S.enviando) return;
    S.enviando = true; S.alerta = null; render(false);
    try {
      const r = await Api.agendar({
        data: S.data,
        inicio_min: S.inicio,
        servico_ids: [...S.ids],
        nome: BJ.nome(S.nome),
        whatsapp: S.whats.replace(/\D/g, ''),
      });
      S.enviando = false;
      if (r.ok) { $('#toast').hidden = true; S.resultado = r.agendamento; history.replaceState({ etapa: 6 }, ''); S.etapa = 6; render(true); return; }
      if (CONFLITOS.includes(r.erro)) { // horário perdeu a disponibilidade: volta e atualiza a lista
        S.inicio = null;
        toast(BJ.mensagemErro(r.erro));
        S.etapa = 3; history.pushState({ etapa: 3 }, ''); carregarHorarios(); render(true);
        return;
      }
      S.alerta = BJ.mensagemErro(r.erro);
    } catch (e) {
      S.enviando = false;
      S.alerta = BJ.mensagemErro(e.codigo);
    }
    render(false);
  }

  /* ----------------------------------------------------------------- início */
  (async function iniciar() {
    try {
      S.site = await Api.carregarSite();
    } catch {
      $('#tela').innerHTML = '<div class="vazio-msg">Não foi possível carregar o agendamento.<br><button class="btn btn--sm" style="margin-top:12px" onclick="location.reload()">Tentar novamente</button></div>';
      return;
    }
    BJ.aplicarConfig(S.site.config);
    if (S.site.offline) {
      $('#stepper').hidden = true;
      $('#tela').innerHTML = `<div class="vazio-msg"><b>O agendamento online estará disponível em breve.</b><br>Por enquanto, marque seu horário direto com a gente pelo WhatsApp.<div class="acoes"><a class="btn btn--solid" href="${esc(BJ.waLink(S.site.config))}" target="_blank" rel="noopener">Falar pelo WhatsApp</a></div>${['localhost', '127.0.0.1'].includes(location.hostname) || /^192.168./.test(location.hostname) ? '<p style="margin-top:14px;font-size:12px">(Desenvolvimento: inicie <code>node server.js</code> ou configure o Supabase em js/config.js.)</p>' : ''}</div>`;
      return;
    }
    const q = new URLSearchParams(location.search);
    const sv = Number(q.get('servico')), cb = Number(q.get('combo'));
    if (sv && S.site.servicos.some((s) => s.id === sv)) S.ids.add(sv);
    const combo = cb && S.site.combos.find((c) => c.id === cb);
    if (combo) combo.servico_ids.forEach((id) => { if (S.site.servicos.some((s) => s.id === id)) S.ids.add(id); });
    history.replaceState({ etapa: 1 }, '');
    render(false);
  })();
})();
