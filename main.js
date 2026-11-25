(() => {
  const $ = (s, c = document) => c.querySelector(s);
  const $$ = (s, c = document) => [...c.querySelectorAll(s)];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = matchMedia('(pointer: fine)').matches;

  $('#year').textContent = new Date().getFullYear();

  /* nav, progress, back to top */
  const nav = $('#nav'), bar = $('#progress');
  const onScroll = () => {
    const h = document.documentElement;
    bar.style.width = (h.scrollTop / (h.scrollHeight - h.clientHeight)) * 100 + '%';
    nav.classList.toggle('scrolled', h.scrollTop > 40);
  };
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  $('#toTop').onclick = () => scrollTo({ top: 0, behavior: 'smooth' });

  const burger = $('#burger'), menu = $('#menu');
  const toggle = (open) => {
    menu.classList.toggle('open', open);
    burger.classList.toggle('open', open);
    burger.setAttribute('aria-expanded', open);
  };
  burger.onclick = () => toggle(!menu.classList.contains('open'));
  $$('#menu a').forEach(a => a.addEventListener('click', () => toggle(false)));

  /* active link on scroll */
  const links = $$('#menu a:not(.cta)');
  const spy = new IntersectionObserver(es => es.forEach(e => {
    if (e.isIntersecting) links.forEach(l => l.classList.toggle('active', l.getAttribute('href') === '#' + e.target.id));
  }), { rootMargin: '-45% 0px -50% 0px' });
  $$('section[id]').forEach(s => spy.observe(s));

  /* reveal on scroll, staggered by sibling index */
  const rev = new IntersectionObserver(es => es.forEach(e => {
    if (!e.isIntersecting) return;
    const sibs = [...e.target.parentElement.children].filter(c => c.classList.contains('reveal'));
    e.target.style.transitionDelay = Math.min(sibs.indexOf(e.target), 6) * 90 + 'ms';
    e.target.classList.add('in');
    rev.unobserve(e.target);
  }), { threshold: 0.12 });
  $$('.reveal').forEach(el => rev.observe(el));

  /* count-up */
  const cnt = new IntersectionObserver(es => es.forEach(e => {
    if (!e.isIntersecting) return;
    const el = e.target, end = parseFloat(el.dataset.count), d = +el.dataset.decimals || 0, suf = el.dataset.suffix || '';
    cnt.unobserve(el);
    if (reduced) { el.textContent = end.toFixed(d) + suf; return; }
    const t0 = performance.now(), dur = 1600;
    const step = t => {
      const p = Math.min((t - t0) / dur, 1), eased = 1 - Math.pow(1 - p, 3);
      el.textContent = (end * eased).toFixed(d) + suf;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }), { threshold: 0.6 });
  $$('[data-count]').forEach(el => cnt.observe(el));

  /* theme toggle */
  const root = document.documentElement;
  const themeMeta = $('meta[name="theme-color"]');
  const syncMeta = () => themeMeta.content = root.dataset.theme === 'light' ? '#f6f8fc' : '#07090f';
  syncMeta();
  $('#theme').onclick = () => {
    root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light';
    try { localStorage.setItem('theme', root.dataset.theme); } catch (e) {}
    syncMeta();
  };

  /* rotating "currently building" */
  const now = $('#now');
  const items = ['AI agents', 'MCP servers', 'SAP + AI', 'Agentic workflows', 'Multi-tenant SaaS'];
  if (!reduced) {
    let n = 0;
    setInterval(() => {
      now.classList.add('swap');
      setTimeout(() => { n = (n + 1) % items.length; now.textContent = items[n]; now.classList.remove('swap'); }, 350);
    }, 2600);
  }

  /* typed roles */
  const roles = ['AI Engineer', 'AI Product Engineer', 'Forward Deployed Engineer', 'Senior Full Stack Engineer'];
  const out = $('#typed');
  if (reduced) out.textContent = roles[1];
  else {
    let r = 0, i = 0, del = false;
    (function tick() {
      const word = roles[r];
      out.textContent = word.slice(0, i);
      if (!del && i === word.length) { del = true; return setTimeout(tick, 1600); }
      if (del && i === 0) { del = false; r = (r + 1) % roles.length; }
      i += del ? -1 : 1;
      setTimeout(tick, del ? 35 : 75);
    })();
  }

  if (fine && !reduced) {
    /* cursor glow */
    const glow = $('#glow');
    addEventListener('pointermove', e => { glow.style.transform = `translate(${e.clientX - 250}px,${e.clientY - 250}px)`; });

    /* 3D tilt */
    $$('[data-tilt]').forEach(el => {
      el.addEventListener('pointermove', e => {
        const r = el.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width - .5, y = (e.clientY - r.top) / r.height - .5;
        el.style.transform = `perspective(900px) rotateY(${x * 8}deg) rotateX(${-y * 8}deg) translateY(-4px)`;
      });
      el.addEventListener('pointerleave', () => { el.style.transform = ''; });
    });

    /* magnetic buttons */
    $$('.magnetic').forEach(el => {
      el.addEventListener('pointermove', e => {
        const r = el.getBoundingClientRect();
        el.style.transform = `translate(${(e.clientX - r.left - r.width / 2) * .15}px,${(e.clientY - r.top - r.height / 2) * .25}px)`;
      });
      el.addEventListener('pointerleave', () => { el.style.transform = ''; });
    });
  }

  /* particle network background */
  const cv = $('#bg'), ctx = cv.getContext('2d');
  let W, H, pts = [], mouse = { x: -999, y: -999 };
  const resize = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.min(Math.floor(W * H / 16000), 90);
    pts = Array.from({ length: n }, () => ({ x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - .5) * .35, vy: (Math.random() - .5) * .35 }));
  };
  addEventListener('resize', resize);
  addEventListener('pointermove', e => { mouse.x = e.clientX; mouse.y = e.clientY; });
  resize();
  let dotRgb = '110,231,255', linkRgb = '167,139,250';
  const readColors = () => {
    const cs = getComputedStyle(root);
    dotRgb = cs.getPropertyValue('--dot-rgb').trim(); linkRgb = cs.getPropertyValue('--link-rgb').trim();
  };
  new MutationObserver(readColors).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  readColors();
  const draw = () => {
    ctx.clearRect(0, 0, W, H);
    for (const p of pts) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > W) p.vx *= -1;
      if (p.y < 0 || p.y > H) p.vy *= -1;
      ctx.fillStyle = `rgba(${dotRgb},.6)`;
      ctx.fillRect(p.x, p.y, 2, 2);
    }
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y, d = dx * dx + dy * dy;
        if (d < 14000) {
          ctx.strokeStyle = `rgba(${linkRgb},${(1 - d / 14000) * .25})`;
          ctx.beginPath(); ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(pts[j].x, pts[j].y); ctx.stroke();
        }
      }
      const mx = pts[i].x - mouse.x, my = pts[i].y - mouse.y, md = mx * mx + my * my;
      if (md < 20000) {
        ctx.strokeStyle = `rgba(${dotRgb},${(1 - md / 20000) * .5})`;
        ctx.beginPath(); ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(mouse.x, mouse.y); ctx.stroke();
      }
    }
    requestAnimationFrame(draw);
  };
  if (reduced) { draw(); } else { requestAnimationFrame(draw); }
})();
