/*
 * Comissões, aluguel de cadeira e repasse aos barbeiros.
 * Mesmo arquivo usado no painel (para mostrar e fechar o período) e nos testes.
 * Cada atendimento usa o contrato que valia NA DATA dele: mudar a % hoje não altera o passado.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BJComissoes = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Barbeiro sem contrato cadastrado: comissão de 0% (tudo fica com a barbearia). */
  const PADRAO = { tipo: 'comissao', comissao_servicos: 0, comissao_produtos: 0, valor_fixo: 0, aluguel_valor: 0, aluguel_periodo: 'mes', recebimento: 'caixa' };
  const TIPOS = { dono: 'Dono / sócio', comissao: 'Comissão', aluguel: 'Aluguel de cadeira' };
  const c2 = (v) => Math.round(Number(v || 0) * 100) / 100;

  function addDays(iso, n) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }
  function diasNoMes(iso) {
    const [y, m] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  }
  /** Contrato do barbeiro que vale numa data (o mais recente com vigente_desde <= data). */
  function contratoEm(contratos, profissionalId, data) {
    let melhor = null;
    for (const c of contratos || []) {
      if (c.profissional_id !== profissionalId || String(c.vigente_desde).slice(0, 10) > data) continue;
      if (!melhor || String(c.vigente_desde) > String(melhor.vigente_desde)) melhor = c;
    }
    return melhor ? { ...PADRAO, ...melhor } : { ...PADRAO };
  }
  /** Parte do barbeiro num atendimento, pelo contrato. Dono: 0; comissão: %; aluguel: serviço inteiro + % dos produtos. */
  function parteDoAtendimento(c, servicos, produtos) {
    const pp = Number(c.comissao_produtos || 0) / 100;
    if (c.tipo === 'dono') return 0;
    if (c.tipo === 'aluguel') return servicos + produtos * pp;
    return servicos * (Number(c.comissao_servicos || 0) / 100) + produtos * pp;
  }

  /**
   * Repasse de um barbeiro no período [de, ate].
   * total > 0: a barbearia paga ao barbeiro; total < 0: o barbeiro deve à barbearia.
   * agendamentos: os do período (qualquer barbeiro, qualquer status) com pagamentos[{valor, recebido_por}].
   * vales: vales ainda não fechados do barbeiro (são descontados os com data <= ate).
   */
  function calcular({ profissionalId, contratos, agendamentos, vales, de, ate, hoje }) {
    const limite = hoje && hoje < ate ? hoje : ate; // atendimento futuro ainda não aconteceu
    const itens = (agendamentos || [])
      .filter((a) => a.status === 'confirmado' && a.profissional && a.profissional.id === profissionalId && a.data >= de && a.data <= limite)
      .sort((a, b) => a.data.localeCompare(b.data) || a.inicio_min - b.inicio_min)
      .map((a) => {
        const c = contratoEm(contratos, profissionalId, a.data);
        const produtos = c2(a.valor_produtos);
        const servicos = c2(Number(a.valor_total || 0) - produtos);
        const recebidoProf = c2((a.pagamentos || []).filter((p) => p.recebido_por === 'profissional').reduce((t, p) => t + Number(p.valor), 0));
        return {
          id: a.id, codigo: a.codigo, data: a.data, inicio_min: a.inicio_min,
          cliente: a.cliente ? a.cliente.nome : '', servicos_nomes: (a.servicos || []).map((s) => s.nome).join(' + '),
          tipo: c.tipo, servicos, produtos, parte: c2(parteDoAtendimento(c, servicos, produtos)),
          recebido_profissional: recebidoProf, pendente: Number(a.saldo_devedor || 0) > 0.004,
        };
      });
    // fixo (comissão + fixo) e aluguel são proporcionais aos dias do período, pelo contrato de cada dia
    let fixo = 0, aluguel = 0, dias = 0;
    for (let d = de; d <= ate && dias < 400; d = addDays(d, 1), dias++) {
      const c = contratoEm(contratos, profissionalId, d);
      if (c.tipo === 'comissao' && Number(c.valor_fixo) > 0) fixo += Number(c.valor_fixo) / diasNoMes(d);
      if (c.tipo === 'aluguel' && Number(c.aluguel_valor) > 0) aluguel += Number(c.aluguel_valor) / (c.aluguel_periodo === 'semana' ? 7 : diasNoMes(d));
    }
    const valesDoPeriodo = (vales || []).filter((v) => v.profissional_id === profissionalId && String(v.data).slice(0, 10) <= ate);
    const soma = (k) => c2(itens.reduce((t, i) => t + i[k], 0));
    const r = {
      profissional_id: profissionalId, de, ate, dias,
      contrato: contratoEm(contratos, profissionalId, ate),
      itens, atendimentos: itens.length, pendentes: itens.filter((i) => i.pendente).length,
      servicos: soma('servicos'), produtos: soma('produtos'), parte: soma('parte'), recebido_profissional: soma('recebido_profissional'),
      fixo: c2(fixo), aluguel: c2(aluguel),
      vales: c2(valesDoPeriodo.reduce((t, v) => t + Number(v.valor), 0)), vale_ids: valesDoPeriodo.map((v) => v.id),
    };
    r.total = c2(r.parte + r.fixo - r.aluguel - r.recebido_profissional - r.vales);
    return r;
  }

  /** Dois períodos [de, ate] se sobrepõem? (para não fechar o mesmo dia duas vezes) */
  const sobrepoe = (a, b) => a.de <= b.ate && b.de <= a.ate;

  return { PADRAO, TIPOS, contratoEm, parteDoAtendimento, calcular, sobrepoe, addDays, diasNoMes };
});
