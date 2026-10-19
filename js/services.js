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
    agendarAdmin(dados) { return this._post('admin/agendar', dados); },
    reagendar(id, data, inicioMin) { return this._post('admin/reagendar', { id, data, inicio_min: inicioMin }); },

    async entrar(usuario, senha) { const r = await this._post('admin/login', { usuario, senha }); guardar.set(r.token); },
    async sair() { try { await this._post('admin/logout'); } catch { /* ignora */ } guardar.set(null); },
    logado() { return !!guardar.get(); },
    carregarAdmin() { return this._get('admin/site'); },
    clientes() { return this._get('admin/clientes'); },
    /** dados = { nome, whatsapp, email, aniversario } — id null cria um cliente novo. */
    salvarCliente(id, dados) { return this._post('admin/cliente', { id, ...dados }); },
    caixa() { return this._get('admin/indicadores'); },
    alertas() { return this._get('admin/alertas'); },
    marcarAlertasLidos(ids) { return this._post('admin/alertas/lidos', { ids: ids || [] }); },
    caixaDiario(data) { return this._get('admin/caixa-diario?data=' + data); },
    abrirCaixa(data, valor, observacao) { return this._post('admin/caixa-diario/abrir', { data, valor_abertura: valor, observacao }); },
    fecharCaixa(data, valor) { return this._post('admin/caixa-diario/fechar', { data, valor_contado: valor }); },
    /** tipo: 'sangria' | 'despesa' | 'reforco' — sempre no caixa de hoje. */
    movimentoCaixa(tipo, valor, forma, descricao) { return this._post('admin/caixa-movimento', { tipo, valor, forma, descricao }); },
    excluirMovimentoCaixa(id) { return this._post('admin/caixa-movimento/excluir', { id }); },
    vendasAvulsas(data) { return this._get('admin/vendas-avulsas?data=' + data); },
    vendaAvulsa(itens, forma, clienteId) { return this._post('admin/venda-avulsa', { itens, forma, cliente_id: clienteId || null }); },
    cancelarVendaAvulsa(id) { return this._post('admin/venda-avulsa/cancelar', { id }); },
    ajusteAgendamento(id, valor) { return this._post('admin/ajuste-agendamento', { id, valor_ajuste: valor }); },
    marcarLembreteEnviado(id) { return this._post('admin/lembrete-enviado', { id }); },
    registrarAberturaLembrete(id) { return this._post('admin/lembrete-aberto', { id }); },
    registrarRecebimento(id, valor, forma) { return this._post('admin/recebimento', { id, valor, forma }); },
    movimentarEstoque(produtoId, quantidade, tipo, motivo) { return this._post('admin/estoque', { produto_id: produtoId, quantidade, tipo, motivo }); },
    venderProduto(agendamentoId, produtoId, quantidade) { return this._post('admin/venda-produto', { agendamento_id: agendamentoId, produto_id: produtoId, quantidade }); },
    movimentosEstoque(produtoId) { return this._get('admin/movimentos-estoque?produto_id=' + produtoId); },
    agendamentos(de, ate) { return this._get(`admin/agendamentos?de=${de}&ate=${ate}`); },
    /** devolver = true lança estorno do que o cliente já pagou. */
    cancelar(id, devolver = false) { return this._post('admin/cancelar', { id, devolver }); },
    salvar(tabela, linha) { return this._post('admin/salvar/' + tabela, linha); },
    excluir(tabela, id) { return this._post('admin/excluir/' + tabela, { id }); },
    salvarConfig(obj) { return this._post('admin/config', obj); },
    comboServicos(comboId, ids) { return this._post('admin/combo-servicos', { combo_id: comboId, servico_ids: ids }); },
  };

  /* -------------------------------------------------------------- Supabase */
  // O token do Supabase vale ~1 h; guardamos o refresh_token para renovar sem pedir login de novo.
  const sessaoSupa = {
    get() { try { return JSON.parse(sessionStorage.getItem(TOKEN_KEY + '_supa') || 'null'); } catch { return null; } },
    set(s) { try { s ? sessionStorage.setItem(TOKEN_KEY + '_supa', JSON.stringify(s)) : sessionStorage.removeItem(TOKEN_KEY + '_supa'); } catch { /* sem storage */ } },
  };
  let renovando = null;
  async function renovarSessao() {
    const s = sessaoSupa.get();
    if (!s || !s.refresh) return false;
    if (Date.now() < s.expira - 120e3) return true; // ainda válido por mais de 2 min
    renovando = renovando || pedir(cfg.supabaseUrl + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', headers: { apikey: cfg.supabaseKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: s.refresh }),
    }).then((r) => { guardarSessaoSupa(r); return true; }).catch(() => false).finally(() => { renovando = null; });
    return renovando;
  }
  function guardarSessaoSupa(r) {
    guardar.set(r.access_token);
    sessaoSupa.set({ refresh: r.refresh_token, expira: Date.now() + (Number(r.expires_in) || 3600) * 1000 });
  }

  const Supa = {
    nome: 'supabase',
    _h(extra) {
      return { apikey: cfg.supabaseKey, Authorization: 'Bearer ' + (guardar.get() || cfg.supabaseKey), 'Content-Type': 'application/json', ...extra };
    },
    async _rest(caminho, opts = {}) {
      if (guardar.get()) await renovarSessao();
      return pedir(cfg.supabaseUrl + '/rest/v1/' + caminho, { ...opts, headers: this._h(opts.headers) }).catch((e) => {
        // só encerra a sessão quando o próprio JWT foi recusado (expirado/inválido)
        if (e.status === 401 && guardar.get() && /JWT|jwt|token/.test(e.message + e.codigo)) { guardar.set(null); sessaoSupa.set(null); window.dispatchEvent(new Event('bj:sessao-expirada')); }
        throw e;
      });
    },
    _rpc(nome, args) { return this._rest('rpc/' + nome, { method: 'POST', body: JSON.stringify(args) }); },

    async _site(admin) {
      const filtro = admin ? '' : '&ativo=eq.true';
      const [conf, servicos, combos, horarios, galeria, produtos] = await Promise.all([
        this._rest('configuracoes?select=chave,valor'),
        this._rest('servicos?select=*&order=ordem,id' + filtro),
        this._rest('combos?select=*,combo_servicos(servico_id)&order=ordem,id' + filtro),
        this._rest('horarios_funcionamento?select=*&order=dia_semana'),
        this._rest('galeria?select=*&order=ordem,id' + filtro),
        admin ? this._rest('produtos?select=*&order=nome') : Promise.resolve([]),
      ]);
      const out = {
        config: Object.fromEntries(conf.map((r) => [r.chave, r.valor])),
        servicos, horarios, galeria,
        combos: combos.map(({ combo_servicos, ...c }) => ({ ...c, servico_ids: combo_servicos.map((x) => x.servico_id) })),
      };
      if (admin) {
        out.bloqueios = await this._rest('bloqueios?select=*&order=data,inicio_min');
        out.produtos = produtos;
      }
      return out;
    },
    carregarSite() { return this._site(false); },
    carregarAdmin() { return this._site(true); },
    indisponiveis(data) { return this._rpc('get_indisponiveis', { p_data: data }); },
    async agendar(d) {
      return this._rpc('criar_agendamento', { p_data: d.data, p_inicio_min: d.inicio_min, p_servico_ids: d.servico_ids, p_nome: d.nome, p_whatsapp: d.whatsapp });
    },
    agendarAdmin(d) { return this._rpc('criar_agendamento_admin', { p_data: d.data, p_inicio_min: d.inicio_min, p_servico_ids: d.servico_ids, p_nome: d.nome, p_whatsapp: d.whatsapp || '' }); },
    reagendar(id, data, inicioMin) { return this._rpc('reagendar_agendamento', { p_id: id, p_data: data, p_inicio_min: inicioMin }); },

    async entrar(email, senha) {
      const r = await pedir(cfg.supabaseUrl + '/auth/v1/token?grant_type=password', {
        method: 'POST', headers: { apikey: cfg.supabaseKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: senha }),
      }).catch((e) => { throw new ApiError(e.status === 400 ? 401 : e.status, 'CREDENCIAIS', 'E-mail ou senha incorretos.'); });
      guardarSessaoSupa(r);
      try { // precisa estar na tabela usuarios_admin
        const eu = await this._rest('usuarios_admin?select=user_id');
        if (!eu.length) throw new ApiError(403, 'SEM_PERMISSAO', 'Este usuário não é administrador.');
      } catch (e) { guardar.set(null); sessaoSupa.set(null); throw e; }
    },
    async sair() {
      const t = guardar.get();
      guardar.set(null); sessaoSupa.set(null);
      if (t) pedir(cfg.supabaseUrl + '/auth/v1/logout', { method: 'POST', headers: { apikey: cfg.supabaseKey, Authorization: 'Bearer ' + t } }).catch(() => {});
    },
    logado() { return !!guardar.get(); },
    agendamentos(de, ate) {
      return this._rest(`agendamentos?select=*,clientes(nome,whatsapp),agendamento_servicos(nome,duracao_min,preco),agendamento_produtos(nome,quantidade,preco_unitario,valor_total),recebimentos_agendamento(id,valor,forma,recebido_em),estornos(id,valor,forma,criado_em),remarcacoes(id,data_anterior,inicio_anterior,data_nova,inicio_novo,criado_em)&remarcacoes.order=id&data=gte.${de}&data=lte.${ate}&order=data,inicio_min`)
        .then((l) => l.map(({ clientes, agendamento_servicos, agendamento_produtos, recebimentos_agendamento, estornos: est, remarcacoes, cliente_id, ...a }) => {
          const pagamentos = (recebimentos_agendamento || []).map((p) => ({ ...p, valor: Number(p.valor) }));
          const estornos = (est || []).map((e) => ({ ...e, valor: Number(e.valor) }));
          const totalPago = Math.round(pagamentos.reduce((s, p) => s + p.valor, 0) * 100) / 100;
          const produtos = (agendamento_produtos || []).map((p) => ({ ...p, preco_unitario: Number(p.preco_unitario), valor_total: Number(p.valor_total) }));
          return { ...a, valor_ajuste: Number(a.valor_ajuste || 0), valor_produtos: Number(a.valor_produtos || 0), cliente: clientes, servicos: agendamento_servicos, produtos, pagamentos, estornos, remarcacoes: remarcacoes || [], total_pago: totalPago, saldo_devedor: Math.max(0, Number(a.valor_total || 0) - totalPago) };
        }));
    },
    cancelar(id, devolver = false) { return this._rpc('cancelar_agendamento', { p_agendamento_id: id, p_devolver: devolver }); },
    async clientes() {
      const r = await this._rpc('clientes_resumo', {});
      return { ...r, clientes: r.clientes.map((c) => ({ ...c, total_gasto: Number(c.total_gasto) })) };
    },
    async salvarCliente(id, dados) {
      let wa = String(dados.whatsapp || '').replace(/\D/g, '');
      if (wa.length > 11 && wa.startsWith('55')) wa = wa.slice(2);
      const nome = window.BJ.nome(dados.nome);
      const email = String(dados.email || '').trim().toLowerCase();
      const aniversario = String(dados.aniversario || '').trim() || null;
      if (!nome || nome.length > 80 || (wa && wa.length !== 10 && wa.length !== 11)) throw new ApiError(400, 'DADOS_INVALIDOS', 'Confira o nome e o WhatsApp (DDD + número).');
      if (email && (email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new ApiError(400, 'EMAIL_INVALIDO', 'E-mail inválido. Ex.: nome@gmail.com');
      if (aniversario && (!/^\d{4}-\d{2}-\d{2}$/.test(aniversario) || aniversario < '1900-01-01' || aniversario > A.isoDate(new Date()))) throw new ApiError(400, 'ANIVERSARIO_INVALIDO', 'Data de aniversário inválida.');
      const outro = id ? `&id=neq.${Number(id)}` : '';
      if (wa && (await this._rest(`clientes?select=id&whatsapp=eq.${wa}${outro}`)).length) throw new ApiError(409, 'WHATSAPP_EM_USO', 'Já existe outro cliente com esse WhatsApp.');
      if (!wa && (await this._rest(`clientes?select=id&whatsapp=eq.&nome=ilike.${encodeURIComponent(nome.replace(/[%_*]/g, ''))}${outro}`)).length) throw new ApiError(409, 'CLIENTE_EXISTE', 'Já existe um cliente sem telefone com esse nome.');
      const gravar = (corpo) => (id
        ? this._rest('clientes?id=eq.' + Number(id), { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(corpo) })
        : this._rest('clientes', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(corpo) }));
      try {
        return (await gravar({ nome, whatsapp: wa, email, aniversario }))[0];
      } catch (e) {
        // banco ainda sem as colunas novas (SQL de e-mail/aniversário não rodado): salva o básico e avisa
        if (!/email|aniversario/.test(e.message) || !/column|coluna|schema/i.test(e.message)) throw e;
        const r = (await gravar({ nome, whatsapp: wa }))[0];
        if (email || aniversario) throw new ApiError(400, 'SEM_COLUNAS', 'Nome e WhatsApp salvos. E-mail e aniversário precisam de uma atualização no banco (Supabase).');
        return r;
      }
    },
    async alertas() {
      const [alertas, naoLidos] = await Promise.all([
        this._rest('alertas?select=*,agendamentos(codigo,data,inicio_min)&order=id.desc&limit=50'),
        this._rest('alertas?select=id&lido_em=is.null'),
      ]);
      return { nao_lidos: naoLidos.length, alertas: alertas.map(({ agendamentos, ...a }) => ({ ...a, ...(agendamentos || {}) })) };
    },
    async marcarAlertasLidos(ids) {
      const filtro = ids && ids.length ? `&id=in.(${ids.map(Number).join(',')})` : '';
      await this._rest('alertas?lido_em=is.null' + filtro, { method: 'PATCH', body: JSON.stringify({ lido_em: new Date().toISOString() }) });
      return this.alertas();
    },
    async salvar(tabela, linha) {
      const { id, ...resto } = linha;
      if (tabela === 'produtos' && !id) {
        return this._rpc('criar_produto', {
          p_nome: linha.nome, p_descricao: linha.descricao, p_preco: linha.preco,
          p_estoque_inicial: linha.estoque || 0, p_estoque_minimo: linha.estoque_minimo,
          p_ativo: linha.ativo,
        });
      }
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
    ajusteAgendamento(id, valor) { return this._rpc('ajustar_agendamento', { p_id: id, p_valor: valor }); },
    marcarLembreteEnviado(id) { return this._rpc('marcar_lembrete_enviado', { p_agendamento_id: id }); },
    registrarAberturaLembrete(id) { return this._rpc('registrar_abertura_lembrete', { p_agendamento_id: id }); },
    registrarRecebimento(id, valor, forma) { return this._rpc('registrar_recebimento', { p_agendamento_id: id, p_valor: valor, p_forma: forma }); },
    movimentarEstoque(produtoId, quantidade, tipo, motivo) { return this._rpc('movimentar_estoque', { p_produto_id: produtoId, p_quantidade: quantidade, p_tipo: tipo, p_motivo: motivo }); },
    venderProduto(agendamentoId, produtoId, quantidade) { return this._rpc('vender_produto_agendamento', { p_agendamento_id: agendamentoId, p_produto_id: produtoId, p_quantidade: quantidade }); },
    movimentosEstoque(produtoId) { return this._rest(`movimentos_estoque?select=id,quantidade,tipo,motivo,criado_em,agendamentos(codigo)&produto_id=eq.${produtoId}&order=criado_em.desc&limit=50`).then((l) => l.map((m) => ({ ...m, agendamento_codigo: m.agendamentos && m.agendamentos.codigo }))); },
    caixa() { return this._rpc('caixa_resumo', {}); },
    caixaDiario(data) { return this._rpc('caixa_diario_resumo', { p_data: data }); },
    abrirCaixa(data, valor, observacao) { return this._rpc('abrir_caixa_diario', { p_data: data, p_valor_abertura: valor, p_observacao: observacao }); },
    fecharCaixa(data, valor) { return this._rpc('fechar_caixa_diario', { p_data: data, p_valor_contado: valor }); },
    movimentoCaixa(tipo, valor, forma, descricao) { return this._rpc('registrar_movimento_caixa', { p_tipo: tipo, p_valor: valor, p_forma: forma || 'dinheiro', p_descricao: descricao || '' }); },
    excluirMovimentoCaixa(id) { return this._rpc('excluir_movimento_caixa', { p_id: id }); },
    vendasAvulsas(data) { return this._rpc('listar_vendas_avulsas', { p_data: data }); },
    vendaAvulsa(itens, forma, clienteId) { return this._rpc('registrar_venda_avulsa', { p_itens: itens, p_forma: forma, p_cliente_id: clienteId || null }); },
    cancelarVendaAvulsa(id) { return this._rpc('cancelar_venda_avulsa', { p_id: id }); },
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

  // Todo campo com data-mascara="tel" recebe a máscara de telefone enquanto se digita (fase de captura: roda antes dos outros ouvintes).
  document.addEventListener('input', (e) => {
    if (e.target.matches && e.target.matches('input[data-mascara="tel"]')) e.target.value = window.BJ.tel(e.target.value);
  }, true);
  window.ApiError = ApiError;

  /* --------------------------------------------------------------- helpers */
  const A = window.BJAvail;
  window.BJ = {
    esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },
    nome(s) {
      const particulas = new Set(['da', 'das', 'de', 'do', 'dos', 'e']);
      return String(s ?? '').trim().replace(/\s+/g, ' ').split(' ').map((palavra, indice) => {
        const minuscula = palavra.toLocaleLowerCase('pt-BR');
        if (indice > 0 && particulas.has(minuscula)) return minuscula;
        return palavra.split(/([-'])/).map((parte) => {
          if (parte === '-' || parte === "'") return parte;
          return parte ? parte.charAt(0).toLocaleUpperCase('pt-BR') + parte.slice(1).toLocaleLowerCase('pt-BR') : parte;
        }).join('');
      }).join(' ');
    },
    /** Máscara de telefone: (11)98765-4321 (celular) ou (11)3456-7890 (fixo). Remove o 55 do início se vier junto. */
    tel(v) {
      let d = String(v ?? '').replace(/\D/g, '');
      if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
      d = d.slice(0, 11);
      if (!d) return '';
      if (d.length <= 2) return '(' + d;
      const n = d[2] === '9' ? 5 : 4; // celular começa com 9 depois do DDD
      const fim = d.slice(2 + n);
      return '(' + d.slice(0, 2) + ')' + d.slice(2, 2 + n) + (fim ? '-' + fim : '');
    },
    /** Exibição: aplica a máscara só a números válidos (10/11 dígitos); números fora do padrão aparecem como estão, para serem corrigidos. */
    telExibir(v) {
      let d = String(v ?? '').replace(/\D/g, '');
      if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
      return d.length === 10 || d.length === 11 ? BJ.tel(d) : d;
    },
    /** Aceita só caminhos relativos do site ou data:image/. Bloqueia javascript: e outros esquemas. */
    src(u) {
      u = String(u || '');
      return /^(data:image\/(png|jpe?g|webp|gif);base64,|https?:\/\/|assets\/|\/assets\/)/i.test(u) ? u : '';
    },
    waLink(cfgSite, msg) {
      const num = String((cfgSite && cfgSite.whatsapp) || '5511988118988').replace(/\D/g, '');
      return 'https://wa.me/' + num + '?text=' + encodeURIComponent(msg || (cfgSite && cfgSite.whatsapp_msg) || 'Olá! Vim pelo site da Barbearia do Juan e gostaria de agendar um horário. Pode me ajudar?');
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
        MESMO_HORARIO: 'Escolha um horário diferente do atual.',
        AGENDAMENTO_CANCELADO: 'Este agendamento está cancelado.',
        AGENDAMENTO_NAO_ENCONTRADO: 'Agendamento não encontrado. Atualize a página.',
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
