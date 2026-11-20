/*
 * app.js — reads the CSV files in data/, runs the math in capstruct.js and
 * draws the tables. All figures come from the data files; none are typed here.
 */
(function () {
  'use strict';

  const C = window.CapStruct;
  const FILES = {
    cdss: 'data/cdss.csv',
    assumptions: 'data/assumptions.csv',
    schedule: 'data/banker_schedule.csv',
    firms: 'data/example_firms.csv',
    scenarios: 'data/ebit_scenarios.csv',
  };

  /* ---------- Small DOM helpers (text only, never HTML strings) ---------- */

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') node.className = v;
        else node.setAttribute(k, v);
      }
    }
    (children || []).forEach((c) => {
      if (c === null || c === undefined) return;
      node.append(c instanceof Node ? c : String(c));
    });
    return node;
  }

  const badge = (text) => el('span', { class: 'badge' }, [text]);

  /* ---------- Loading ---------- */

  async function loadText(path) {
    const res = await fetch(path, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`Could not load ${path} (HTTP ${res.status})`);
    return res.text();
  }

  async function loadInputs() {
    const keys = Object.keys(FILES);
    const texts = await Promise.all(keys.map((k) => loadText(FILES[k])));
    const raw = {};
    keys.forEach((k, i) => { raw[k] = C.parseCSV(texts[i]); });
    return C.buildInputs(raw);
  }

  /* ---------- Firm U and Firm L ---------- */

  function firmTable(title, firm) {
    const k = firm.years.length;
    const head = el('tr', null, [el('th', { scope: 'col' }, [''])].concat(
      firm.years.map((_, i) => el('th', { scope: 'col' }, [`Outcome ${i + 1}`]))
    ));

    const row = (label, cells, cls) =>
      el('tr', { class: cls }, [el('th', { scope: 'row' }, [label])].concat(cells.map((c) => el('td', null, [c]))));
    const each = (label, fn, cls) => row(label, firm.years.map(fn), cls);
    const spanRow = (label, value) =>
      el('tr', { class: 'stat' }, [el('th', { scope: 'row' }, [label]), el('td', { colspan: k, class: 'span' }, [value])]);

    const tie = firm.tie;
    const body = el('tbody', null, [
      each('Assets', () => C.fmtDollars(firm.assets)),
      each('Equity', () => C.fmtDollars(firm.equity)),
      each('Probability', (y) => C.fmt2(y.p)),
      each('Sales', (y) => C.fmtDollars(y.sales)),
      each('Oper. costs', (y) => C.fmtCost(y.opCosts)),
      each('EBIT', (y) => C.fmtDollars(y.ebit), 'subtotal'),
      each('Interest', (y) => C.fmtCost(y.interest)),
      each('EBT', (y) => C.fmtDollars(y.ebt)),
      each(`Taxes (${C.fmtPct(firm.taxRate).replace('.00', '')})`, (y) => C.fmtCost(y.taxes)),
      each('Net income', (y) => C.fmtDollars(y.netIncome), 'subtotal'),
      each('ROE', (y) => C.fmtPct(y.roe)),
      each('TIE', (y) => C.fmtMult(y.tie)),
      spanRow('E(ROE)', C.fmtPct(firm.roe.expected)),
      spanRow('σ(ROE)', C.fmtPct(firm.roe.sd)),
      spanRow('CV(ROE)', C.fmt2(firm.roe.cv)),
      spanRow('E(TIE)', tie ? C.fmtMult(tie.expected) : 'n/a'),
      spanRow('σ(TIE)', tie ? C.fmtMult(tie.sd) : 'n/a'),
    ]);

    return el('table', null, [el('caption', null, [title]), el('thead', null, [head]), body]);
  }

  function renderFirms(inputs) {
    const { firms, tax, scenarios } = inputs;
    const u = C.exampleFirm(firms.totalAssets, 0, firms.rate, tax, scenarios);
    const l = C.exampleFirm(firms.totalAssets, firms.debt, firms.rate, tax, scenarios);
    u.taxRate = tax;
    l.taxRate = tax;

    document.getElementById('firms-intro').textContent =
      `Both firms have ${C.fmtDollars(firms.totalAssets)} of assets and a ${C.fmtPct(tax)} tax rate and face the same EBIT ` +
      `outcomes. Firm U has no debt. Firm L has ${C.fmtDollars(firms.debt)} of debt at ${C.fmtPct(firms.rate)}.`;

    const grid = document.getElementById('firm-tables');
    grid.replaceChildren(
      firmTable('Firm U (no debt)', u),
      firmTable(`Firm L (${C.fmtDollars(firms.debt)} of debt)`, l)
    );
    document.getElementById('firms').hidden = false;
  }

  /* ---------- CDSS ---------- */

  // A table with one row per amount of debt. On a phone each row becomes a card.
  function debtTable(rows, columns, bestDebt, bestLabel) {
    const head = el('tr', null, columns.map((c) => el('th', { scope: 'col' }, [c.label])));
    const body = el('tbody', null, rows.map((r) => {
      const isBest = r.debt === bestDebt;
      const first = el('th', { scope: 'row' }, [C.fmtDollars(r.debt), isBest ? badge(bestLabel) : null]);
      const cells = columns.slice(1).map((c) => {
        const flag = c.flag ? c.flag(r) : null;
        return el('td', { 'data-label': c.label }, [c.value(r), flag ? badge(flag) : null]);
      });
      return el('tr', { class: isBest ? 'best' : null, 'data-debt': String(r.debt) }, [first].concat(cells));
    }));
    return el('table', { class: 'cards' }, [el('thead', null, [head]), body]);
  }

  function renderCDSS(inputs) {
    const { cdss, tax } = inputs;
    const result = C.analyzeCDSS(inputs);
    const { rows, best } = result;

    // Facts drawn from cdss.csv and assumptions.csv
    const facts = [
      ['Sales', C.fmtDollars(cdss.sales)],
      ['Variable costs', C.fmtPct(cdss.variableCostRate) + ' of sales'],
      ['Fixed costs', C.fmtDollars(cdss.fixedCosts)],
      ['EBIT (constant)', C.fmtDollars(result.ebit)],
      ['Tax rate', C.fmtPct(tax)],
      ['Shares outstanding', C.fmtShares(cdss.shares)],
      ['Price today (P₀)', C.fmtCents(cdss.price)],
      ['Total book assets (A)', C.fmtDollars(cdss.totalAssets)],
    ];
    document.getElementById('cdss-facts').replaceChildren(
      ...facts.map(([k, v]) => el('div', null, [el('dt', null, [k]), el('dd', null, [v])]))
    );
    document.getElementById('p0').textContent = C.fmtCents(cdss.price);

    const flagIf = (debt, text) => (r) => (r.debt === debt ? text : null);

    const caseCols = [
      { label: 'Debt' },
      { label: 'r_d', value: (r) => (r.rd === null ? '—' : C.fmtPct(r.rd)) },
      { label: 'r_s', value: (r) => C.fmtPct(r.rs) },
      { label: 'Interest', value: (r) => C.fmtDollars(r.interest) },
      { label: 'Net income', value: (r) => C.fmtDollars(r.netIncome) },
      { label: 'Shares repurchased', value: (r) => C.fmtShares(r.case.repurchased) },
      { label: 'Shares remaining', value: (r) => C.fmtShares(r.case.remaining) },
      { label: 'EPS', value: (r) => C.fmtCents(r.case.eps) },
      { label: 'TIE', value: (r) => C.fmtMult(r.tie) },
      { label: 'Share price', value: (r) => C.fmtCents(r.case.price) },
      { label: 'WACC (book)', value: (r) => C.fmtPct(r.case.wacc), flag: flagIf(best.bookWACC, 'Lowest') },
    ];
    const newCols = [
      { label: 'Debt' },
      { label: 'r_d', value: (r) => (r.rd === null ? '—' : C.fmtPct(r.rd)) },
      { label: 'r_s', value: (r) => C.fmtPct(r.rs) },
      { label: 'Net income', value: (r) => C.fmtDollars(r.netIncome) },
      { label: 'Equity value S', value: (r) => C.fmtDollars(r.newPrice.equityValue) },
      { label: 'Firm value V', value: (r) => C.fmtDollars(r.newPrice.firmValue) },
      { label: 'Share price', value: (r) => C.fmtCents(r.newPrice.price) },
      { label: 'Shares repurchased', value: (r) => C.fmtShares(r.newPrice.repurchased) },
      { label: 'Shares remaining', value: (r) => C.fmtShares(r.newPrice.remaining) },
      { label: 'EPS', value: (r) => C.fmtCents(r.newPrice.eps) },
      { label: 'TIE', value: (r) => C.fmtMult(r.tie) },
      { label: 'WACC (market)', value: (r) => C.fmtPct(r.newPrice.wacc), flag: flagIf(best.marketWACC, 'Lowest') },
    ];

    document.getElementById('case-table').replaceChildren(debtTable(rows, caseCols, best.casePrice, 'Highest price'));
    document.getElementById('new-table').replaceChildren(debtTable(rows, newCols, best.newPrice, 'Highest price'));

    // Which amount of debt wins under each method and each set of weights
    const picks = [
      ['highest price with the case\'s buyback', best.casePrice],
      ['highest price with the new-price buyback', best.newPrice],
      ['lowest book-weight WACC', best.bookWACC],
      ['lowest market-weight WACC', best.marketWACC],
    ];
    const summary = document.getElementById('cdss-summary');
    const allSame = picks.every(([, d]) => d === picks[0][1]);
    if (allSame) {
      summary.replaceChildren(el('p', null, [
        `With this banker's schedule, ${C.fmtDollars(picks[0][1])} of debt gives the highest share price under both buyback methods ` +
          'and the lowest WACC under both book and market weights.',
      ]));
    } else {
      summary.replaceChildren(
        el('p', null, ['The four measures do not all point to the same amount of debt:']),
        ...picks.map(([what, d]) => el('p', null, [`• ${C.fmtDollars(d)}: ${what}`]))
      );
    }

    showWarnings(result.warnings);
    setupCDSSLever(inputs, result);
    document.getElementById('cdss').hidden = false;
  }

  /* ---------- Lever: CDSS's debt ---------- */

  function setupCDSSLever(inputs, result) {
    const { cdss } = inputs;
    const { rows, best } = result;
    const slider = document.getElementById('cdss-debt');
    const out = document.getElementById('cdss-debt-out');
    const note = document.getElementById('button-note');
    const panel = document.getElementById('cdss-results');

    // The slider moves over the schedule's rows, one step per banker amount.
    slider.max = String(rows.length - 1);
    slider.value = '0';
    document.getElementById('cdss-ticks').replaceChildren(
      ...rows.map((r) => el('span', null, [r.debt >= 1e6 ? '$' + r.debt / 1e6 + 'M' : '$' + r.debt / 1e3 + 'k']))
    );

    function stakeText(rep) {
      const s = C.managementStake(cdss, rep);
      if (s.status === 'allBought') return { value: '100.00%', note: 'No outside shareholders would be left.' };
      if (s.status === 'mustSell') {
        return { value: 'n/a', warn: `Management would have to sell ${C.fmtShares(s.shortfall)} shares; outsiders don't own enough.` };
      }
      return { value: C.fmtPct(s.stake) };
    }

    function methodCard(title, m, waccLabel, r) {
      const stake = stakeText(m.repurchased);
      const line = (k, v, extra) => el('div', { class: 'kv' }, [el('dt', null, [k]), el('dd', null, [v, extra || null])]);
      return el('div', { class: 'method-card' }, [
        el('h4', null, [title]),
        el('dl', null, [
          line('Share price', C.fmtCents(m.price), m === r.case && r.debt === best.casePrice || m === r.newPrice && r.debt === best.newPrice ? badge('Highest') : null),
          line('Shares repurchased', C.fmtShares(m.repurchased)),
          line('Shares remaining', C.fmtShares(m.remaining)),
          line('EPS', C.fmtCents(m.eps)),
          line('Dividends per share', C.fmtCents(m.dps)),
          line('TIE', C.fmtMult(r.tie)),
          line(waccLabel, C.fmtPct(m.wacc)),
          line("Management's share", stake.value),
        ]),
        stake.note ? el('p', { class: 'note small' }, [stake.note]) : null,
        stake.warn ? el('div', { class: 'warning' }, ['⚠ ' + stake.warn]) : null,
      ]);
    }

    function update() {
      const r = rows[Number(slider.value)];
      out.textContent = C.fmtDollars(r.debt);
      slider.setAttribute('aria-valuetext', C.fmtDollars(r.debt));
      panel.replaceChildren(
        methodCard(`Case method: buy back at ${C.fmtCents(cdss.price)}`, r.case, 'WACC (book weights)', r),
        methodCard('New-price method: buy back at the new price', r.newPrice, 'WACC (market weights)', r)
      );
      // Outline the matching row in both tables
      document.querySelectorAll('#cdss tr[data-debt]').forEach((tr) => {
        tr.classList.toggle('selected', tr.dataset.debt === String(r.debt));
      });
    }

    function goTo(caseDebt, newDebt, what) {
      const pick = C.chooseDebt(caseDebt, newDebt);
      if (pick.debt === null) return;
      slider.value = String(rows.findIndex((r) => r.debt === pick.debt));
      note.replaceChildren(
        pick.differ
          ? el('div', { class: 'warning' }, [
              `The two methods disagree on the ${what}: the case method picks ${C.fmtDollars(pick.caseDebt)}, ` +
                `the new-price method picks ${C.fmtDollars(pick.newDebt)}. The slider shows the case method's amount.`,
            ])
          : el('p', { class: 'note' }, [`Both buyback methods give the ${what} at ${C.fmtDollars(pick.debt)}.`])
      );
      update();
    }

    slider.addEventListener('input', () => { note.replaceChildren(); update(); });
    document.getElementById('btn-best-price').addEventListener('click', () => goTo(best.casePrice, best.newPrice, 'highest share price'));
    document.getElementById('btn-best-eps').addEventListener('click', () => goTo(best.caseEPS, best.newEPS, 'highest EPS'));
    update();
  }

  /* ---------- Lever: Firm L's debt ---------- */

  function setupFirmLever(inputs) {
    const { firms, tax, scenarios } = inputs;
    const slider = document.getElementById('firm-debt');
    const out = document.getElementById('firm-debt-out');
    const box = document.getElementById('firm-compare');

    slider.min = '0';
    slider.max = String(firms.sliderMax);
    slider.step = String(firms.sliderStep);
    slider.value = String(firms.debt);
    document.getElementById('firm-rate-note').textContent =
      `The interest rate is held at ${C.fmtPct(firms.rate)} at every amount, so the slider shows what debt does to Firm L's ` +
      'return and risk, not how lenders would respond.';

    const u = C.exampleFirm(firms.totalAssets, 0, firms.rate, tax, scenarios);

    function update() {
      const debt = Number(slider.value);
      const l = C.exampleFirm(firms.totalAssets, debt, firms.rate, tax, scenarios);
      out.textContent = C.fmtDollars(debt);
      slider.setAttribute('aria-valuetext', C.fmtDollars(debt));

      const rowsOut = [];
      const add = (label, uv, lv, cls) =>
        rowsOut.push(el('tr', { class: cls }, [el('th', { scope: 'row' }, [label]), el('td', null, [uv]), el('td', null, [lv])]));
      u.years.forEach((y, i) => add(`ROE, outcome ${i + 1} (EBIT ${C.fmtDollars(y.ebit)})`, C.fmtPct(y.roe), C.fmtPct(l.years[i].roe)));
      u.years.forEach((y, i) => add(`TIE, outcome ${i + 1}`, C.fmtMult(y.tie), C.fmtMult(l.years[i].tie)));
      add('E(ROE)', C.fmtPct(u.roe.expected), C.fmtPct(l.roe.expected), 'stat');
      add('σ(ROE)', C.fmtPct(u.roe.sd), C.fmtPct(l.roe.sd), 'stat');
      add('CV(ROE)', C.fmt2(u.roe.cv), C.fmt2(l.roe.cv), 'stat');
      add('E(TIE)', 'n/a', l.tie ? C.fmtMult(l.tie.expected) : 'n/a', 'stat');
      add('σ(TIE)', 'n/a', l.tie ? C.fmtMult(l.tie.sd) : 'n/a', 'stat');

      box.replaceChildren(el('table', { class: 'compare' }, [
        el('thead', null, [el('tr', null, [
          el('th', { scope: 'col' }, ['']),
          el('th', { scope: 'col' }, ['Firm U']),
          el('th', { scope: 'col' }, [`Firm L (${C.fmtDollars(debt)})`]),
        ])]),
        el('tbody', null, rowsOut),
      ]));
    }

    slider.addEventListener('input', update);
    document.getElementById('btn-case').addEventListener('click', () => {
      slider.value = String(firms.debt);
      update();
    });
    update();
  }

  function showWarnings(list) {
    document.getElementById('warnings').replaceChildren(
      ...list.map((w) => el('div', { class: 'warning', role: 'alert' }, ['⚠ ' + w]))
    );
  }

  /* ---------- Service worker (install and offline) ---------- */

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker not registered:', err));
    });
  }

  /* ---------- Start ---------- */

  const status = document.getElementById('status');
  loadInputs()
    .then((inputs) => {
      renderFirms(inputs);
      setupFirmLever(inputs);
      renderCDSS(inputs);
      status.hidden = true;
    })
    .catch((err) => {
      status.classList.add('error');
      status.textContent =
        `The app could not read its data: ${err.message}. ` +
        (location.protocol === 'file:'
          ? 'Browsers block reading files when a page is opened straight from disk; open it from GitHub Pages or a local web server.'
          : 'Check that the files in data/ are present and correctly formatted.');
    });
})();
