/*
 * Camada de dados. Duas implementações com a MESMA interface:
 *   - Local:    API do server.js (SQLite)
 *   - Supabase: PostgREST + RPC + Auth via fetch (sem SDK)
 * O restante do site só conhece window.BJ (helpers) e window.Api.
 */
(function () {
  'use strict';
  const cfg = window.BJ_CONFIG || {};
  const usaSupabase = !!(cfg.supabaseUrl && cfg.supabaseKey);
  const TOKEN_KEY = 'bj_admin_token';

  const guardar = {
    get() { try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; } },
    set(v) { try { v ? sessionStorage.setItem(TOKEN_KEY, v) : sessionStorage.removeItem(TOKEN_KEY); } catch { /* sem storage */ } },
  };

  class ApiError extends Error {
    constructor(status, codigo, msg) { super(msg || codigo); this.status = status; this.codigo = codigo; }
  }

  async function pedir(url, opts = {}) {
    let resp;
    try { resp = await fetch(url, opts); } catch { throw new ApiError(0, 'REDE', 'Sem conexão com o servidor.'); }
    let corpo = null;
    try { corpo = await resp.json(); } catch { /* corpo vazio */ }
    if (!resp.ok) {
      const cod = (corpo && (corpo.erro || corpo.code || corpo.error_code)) || 'HTTP_' + resp.status;
      throw new ApiError(resp.status, cod, (corpo && (corpo.mensagem || corpo.message || corpo.msg || corpo.error_description)) || cod);
    }
    return corpo;
  }

  /* ----------------------------------------------------------------- local */
  const Local = {
    nome: 'local',
    _h(json) {
      const h = {};
      if (json) h['Content-Type'] = 'application/json';
      const t = guardar.get();
      if (t) h.Authorization = 'Bearer ' + t;
      return h;
    },
    _post(rota, corpo) { return pedir('/api/' + rota, { method: 'POST', headers: this._h(true), body: JSON.stringify(corpo || {}) }); },
    _get(rota) { return pedir('/api/' + rota, { headers: this._h() }); },

    async carregarSite() {
      try { return await this._get('site'); } catch (e) {
        // sem servidor (ex.: arquivo aberto direto): mostra o conteúdo padrão; agendar exige o servidor
        if (window.BJ_DEFAULT_SITE && [0, 404, 405, 501].includes(e.status)) return { ...window.BJ_DEFAULT_SITE, offline: true };
        throw e;
      }
    },
    indisponiveis(data) { return this._get('indisponiveis?data=' + data); },
    async agendar(dados) {
      try { return await this._post('agendar', dados); } catch (e) {
        if (e.status === 409 || e.codigo === 'DADOS_INVALIDOS') return { ok: false, erro: e.codigo };
        throw e;
      }
    },

    async entrar(usuario, senha) { const r = await this._post('admin/login', { usuario, senha }); guardar.set(r.token); },
    async sair() { try { await this._post('admin/logout'); } catch { /* ignora */ } guardar.set(null); },
    logado() { return !!guardar.get(); },
    carregarAdmin() { return this._get('admin/site'); },
    agendamentos(de, ate) { return this._get(`admin/agendamentos?de=${de}&ate=${ate}`); },
    cancelar(id) { return this._post('admin/cancelar', { id }); },
    salvar(tabela, linha) { return this._post('admin/salvar/' + tabela, linha); },
    excluir(tabela, id) { return this._post('admin/excluir/' + tabela, { id }); },
    salvarConfig(obj) { return this._post('admin/config', obj); },
    comboServicos(comboId, ids) { return this._post('admin/combo-servicos', { combo_id: comboId, servico_ids: ids }); },
  };

  /* -------------------------------------------------------------- Supabase */
  const Supa = {
    nome: 'supabase',
    _h(extra) {
      return { apikey: cfg.supabaseKey, Authorization: 'Bearer ' + (guardar.get() || cfg.supabaseKey), 'Content-Type': 'application/json', ...extra };
    },
    _rest(caminho, opts = {}) {
      return pedir(cfg.supabaseUrl + '/rest/v1/' + caminho, { ...opts, headers: this._h(opts.headers) }).catch((e) => {
        if (e.status === 401 && guardar.get()) { guardar.set(null); window.dispatchEvent(new Event('bj:sessao-expirada')); }
        throw e;
      });
    },
    _rpc(nome, args) { return this._rest('rpc/' + nome, { method: 'POST', body: JSON.stringify(args) }); },

    async _site(admin) {
      const filtro = admin ? '' : '&ativo=eq.true';
      const [conf, servicos, combos, horarios, galeria] = await Promise.all([
        this._rest('configuracoes?select=chave,valor'),
        this._rest('servicos?select=*&order=ordem,id' + filtro),
        this._rest('combos?select=*,combo_servicos(servico_id)&order=ordem,id' + filtro),
        this._rest('horarios_funcionamento?select=*&order=dia_semana'),
        this._rest('galeria?select=*&order=ordem,id' + filtro),
      ]);
      const out = {
        config: Object.fromEntries(conf.map((r) => [r.chave, r.valor])),
        servicos, horarios, galeria,
        combos: combos.map(({ combo_servicos, ...c }) => ({ ...c, servico_ids: combo_servicos.map((x) => x.servico_id) })),
      };
      if (admin) out.bloqueios = await this._rest('bloqueios?select=*&order=data,inicio_min');
      return out;
    },
    carregarSite() { return this._site(false); },
    carregarAdmin() { return this._site(true); },
    indisponiveis(data) { return this._rpc('get_indisponiveis', { p_data: data }); },
    async agendar(d) {
      return this._rpc('criar_agendamento', { p_data: d.data, p_inicio_min: d.inicio_min, p_servico_ids: d.servico_ids, p_nome: d.nome, p_whatsapp: d.whatsapp });
    },

    async entrar(email, senha) {
      const r = await pedir(cfg.supabaseUrl + '/auth/v1/token?grant_type=password', {
        method: 'POST', headers: { apikey: cfg.supabaseKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: senha }),
      }).catch((e) => { throw new ApiError(e.status === 400 ? 401 : e.status, 'CREDENCIAIS', 'E-mail ou senha incorretos.'); });
      guardar.set(r.access_token);
      try { // precisa estar na tabela usuarios_admin
        const eu = await this._rest('usuarios_admin?select=user_id');
        if (!eu.length) throw new ApiError(403, 'SEM_PERMISSAO', 'Este usuário não é administrador.');
      } catch (e) { guardar.set(null); throw e; }
    },
    async sair() { guardar.set(null); },
    logado() { return !!guardar.get(); },
    agendamentos(de, ate) {
      return this._rest(`agendamentos?select=*,clientes(nome,whatsapp),agendamento_servicos(nome,duracao_min,preco)&data=gte.${de}&data=lte.${ate}&order=data,inicio_min`)
        .then((l) => l.map(({ clientes, agendamento_servicos, cliente_id, ...a }) => ({ ...a, cliente: clientes, servicos: agendamento_servicos })));
    },
    cancelar(id) { return this._rest('agendamentos?id=eq.' + id, { method: 'PATCH', body: JSON.stringify({ status: 'cancelado' }) }); },
    async salvar(tabela, linha) {
      const { id, ...resto } = linha;
      let r;
      if (tabela === 'horarios_funcionamento') {
        r = await this._rest('horarios_funcionamento?on_conflict=dia_semana', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify(linha) });
      } else if (id) {
        r = await this._rest(`${tabela}?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(resto) });
      } else {
        r = await this._rest(tabela, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(resto) });
      }
      return r[0];
    },
    excluir(tabela, id) {
      const pk = tabela === 'horarios_funcionamento' ? 'dia_semana' : 'id';
      return this._rest(`${tabela}?${pk}=eq.${id}`, { method: 'DELETE' });
    },
    salvarConfig(obj) {
      const linhas = Object.entries(obj).map(([chave, valor]) => ({ chave, valor: String(valor ?? '') }));
      return this._rest('configuracoes?on_conflict=chave', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify(linhas) });
    },
    async comboServicos(comboId, ids) {
      await this._rest('combo_servicos?combo_id=eq.' + comboId, { method: 'DELETE' });
      if (ids.length) await this._rest('combo_servicos', { method: 'POST', body: JSON.stringify(ids.map((s) => ({ combo_id: comboId, servico_id: s }))) });
    },
  };

  window.Api = usaSupabase ? Supa : Local;
  window.ApiError = ApiError;

  /* --------------------------------------------------------------- helpers */
  const A = window.BJAvail;
  window.BJ = {
    esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },
    /** Aceita só caminhos relativos do site ou data:image/. Bloqueia javascript: e outros esquemas. */
    src(u) {
      u = String(u || '');
      return /^(data:image\/(png|jpe?g|webp|gif);base64,|https?:\/\/|assets\/|\/assets\/)/i.test(u) ? u : '';
    },
    waLink(cfgSite, msg) {
      const num = String((cfgSite && cfgSite.whatsapp) || '5511988118988').replace(/\D/g, '');
      return 'https://wa.me/' + num + '?text=' + encodeURIComponent(msg || (cfgSite && cfgSite.whatsapp_msg) || 'Olá, Juan! Vim pelo site da Barbearia do Juan e gostaria de agendar um horário. Pode me ajudar?');
    },
    preco(s) { return s.preco == null ? 'Sob consulta' : A.fmtBRL(s.preco); },
    /** Preenche textos/links marcados com data-cfg, data-cfg-src, data-wa, data-tel, data-insta, data-logo. */
    aplicarConfig(c) {
      document.querySelectorAll('[data-cfg]').forEach((el) => { if (c[el.dataset.cfg]) el.textContent = c[el.dataset.cfg]; });
      document.querySelectorAll('[data-cfg-src]').forEach((el) => { const u = BJ.src(c[el.dataset.cfgSrc]); if (u) el.src = u; });
      document.querySelectorAll('[data-wa]').forEach((el) => { el.href = BJ.waLink(c); });
      document.querySelectorAll('[data-maps]').forEach((el) => { if (c.endereco) el.href = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(c.endereco); });
      document.querySelectorAll('[data-tel]').forEach((el) => { if (c.telefone) el.href = 'tel:+55' + c.telefone.replace(/\D/g, '').replace(/^55/, ''); });
      document.querySelectorAll('[data-insta]').forEach((el) => { if (/^https:\/\/(www\.)?instagram\.com\//.test(c.instagram_url || '')) el.href = c.instagram_url; });
      const logo = BJ.src(c.logo);
      if (logo && c.logo !== 'assets/logo/logo-720.png') document.querySelectorAll('img[data-logo]').forEach((el) => { el.src = logo; });
      if (c.nome) document.title = document.title.replace(/^[^—]+/, c.nome + ' ');
    },
    mensagemErro(codigo) {
      return ({
        HORARIO_OCUPADO: 'Este horário acabou de ser reservado. Escolha outro horário.',
        ALMOCO: 'Este horário conflita com o intervalo de almoço. Escolha outro horário.',
        BLOQUEADO: 'Este horário não está disponível. Escolha outro horário.',
        FORA_DO_EXPEDIENTE: 'O atendimento não cabe no expediente deste horário. Escolha outro horário.',
        FECHADO: 'A barbearia não atende neste dia. Escolha outra data.',
        PASSADO: 'Este horário já passou. Escolha outro horário.',
        MUITO_LONGE: 'Esta data ainda não está aberta para agendamento.',
        SERVICO_INVALIDO: 'Algum serviço selecionado não está mais disponível. Recomece o agendamento.',
        DADOS_INVALIDOS: 'Confira seu nome e WhatsApp.',
        REDE: 'Sem conexão com o servidor. Tente novamente.',
      })[codigo] || 'Não foi possível concluir. Tente novamente.';
    },
    /** Redimensiona uma imagem escolhida e devolve data URL (guardada no banco). */
    lerImagem(arquivo, { max = 1000, png = false } = {}) {
      return new Promise((ok, no) => {
        if (!arquivo || !/^image\//.test(arquivo.type)) return no(new Error('Escolha um arquivo de imagem.'));
        const url = URL.createObjectURL(arquivo);
        const img = new Image();
        img.onload = () => {
          const k = Math.min(1, max / Math.max(img.width, img.height));
          const c = document.createElement('canvas');
          c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
          const g = c.getContext('2d');
          if (!png) { g.fillStyle = '#111'; g.fillRect(0, 0, c.width, c.height); }
          g.drawImage(img, 0, 0, c.width, c.height);
          URL.revokeObjectURL(url);
          ok(png ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.82));
        };
        img.onerror = () => { URL.revokeObjectURL(url); no(new Error('Não foi possível ler a imagem.')); };
        img.src = url;
      });
    },
  };
})();
