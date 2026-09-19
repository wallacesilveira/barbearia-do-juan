/*
 * Regras de preço, combos e disponibilidade.
 * Mesmo arquivo usado no navegador (para mostrar os horários) e no servidor local
 * (para VALIDAR a reserva). No Supabase a mesma regra existe em SQL (supabase/schema.sql).
 * Todos os horários são inteiros: minutos desde 00:00 (ex.: 14:30 = 870).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BJAvail = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DIAS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
  const DIAS_CURTOS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

  const pad = (n) => String(n).padStart(2, '0');

  function toMin(hhmm) {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
  }
  function fmtMin(min) {
    if (min >= 1440) return '24:00';
    return pad(Math.floor(min / 60)) + ':' + pad(min % 60);
  }
  function fmtDur(min) {
    const h = Math.floor(min / 60), m = min % 60;
    if (!h) return m + ' min';
    return m ? h + 'h ' + pad(m) + 'min' : h + 'h';
  }
  function fmtBRL(v) {
    return 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: Number(v) % 1 ? 2 : 0, maximumFractionDigits: 2 });
  }
  function fmtData(iso) {
    const [y, m, d] = iso.split('-');
    return d + '/' + m + '/' + y;
  }
  function isoDate(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function weekday(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  }
  function addDays(iso, n) {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + n));
    return dt.getUTCFullYear() + '-' + pad(dt.getUTCMonth() + 1) + '-' + pad(dt.getUTCDate());
  }
  const overlap = (a, b) => a.ini < b.fim && b.ini < a.fim;

  /**
   * Calcula duração e valor. Se todos os serviços de um combo ativo estiverem selecionados,
   * o preço do combo substitui a soma individual (ex.: Corte 40 + Barba 40 => combo 70).
   * Combos com mais serviços têm prioridade; um serviço só entra em um combo.
   */
  function calcPricing(ids, servicos, combos) {
    const sel = servicos.filter((s) => ids.includes(s.id));
    const restante = new Set(sel.map((s) => s.id));
    const usaveis = (combos || [])
      .filter((c) => c.ativo !== false && c.servico_ids && c.servico_ids.length > 0)
      .sort((a, b) => b.servico_ids.length - a.servico_ids.length || a.id - b.id);
    const linhas = [];
    let total = 0, duracao = 0, consulta = false, economia = 0;

    for (const c of usaveis) {
      if (!c.servico_ids.every((id) => restante.has(id))) continue;
      const partes = servicos.filter((s) => c.servico_ids.includes(s.id));
      const dur = c.duracao_min != null ? Number(c.duracao_min) : partes.reduce((a, s) => a + s.duracao_min, 0);
      if (partes.every((s) => s.preco != null)) {
        economia += Math.max(0, partes.reduce((a, s) => a + Number(s.preco), 0) - Number(c.preco));
      }
      total += Number(c.preco);
      duracao += dur;
      c.servico_ids.forEach((id) => restante.delete(id));
      linhas.push({ tipo: 'combo', id: c.id, nome: c.nome, preco: Number(c.preco), duracao_min: dur, ids: [...c.servico_ids] });
    }
    for (const s of sel) {
      if (!restante.has(s.id)) continue;
      duracao += s.duracao_min;
      if (s.preco == null) consulta = true; else total += Number(s.preco);
      linhas.push({ tipo: 'servico', id: s.id, nome: s.nome, preco: s.preco == null ? null : Number(s.preco), duracao_min: s.duracao_min, ids: [s.id] });
    }
    return { linhas, total: Math.round(total * 100) / 100, duracao, consulta, economia };
  }

  function janelaDoDia(iso, horarios) {
    const h = (horarios || []).find((x) => Number(x.dia_semana) === weekday(iso));
    if (!h || !h.ativo) return null;
    return { ini: Number(h.inicio_min), fim: Number(h.fim_min) };
  }

  function almoco(config) {
    if (!config || String(config.almoco_ativo) !== '1') return null;
    const ini = toMin(config.almoco_inicio), fim = toMin(config.almoco_fim);
    return isNaN(ini) || isNaN(fim) || fim <= ini ? null : { ini, fim };
  }

  /** Intervalos que não podem receber atendimento no dia (almoço, bloqueios, agendamentos). */
  function proibidos(iso, config, bloqueios, ocupados) {
    const lista = [];
    const a = almoco(config);
    if (a) lista.push({ ...a, tipo: 'almoco' });
    (bloqueios || []).filter((b) => b.data === iso).forEach((b) => lista.push({ ini: Number(b.inicio_min), fim: Number(b.fim_min), tipo: 'bloqueio' }));
    (ocupados || []).forEach((o) => lista.push({ ini: Number(o.ini), fim: Number(o.fim), tipo: 'ocupado' }));
    return lista;
  }

  /**
   * Verifica um início específico. Retorna { ok:true } ou { ok:false, motivo }.
   * agora = { data:'YYYY-MM-DD', min:number } no fuso da barbearia.
   */
  function validarHorario(o) {
    const { data, inicio_min, duracao, horarios, config, bloqueios, ocupados, agora } = o;
    const janela = janelaDoDia(data, horarios);
    if (!janela) return { ok: false, motivo: 'FECHADO' };
    if (!(duracao > 0)) return { ok: false, motivo: 'DURACAO_INVALIDA' };
    const fim = inicio_min + duracao;
    if (inicio_min < janela.ini || fim > janela.fim) return { ok: false, motivo: 'FORA_DO_EXPEDIENTE' };
    if (agora) {
      const antec = Number((config && config.antecedencia_min) || 0);
      if (data < agora.data) return { ok: false, motivo: 'PASSADO' };
      if (data === agora.data && inicio_min < agora.min + antec) return { ok: false, motivo: 'PASSADO' };
      const maxDias = Number((config && config.dias_agenda) || 60);
      if (data > addDays(agora.data, maxDias)) return { ok: false, motivo: 'MUITO_LONGE' };
    }
    const alvo = { ini: inicio_min, fim };
    for (const p of proibidos(data, config, bloqueios, ocupados)) {
      if (overlap(alvo, p)) {
        return { ok: false, motivo: p.tipo === 'almoco' ? 'ALMOCO' : p.tipo === 'bloqueio' ? 'BLOQUEADO' : 'HORARIO_OCUPADO' };
      }
    }
    return { ok: true };
  }

  /**
   * Lista os horários candidatos do dia, cada um marcado como livre ou não.
   * Candidatos: grade regular (passo_min) + o instante em que termina cada atendimento/almoço/bloqueio,
   * para não desperdiçar tempo (ex.: ocupado até 15:10 => 15:10 é oferecido).
   */
  function gerarHorarios(o) {
    const { data, duracao, horarios, config } = o;
    const janela = janelaDoDia(data, horarios);
    if (!janela || !(duracao > 0)) return [];
    const passo = Math.max(5, Number((config && config.passo_min) || 20));
    const cand = new Set();
    for (let t = janela.ini; t + duracao <= janela.fim; t += passo) cand.add(t);
    proibidos(data, config, o.bloqueios, o.ocupados).forEach((p) => {
      if (p.fim > janela.ini && p.fim + duracao <= janela.fim) cand.add(p.fim);
    });
    return [...cand].sort((a, b) => a - b).map((t) => {
      const r = validarHorario({ ...o, inicio_min: t });
      return { inicio_min: t, livre: r.ok, motivo: r.motivo || null };
    });
  }

  return { DIAS, DIAS_CURTOS, MESES, toMin, fmtMin, fmtDur, fmtBRL, fmtData, isoDate, weekday, addDays, calcPricing, janelaDoDia, almoco, validarHorario, gerarHorarios };
});
