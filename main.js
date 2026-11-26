/* Mugeshbabu Arulmani, portfolio. No dependencies.
   1. Theme switch (dark default, remembered)
   2. Masthead: reading progress, current section, mobile index
   3. System flows: accessible tab diagrams for the project stories
   4. Quiet reveal on scroll
*/
(() => {
  'use strict';
  const $ = (s, c = document) => c.querySelector(s);
  const $$ = (s, c = document) => Array.from(c.querySelectorAll(s));
  const root = document.documentElement;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- 1. Theme ---------- */
  const themeBtn = $('#theme'), themeLabel = $('#theme-label'), themeMeta = $('meta[name="theme-color"]');
  const paintTheme = () => {
    const light = root.dataset.theme === 'light';
    themeBtn.setAttribute('aria-label', light ? 'Switch to dark theme' : 'Switch to light theme');
    themeLabel.textContent = light ? 'Dark' : 'Light';
    if (themeMeta) themeMeta.content = light ? '#f3eee3' : '#14120e';
  };
  themeBtn.addEventListener('click', () => {
    root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light';
    try { localStorage.setItem('theme', root.dataset.theme); } catch (e) { /* storage unavailable */ }
    paintTheme();
  });
  paintTheme();

  /* ---------- 2. Masthead ---------- */
  const bar = $('#progress');
  const setProgress = () => {
    const h = root.scrollHeight - root.clientHeight;
    bar.style.transform = 'scaleX(' + (h > 0 ? Math.min(root.scrollTop / h, 1) : 0) + ')';
  };
  let ticking = false;
  addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { setProgress(); ticking = false; });
  }, { passive: true });
  addEventListener('resize', setProgress);
  setProgress();

  const nav = $('#nav'), menuBtn = $('#menu-btn');
  const setMenu = open => {
    nav.classList.toggle('open', open);
    menuBtn.setAttribute('aria-expanded', String(open));
    menuBtn.textContent = open ? 'Close' : 'Index';
    document.body.style.overflow = open ? 'hidden' : '';
  };
  menuBtn.addEventListener('click', () => setMenu(!nav.classList.contains('open')));
  $$('a', nav).forEach(a => a.addEventListener('click', () => setMenu(false)));
  addEventListener('keydown', e => {
    if (e.key === 'Escape' && nav.classList.contains('open')) { setMenu(false); menuBtn.focus(); }
  });
  matchMedia('(min-width: 761px)').addEventListener('change', e => { if (e.matches) setMenu(false); });

  const links = $$('a[href^="#"]', nav);
  const sections = links.map(a => $(a.getAttribute('href'))).filter(Boolean);
  const spy = new IntersectionObserver(entries => {
    entries.forEach(en => {
      if (!en.isIntersecting) return;
      links.forEach(a => {
        if (a.getAttribute('href') === '#' + en.target.id) a.setAttribute('aria-current', 'true');
        else a.removeAttribute('aria-current');
      });
    });
  }, { rootMargin: '-45% 0px -50% 0px' });
  sections.forEach(s => spy.observe(s));
  addEventListener('scroll', () => {
    if (root.scrollTop < 200) links.forEach(a => a.removeAttribute('aria-current'));
  }, { passive: true });

  $('#to-top').addEventListener('click', () => scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' }));
  $('#year').textContent = new Date().getFullYear();

  /* ---------- 3. System flows ---------- */
  $$('[data-flow]').forEach(flow => {
    const tabs = $$('[role="tab"]', flow);
    const panels = tabs.map(t => document.getElementById(t.getAttribute('aria-controls')));
    const prev = $('[data-prev]', flow), next = $('[data-next]', flow);
    let cur = 0;

    const select = (i, focus) => {
      cur = Math.max(0, Math.min(i, tabs.length - 1));
      tabs.forEach((t, n) => {
        const on = n === cur;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        t.classList.toggle('done', n < cur);
        panels[n].hidden = !on;
      });
      flow.style.setProperty('--i', cur);
      prev.disabled = cur === 0;
      next.disabled = cur === tabs.length - 1;
      if (focus) tabs[cur].focus();
      const sc = tabs[cur].closest('.flow-scroll');
      if (sc && sc.scrollWidth > sc.clientWidth) {
        const t = tabs[cur];
        sc.scrollTo({ left: t.offsetLeft - (sc.clientWidth - t.offsetWidth) / 2, behavior: reduced ? 'auto' : 'smooth' });
      }
    };

    tabs.forEach((t, n) => {
      t.addEventListener('click', () => select(n));
      t.addEventListener('keydown', e => {
        const k = e.key;
        if (k === 'ArrowRight' || k === 'ArrowDown') { e.preventDefault(); select(cur + 1, true); }
        else if (k === 'ArrowLeft' || k === 'ArrowUp') { e.preventDefault(); select(cur - 1, true); }
        else if (k === 'Home') { e.preventDefault(); select(0, true); }
        else if (k === 'End') { e.preventDefault(); select(tabs.length - 1, true); }
      });
    });
    prev.addEventListener('click', () => select(cur - 1));
    next.addEventListener('click', () => select(cur + 1));
    select(0);
  });

  /* ---------- 4. Reveal ---------- */
  const rv = $$('.rv');
  if ('IntersectionObserver' in window && !reduced) {
    const io = new IntersectionObserver(entries => {
      entries.forEach(en => {
        if (!en.isIntersecting) return;
        en.target.classList.add('in');
        io.unobserve(en.target);
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -6% 0px' });
    rv.forEach(el => io.observe(el));
  } else {
    rv.forEach(el => el.classList.add('in'));
  }

  requestAnimationFrame(() => root.classList.add('is-ready'));
})();
