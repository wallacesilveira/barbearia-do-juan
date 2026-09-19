/* Ícones de linha (SVG inline). Uso: <i data-icon="whatsapp"></i> + BJIcons.hydrate() ou BJIcons.svg('nome'). */
window.BJIcons = (function () {
  const P = {
    whatsapp: '<path d="M3 21l1.7-5.1A8.5 8.5 0 1 1 8 19.4L3 21z"/><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1-1.3-1.8-1-.9.7a3.6 3.6 0 0 1-1.7-1.7l.7-.9-1-1.8z"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.500 10h17M8 3v4M16 3v4"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 17.500h.01M12 17.500h.01"/>',
    pin: '<path d="M12 21s7-5.700 7-11.500a7 7 0 0 0-14 0C5 15.300 12 21 12 21z"/><circle cx="12" cy="9.500" r="2.500"/>',
    phone: '<path d="M5 4h3.500l1.800 4.500-2.300 1.500a11 11 0 0 0 6 6l1.500-2.300L20 15.500V19a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
    instagram: '<rect x="3.500" y="3.500" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="4"/><path d="M17.200 6.800h.01"/>',
    clock: '<circle cx="12" cy="12" r="8.500"/><path d="M12 7.500V12l3 2"/>',
    check: '<path d="M5 12.500l4.500 4.500L19 7.500"/>',
    'check-circle': '<circle cx="12" cy="12" r="9.5"/><path d="M8 12.3l3 3 5-5.5"/>',
    left: '<path d="M15 5l-7 7 7 7"/>',
    right: '<path d="M9 5l7 7-7 7"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    edit: '<path d="M4 20h4L19 9a2.800 2.800 0 0 0-4-4L4 16v4z"/><path d="M13.500 6.500l4 4"/>',
    trash: '<path d="M4 7h16M9 7V4.500h6V7M6.500 7l1 13h9l1-13M10 11v6M14 11v6"/>',
    home: '<path d="M4 11l8-6.500 8 6.500v9h-5v-6H9v6H4z"/>',
    list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
    tag: '<path d="M3.500 12.500V4.500h8L20 13l-7 7z"/><circle cx="8" cy="9" r="1.200"/>',
    layers: '<path d="M12 4l9 5-9 5-9-5z"/><path d="M3 14l9 5 9-5"/>',
    ban: '<circle cx="12" cy="12" r="8.500"/><path d="M6 6l12 12"/>',
    image: '<rect x="3.500" y="4.500" width="17" height="15" rx="2.500"/><circle cx="9" cy="10" r="1.700"/><path d="M4 18l5.500-5 4 3.500 3-2.500 4 3.500"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3.500v2.200M12 18.300v2.200M3.500 12h2.200M18.300 12h2.200M6 6l1.500 1.500M16.500 16.500L18 18M18 6l-1.500 1.500M7.500 16.500L6 18"/>',
    logout: '<path d="M14 4h4.500A1.500 1.500 0 0 1 20 5.500v13a1.500 1.500 0 0 1-1.500 1.500H14M10 8l-4 4 4 4M6 12h10"/>',
    user: '<circle cx="12" cy="8" r="3.500"/><path d="M5 20a7 7 0 0 1 14 0"/>',
    users: '<circle cx="9" cy="8.500" r="3.200"/><path d="M3 19.500a6 6 0 0 1 12 0M16 5.500a3.200 3.200 0 0 1 0 6M18 14a6 6 0 0 1 3 5.500"/>',
    scissors: '<circle cx="6" cy="6.500" r="2.500"/><circle cx="6" cy="17.500" r="2.500"/><path d="M8 8l12 9M8 16l12-9"/>',
    star: '<path d="M12 4l2.400 5 5.600.7-4.100 3.800 1.100 5.500L12 16.400 7 19l1.100-5.500L4 9.700 9.600 9z"/>',
    download: '<path d="M12 4v11M7.500 11l4.500 4.500 4.500-4.500M5 20h14"/>',
    eye: '<path d="M2.500 12S6 5.500 12 5.500 21.500 12 21.500 12 18 18.500 12 18.500 2.500 12 2.500 12z"/><circle cx="12" cy="12" r="3"/>',
  };
  const svg = (n, cls) => `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${P[n] || ''}</svg>`;
  function hydrate(root) {
    (root || document).querySelectorAll('i[data-icon]').forEach((el) => {
      el.outerHTML = svg(el.dataset.icon, el.className);
    });
  }
  return { svg, hydrate };
})();
