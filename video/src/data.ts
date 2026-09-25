// Every number the cards draw, read from the harness output rather than typed.
// check.mjs covers the spoken lines and lower thirds in script.json the same way.
import e from './eval.json'; // written by check.mjs from data/eval-latest.json

const f = (x: number, d: number) => x.toFixed(d);
const thousands = (x: number) => x.toLocaleString('en-US');
const b = e.depth_bands;

export const bands = [
  { band: '0–300 m', argo: b['0-300 m'].argo.rmse, glider: b['0-300 m'].glider.rmse },
  { band: '300–950 m', argo: b['300-950 m'].argo.rmse, glider: b['300-950 m'].glider.rmse },
  { band: '950–2000 m', argo: b['950-2000 m'].argo.rmse, glider: b['950-2000 m'].glider.rmse },
].map((r) => ({ ...r, argoLabel: f(r.argo, 2), gliderLabel: f(r.glider, 2) }));

export const qc = {
  max: f(e.field_range_test.failed_range[1], 2),
  lo: String(e.field_range_test.limits[0]).replace('-', '−'),
  hi: f(e.field_range_test.limits[1], 0),
  failed: e.field_range_test.failed,
  checked: thousands(e.field_range_test.checked_cells),
};

const v2 = e.v2;
export const evidence = [
  { value: String(v2.catalog.variables), label: `variables, ${v2.catalog.depth_resolved} of them by depth` },
  { value: v2.catalog.first_day.slice(0, 4) + ' →', label: `every day since, to ${v2.catalog.last_day} (forecast)` },
  { value: String(v2.hero.levels), label: `native levels, Amphan block, to ${v2.hero.deepest_level_m} m` },
  { value: `${e.residual.coverage_percent} %`, label: 'of Bay cells hold any observation' },
  { value: f(b['0-300 m'].glider.rmse, 2) + ' °C', label: 'independent glider error, top 300 m' },
  { value: `${v2.hosting.requests_ok} / ${v2.hosting.requests}`, label: 'API requests answered, measured run' },
];

export const harnessCommand = 'python -m server.eval.run_eval --json';
export const repo = 'github.com/Kukyos/VVater';
export const live = 'v-vater.vercel.app';
