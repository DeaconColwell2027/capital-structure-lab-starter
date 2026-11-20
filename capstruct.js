/*
 * capstruct.js — the finance math for the AGE capital structure app.
 *
 * Every function here is "pure": it takes numbers in and gives numbers back.
 * Nothing in this file reads the page or the network, so it can be checked
 * with Node, for example:
 *   node -e "const C=require('./capstruct.js'); console.log(C.roundHalfUp(14.025,2))"
 *
 * Notation (from CLAUDE.md): T = tax rate, D = amount borrowed,
 * n = shares outstanding before any buyback, P0 = today's price,
 * A = total book assets.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CapStruct = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- Rounding and display ---------- */

  // Round half up on the decimal value. toFixed() rounds the binary value
  // instead, which turns 14.025 into 14.02 and 3.495 into 3.49.
  function roundHalfUp(x, d) {
    const f = 10 ** d;
    const sign = x < 0 ? -1 : 1;
    return (sign * Math.round(Number((Math.abs(x) * f).toPrecision(12)))) / f;
  }

  function withCommas(x, d) {
    return roundHalfUp(x, d).toLocaleString('en-US', {
      minimumFractionDigits: d,
      maximumFractionDigits: d,
    });
  }

  const NA = 'n/a';
  const ok = (x) => typeof x === 'number' && Number.isFinite(x);

  // Dollars to the nearest dollar: $500,000
  const fmtDollars = (x) => (ok(x) ? (x < 0 ? '−$' : '$') + withCommas(Math.abs(x), 0) : NA);
  // A cost shown in brackets, like the case's income statements: (4,000)
  const fmtCost = (x) => (ok(x) ? '(' + withCommas(x, 0) + ')' : NA);
  // Prices, EPS and dividends to the cent: $21.01
  const fmtCents = (x) => (ok(x) ? (x < 0 ? '−$' : '$') + withCommas(Math.abs(x), 2) : NA);
  // Rates as percents to two decimals: 14.03%
  const fmtPct = (x) => (ok(x) ? withCommas(x * 100, 2) + '%' : NA);
  // TIE, CV and other multiples to two decimals: 20.00×
  const fmtMult = (x) => (ok(x) ? withCommas(x, 2) + '×' : NA);
  // Plain number to two decimals (CV, probabilities)
  const fmt2 = (x) => (ok(x) ? withCommas(x, 2) : NA);
  // Share counts, not rounded away: two decimals
  const fmtShares = (x) => (ok(x) ? withCommas(x, 2) : NA);

  /* ---------- Reading the CSV files ---------- */

  // A small CSV reader: handles quoted fields, commas inside quotes and
  // Windows line endings. Returns one object per row, keyed by the header.
  function parseCSV(text) {
    text = String(text).replace(/^﻿/, '');
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
        } else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    const lines = rows.filter((r) => r.some((v) => v.trim() !== ''));
    if (!lines.length) return [];
    const header = lines.shift().map((h) => h.trim());
    return lines.map((r) =>
      Object.fromEntries(header.map((h, j) => [h, (r[j] === undefined ? '' : r[j]).trim()]))
    );
  }

  function toNumber(value, label) {
    const x = Number(value);
    if (value === '' || value === undefined || !Number.isFinite(x)) {
      throw new Error(`${label}: expected a number but found "${value === undefined ? '' : value}"`);
    }
    return x;
  }

  function findValue(rows, keyCol, key, file) {
    const r = rows.find((x) => x[keyCol] === key);
    if (!r) throw new Error(`${file} has no "${key}" row`);
    return toNumber(r.value, `${file}, ${key}`);
  }

  // Turn the parsed CSV rows into the inputs the math needs.
  // raw = { cdss, assumptions, schedule, firms, scenarios }, each an array of rows.
  function buildInputs(raw) {
    const tax = findValue(raw.assumptions, 'assumption', 'tax_rate', 'assumptions.csv');

    const c = (k) => findValue(raw.cdss, 'item', k, 'cdss.csv');
    const cdss = {
      sales: c('sales'),
      variableCostRate: c('variable_cost_rate'),
      fixedCosts: c('fixed_costs'),
      totalAssets: c('total_assets'),
      existingDebt: c('debt'),
      shares: c('shares_outstanding'),
      price: c('share_price'),
      managementShare: c('management_share'),
    };

    const schedule = raw.schedule
      .map((r, i) => {
        const where = `banker schedule, row ${i + 2}`;
        const debt = toNumber(r.debt, `${where}, debt`);
        const rd = r.cost_of_debt === '' ? null : toNumber(r.cost_of_debt, `${where}, cost_of_debt`);
        const rs = toNumber(r.cost_of_equity, `${where}, cost_of_equity`);
        if (debt > 0 && rd === null) throw new Error(`${where}: borrowing $${debt} needs a cost of debt`);
        if (rs <= 0) throw new Error(`${where}: cost of equity must be above zero`);
        return { debt, rd, rs };
      })
      .sort((a, b) => a.debt - b.debt);
    if (!schedule.length) throw new Error('The banker schedule has no rows');

    const f = (k) => findValue(raw.firms, 'item', k, 'example_firms.csv');
    const firms = {
      totalAssets: f('total_assets'),
      debt: f('firm_l_debt'),
      rate: f('interest_rate'),
      sliderMax: f('slider_max'),
      sliderStep: f('slider_step'),
    };

    const scenarios = raw.scenarios.map((r, i) => {
      const where = `ebit_scenarios.csv, row ${i + 2}`;
      return {
        p: toNumber(r.probability, `${where}, probability`),
        sales: toNumber(r.sales, `${where}, sales`),
        opCosts: toNumber(r.operating_costs, `${where}, operating_costs`),
      };
    });
    const totalP = scenarios.reduce((s, x) => s + x.p, 0);
    if (Math.abs(totalP - 1) > 1e-9) {
      throw new Error(`ebit_scenarios.csv: probabilities add up to ${totalP}, not 1`);
    }

    return { tax, cdss, schedule, firms, scenarios };
  }

  /* ---------- Firm U and Firm L (question c) ---------- */

  // Probability-weighted expected value, standard deviation and CV.
  function distribution(values, probs) {
    const e = values.reduce((s, x, i) => s + probs[i] * x, 0);
    const variance = values.reduce((s, x, i) => s + probs[i] * (x - e) ** 2, 0);
    const sd = Math.sqrt(variance);
    return { expected: e, sd, cv: e !== 0 ? sd / e : null };
  }

  // One firm's partial income statements and ratios in each kind of year.
  // debt = 0 gives Firm U; debt = 10,000 at 12% gives Firm L.
  function exampleFirm(assets, debt, rate, tax, scenarios) {
    const equity = assets - debt; // book equity
    const interest = rate * debt;
    const years = scenarios.map((s) => {
      const ebit = s.sales - s.opCosts;
      const ebt = ebit - interest;
      const taxes = tax * ebt;
      const netIncome = ebt - taxes;
      return {
        p: s.p,
        sales: s.sales,
        opCosts: s.opCosts,
        ebit,
        interest,
        ebt,
        taxes,
        netIncome,
        roe: netIncome / equity,
        tie: interest > 0 ? ebit / interest : null, // no interest: n/a
      };
    });
    const probs = years.map((y) => y.p);
    return {
      assets,
      equity,
      debt,
      rate,
      interest,
      years,
      roe: distribution(years.map((y) => y.roe), probs),
      tie: interest > 0 ? distribution(years.map((y) => y.tie), probs) : null,
    };
  }

  /* ---------- CDSS at each amount of borrowing (question d) ---------- */

  // EBIT = sales × (1 − variable cost rate) − fixed costs. Constant at every D.
  function cdssEBIT(c) {
    return c.sales * (1 - c.variableCostRate) - c.fixedCosts;
  }

  function cdssAtDebt(c, tax, row) {
    const ebit = cdssEBIT(c);
    const D = row.debt;
    const n = c.shares;
    const A = c.totalAssets;
    const interest = D > 0 ? row.rd * D : 0;
    const netIncome = (ebit - interest) * (1 - tax);
    const tie = interest > 0 ? ebit / interest : null;
    const afterTaxRd = D > 0 ? row.rd * (1 - tax) : 0;

    // Case method (d(3), d(4)): buy back at today's price P0.
    const caseRep = D / c.price;
    const caseRem = n - caseRep;
    const caseValid = caseRem > 0;
    const caseEPS = caseValid ? netIncome / caseRem : null;
    const caseSharePrice = caseValid ? caseEPS / row.rs : null;
    // Book-weight WACC (the AGE solution's method for d(7)).
    const waccBook = (D / A) * afterTaxRd + ((A - D) / A) * row.rs;

    // New-price method: buy back at the price after the announcement.
    const S = netIncome / row.rs; // value of equity
    const V = S + D; // value of the firm
    const P = V / n; // price per share
    const newRep = D / P;
    const newRem = n - newRep;
    const newEPS = netIncome / newRem;
    // Market-weight WACC.
    const waccMarket = (D / V) * afterTaxRd + (S / V) * row.rs;

    // Checks: EPS = r_s × P, and market WACC = EBIT(1 − T) / V.
    const epsCheck = Math.abs(newEPS - row.rs * P) <= 1e-9 * Math.max(1, Math.abs(newEPS));
    const waccCheck = Math.abs(waccMarket - (ebit * (1 - tax)) / V) <= 1e-12;

    return {
      debt: D,
      rd: row.rd,
      rs: row.rs,
      ebit,
      interest,
      netIncome,
      tie,
      case: {
        repurchased: caseRep,
        remaining: caseRem,
        valid: caseValid,
        eps: caseEPS,
        dps: caseEPS, // all earnings paid out, so DPS = EPS
        price: caseSharePrice,
        wacc: waccBook,
      },
      newPrice: {
        equityValue: S,
        firmValue: V,
        price: P,
        repurchased: newRep,
        remaining: newRem,
        eps: newEPS,
        dps: newEPS,
        wacc: waccMarket,
        epsCheck,
        waccCheck,
      },
    };
  }

  // Index of the row with the highest (or lowest) value. Rows are sorted by
  // debt, and only a strictly better value moves the pick, so an exact tie
  // goes to the smaller amount of debt.
  function bestIndex(rows, get, wantHighest) {
    let best = -1;
    rows.forEach((r, i) => {
      const x = get(r);
      if (!ok(x)) return;
      if (best < 0) { best = i; return; }
      const y = get(rows[best]);
      if (wantHighest ? x > y : x < y) best = i;
    });
    return best;
  }

  function analyzeCDSS(inputs) {
    const { cdss, tax, schedule } = inputs;
    const rows = schedule.map((r) => cdssAtDebt(cdss, tax, r));
    const pick = (get, high) => {
      const i = bestIndex(rows, get, high);
      return i < 0 ? null : rows[i].debt;
    };
    const best = {
      casePrice: pick((r) => r.case.price, true),
      newPrice: pick((r) => r.newPrice.price, true),
      bookWACC: pick((r) => r.case.wacc, false),
      marketWACC: pick((r) => r.newPrice.wacc, false),
      caseEPS: pick((r) => r.case.eps, true),
      newEPS: pick((r) => r.newPrice.eps, true),
    };

    const warnings = [];
    // Check: EPS / r_s at $0 should equal today's share price.
    const zero = rows.find((r) => r.debt === 0);
    if (!zero) {
      warnings.push('The banker schedule has no $0 row, so the app cannot check today\'s share price.');
    } else if (roundHalfUp(zero.case.price, 2) !== roundHalfUp(cdss.price, 2)) {
      warnings.push(
        `With no debt, EPS / r_s gives ${fmtCents(zero.case.price)}, but cdss.csv says the share price is ` +
          `${fmtCents(cdss.price)}. The schedule's $0 cost of equity doesn't match today's price.`
      );
    }
    if (cdss.existingDebt !== 0) {
      warnings.push(`cdss.csv shows existing debt of ${fmtDollars(cdss.existingDebt)}; the app assumes CDSS starts with none.`);
    }
    rows.forEach((r) => {
      if (!r.case.valid) {
        warnings.push(`At ${fmtDollars(r.debt)} of debt, a $${cdss.price} buyback would retire every share.`);
      }
      if (!r.newPrice.epsCheck || !r.newPrice.waccCheck) {
        warnings.push(`At ${fmtDollars(r.debt)} of debt, the new-price checks did not balance.`);
      }
    });

    return { ebit: cdssEBIT(cdss), rows, best, warnings };
  }

  return {
    roundHalfUp,
    fmtDollars,
    fmtCost,
    fmtCents,
    fmtPct,
    fmtMult,
    fmt2,
    fmtShares,
    parseCSV,
    buildInputs,
    distribution,
    exampleFirm,
    cdssEBIT,
    cdssAtDebt,
    analyzeCDSS,
  };
});
