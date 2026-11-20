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
      return el('tr', { class: isBest ? 'best' : null }, [first].concat(cells));
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
    document.getElementById('cdss').hidden = false;
  }

  function showWarnings(list) {
    document.getElementById('warnings').replaceChildren(
      ...list.map((w) => el('div', { class: 'warning', role: 'alert' }, ['⚠ ' + w]))
    );
  }

  /* ---------- Start ---------- */

  const status = document.getElementById('status');
  loadInputs()
    .then((inputs) => {
      renderFirms(inputs);
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
