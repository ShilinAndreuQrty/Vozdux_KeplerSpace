const header = document.querySelector('.site-header');
const menuToggle = header.querySelector('.menu-toggle');

header.setAttribute('data-menu-ready', '');

menuToggle.addEventListener('click', () => {
    const isOpen = menuToggle.getAttribute('aria-expanded') === 'true';
    menuToggle.setAttribute('aria-expanded', String(!isOpen));
});

header.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menuToggle.getAttribute('aria-expanded') === 'true') {
        menuToggle.setAttribute('aria-expanded', 'false');
        menuToggle.focus();
    }
});

if (window.matchMedia('(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)').matches) {
    document.addEventListener('pointermove', event => {
        const glass = event.target.closest('.liquid');
        if (!glass) return;
        const bounds = glass.getBoundingClientRect();
        glass.style.setProperty('--sheen-x', (event.clientX - bounds.left) + 'px');
        glass.style.setProperty('--sheen-y', (event.clientY - bounds.top) + 'px');
    }, {passive: true});
}
