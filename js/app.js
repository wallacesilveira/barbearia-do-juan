/* Página inicial: menu, conteúdo dinâmico (serviços, combos, galeria) e animações discretas. */
(function () {
  'use strict';
  const A = window.BJAvail;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = BJ.esc;

  BJIcons.hydrate();
  const liUrl = (window.BJ_CONFIG || {}).linkedinUrl || '', liA = $('#credito-link');
  if (liUrl.startsWith('https://www.linkedin.com/') || liUrl.startsWith('https://linkedin.com/') || liUrl.startsWith('https://br.linkedin.com/')) liA.href = liUrl; else { liA.removeAttribute('href'); liA.style.textDecoration = 'none'; }
  $('#ano-atual').textContent = new Date().getFullYear();

  /* ---- menu mobile */
  const menu = $('#menu'), btn = $('#menu-btn');
  const fechar = () => { menu.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-label', 'Abrir menu'); };
  btn.addEventListener('click', () => {
    const abrir = !menu.classList.contains('open');
    menu.classList.toggle('open', abrir);
    btn.setAttribute('aria-expanded', String(abrir));
    btn.setAttribute('aria-label', abrir ? 'Fechar menu' : 'Abrir menu');
  });
  menu.addEventListener('click', (e) => { if (e.target.closest('a')) fechar(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fechar(); });

  /* ---- item de menu ativo conforme a rolagem */
  const links = [...menu.querySelectorAll('a')];
  const alvos = links.map((a) => $(a.getAttribute('href')));
  const obs = new IntersectionObserver((ents) => {
    ents.forEach((en) => {
      if (!en.isIntersecting) return;
      links.forEach((l) => l.removeAttribute('aria-current'));
      const i = alvos.indexOf(en.target);
      if (i > -1) links[i].setAttribute('aria-current', 'true');
    });
  }, { rootMargin: '-45% 0px -50% 0px' });
  alvos.forEach((t) => t && obs.observe(t));

  /* ---- renderização */
  function cardServico(s) {
    const foto = BJ.src(s.foto);
    return `<a class="card-s" href="agendamento.html?servico=${s.id}" aria-label="Agendar ${esc(s.nome)}">
      <div class="card-s__foto">${foto ? `<img src="${esc(foto)}" alt="${esc(s.nome)}" loading="lazy">` : ''}</div>
      <div class="card-s__body">
        <div class="card-s__nome">${esc(s.nome)}</div>
        <div class="card-s__dur">${BJIcons.svg('clock')}${s.duracao_min} min</div>
        <div class="card-s__preco${s.preco == null ? ' consulta' : ''}">${esc(BJ.preco(s))}</div>
      </div></a>`;
  }
  function cardCombo(c, servicos) {
    const partes = servicos.filter((s) => c.servico_ids.includes(s.id));
    if (!partes.length) return '';
    const dur = c.duracao_min != null ? c.duracao_min : partes.reduce((a, s) => a + s.duracao_min, 0);
    const foto = BJ.src(c.foto);
    return `<article class="card-c">
      ${foto ? `<div class="card-c__foto" aria-hidden="true"><img src="${esc(foto)}" alt="" loading="lazy"></div>` : ''}
      <h3>${esc(c.nome)}</h3>
      ${c.descricao ? `<p class="card-c__desc">${esc(c.descricao)}</p>` : ''}
      <div class="card-c__dur">${BJIcons.svg('clock')}${dur} min</div>
      <div class="card-c__preco">${A.fmtBRL(c.preco)}</div>
      <a class="btn btn--white btn--sm" href="agendamento.html?combo=${c.id}">Agendar agora</a>
    </article>`;
  }

  let galeria = [];
  function desenharGaleria() {
    const grid = $('#galeria-grid');
    const lista = galeria.slice(0, 8);
    grid.innerHTML = lista.map((g, i) => `<button type="button" class="galeria__item" data-i="${i}" aria-label="Ampliar foto ${i + 1}"><img src="${esc(BJ.src(g.foto))}" alt="${esc(g.legenda || 'Trabalho da barbearia')}" loading="lazy"></button>`).join('');
    if (!galeria.length) grid.innerHTML = '<p class="aviso">Em breve, novas fotos.</p>';
  }
  const lb = $('#lightbox');
  $('#galeria-grid').addEventListener('click', (e) => {
    const b = e.target.closest('.galeria__item');
    if (!b) return;
    const g = galeria[Number(b.dataset.i)];
    $('#lightbox-img').src = BJ.src(g.foto);
    $('#lightbox-img').alt = g.legenda || 'Trabalho da barbearia';
    if (lb.showModal) lb.showModal();
  });
  $('#lightbox-close').addEventListener('click', () => lb.close());
  lb.addEventListener('click', (e) => { if (e.target === lb) lb.close(); });

  async function carregar() {
    const lista = $('#servicos-lista');
    try {
      const d = await Api.carregarSite();
      BJ.aplicarConfig(d.config);
      const desde = Number(d.config.desde);
      if (desde) $('#anos').textContent = (new Date().getFullYear() - desde) + ' anos';
      lista.innerHTML = d.servicos.length ? d.servicos.map(cardServico).join('') : '<p class="aviso">Serviços em breve.</p>';
      $('#combos-lista').innerHTML = d.combos.map((c) => cardCombo(c, d.servicos)).join('');
      galeria = d.galeria.filter((g) => BJ.src(g.foto));
      desenharGaleria();
    } catch {
      lista.innerHTML = '<p class="aviso">Não foi possível carregar os serviços. <button type="button" id="tentar">Tentar novamente</button></p>';
      $('#tentar').addEventListener('click', carregar);
      $('#galeria-grid').innerHTML = '';
    }
  }
  carregar();

  /* ---- entrada suave (discreta) */
  if ('IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: .08 });
    document.querySelectorAll('.section-head, .cta__col, .sobre__txt').forEach((el) => { el.classList.add('reveal'); io.observe(el); });
  }
})();
