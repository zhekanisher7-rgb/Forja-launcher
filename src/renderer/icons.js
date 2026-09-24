'use strict';
/* Simple original glyphs for profile icons (24×24, filled). No third-party art. */
window.FORJA_ICONS = {
  anvil: 'M2 6h14c0 2.6 2.2 3.8 6 4v1.2c-3.2.2-5.2 1.2-6 2.6V15h2v3.5H6V15h2v-1.2C4.6 12.8 2 10.2 2 6z',
  flame: 'M12 2c.8 3.6 6 6.2 6 12a6 6 0 0 1-12 0c0-3 1.7-5.2 3-7 .2 2 1 3.2 2.2 3.6C11 8 10.8 5 12 2z',
  hammer: 'M13.5 2.5l8 8-3 3-2-2-8.8 8.8a2.1 2.1 0 0 1-3-3l8.8-8.8-2-2z',
  gem: 'M6 3h12l4 6-10 12L2 9zm-1.2 6h14.4L16.6 5H7.4z',
  tree: 'M12 2l6 7.5h-3l4.5 6.5H4.5L9 9.5H6zM10.8 16h2.4v6h-2.4z',
  mountain: 'M1.5 20.5L9 7.5l4 6.2 2.8-3.9 6.7 10.7z',
  shield: 'M12 2l8.5 3.2v6.1c0 5-3.6 9.2-8.5 10.7-4.9-1.5-8.5-5.7-8.5-10.7V5.2z',
  star: 'M12 2l3 6.6 7.2.8-5.4 4.9 1.6 7.1L12 17.8l-6.4 3.6 1.6-7.1L1.8 9.4 9 8.6z',
  compass: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm4.2 5.8l-6.3 2.1-2.1 6.3 6.3-2.1z',
  rocket: 'M12 1.5c4 3 5.3 7.2 5.2 11.6L15.4 16H8.6l-1.8-2.9C6.7 8.7 8 4.5 12 1.5zM8.8 17h6.4L12 22.5zM12 7.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z',
  leaf: 'M4 20C4 10.5 10.5 3.5 21 3.5 21 14 14 20.5 4.5 20.5l-.5-.5zm2.3-1.7l.9.9C9.5 14.8 12.6 11.5 16 9l-.6-.6c-3.6 2.4-6.8 5.6-9.1 9.9z',
  bolt: 'M13.5 1.5L3.5 14h7l-1.5 8.5L20.5 9.5h-7z',
};

/** Build an icon tile element for a profile icon object. */
window.renderProfileIcon = function renderProfileIcon(el, icon) {
  el.style.setProperty('--icon-color', (icon && icon.color) || '#e8743b');
  el.textContent = '';
  if (icon && icon.type === 'preset' && window.FORJA_ICONS[icon.preset]) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', window.FORJA_ICONS[icon.preset]);
    p.setAttribute('fill-rule', 'evenodd');
    svg.appendChild(p);
    el.appendChild(svg);
  } else {
    const s = document.createElement('span');
    s.className = 'icon-letter';
    s.textContent = (icon && icon.letter) || '?';
    el.appendChild(s);
  }
};

/* Small stroke UI icons (24×24) for buttons: <span data-ui-icon="edit"></span> */
window.FORJA_UI_ICONS = {
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  folder: 'M3 6h6l2 2h10v11H3z',
  wrench: 'M14.5 5.5a4 4 0 0 0 4.9 4.9L21 12l-9 9-3-3 9-9-1.6-1.6a4 4 0 0 0-4.9-4.9l2.5 2.5-2 2-2.5-2.5z',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  plus: 'M12 5v14M5 12h14',
  package: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
  refresh: 'M20 11a8 8 0 0 0-14.9-3M4 5v4h4M4 13a8 8 0 0 0 14.9 3M20 19v-4h-4',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
};
window.forjaUiIcon = (name, size = 16) => {
  const d = window.FORJA_UI_ICONS[name];
  return d ? `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>` : '';
};
document.querySelectorAll('[data-ui-icon]').forEach((el) => {
  const d = window.FORJA_UI_ICONS[el.dataset.uiIcon];
  if (!d) return;
  el.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
  el.classList.add('ui-icon');
});
