#!/usr/bin/env node
// WCAG 2.1 AA automated audit: crawls a site, runs axe-core on each page,
// and writes a client-facing HTML report plus raw JSON.
//
// Usage: node audit.js <url> [--pages 10] [--out reports/<host>]

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const AXE_SOURCE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const IMPACT_ORDER = ['critical', 'serious', 'moderate', 'minor'];

function parseArgs(argv) {
  const args = { pages: 10, out: null, url: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pages') args.pages = Number(argv[++i]);
    else if (argv[i] === '--out') args.out = argv[++i];
    else args.url = argv[i];
  }
  if (!args.url) {
    console.error('Usage: node audit.js <url> [--pages 10] [--out dir]');
    process.exit(1);
  }
  return args;
}

async function auditPage(page, url, scope) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1500);
  await page.addScriptTag({ content: AXE_SOURCE });
  const result = await page.evaluate(
    (tags) => window.axe.run(document, { runOnly: { type: 'tag', values: tags } }),
    WCAG_TAGS
  );
  const links = await page.$$eval('a[href]', (as) => as.map((a) => a.href));
  const sameOrigin = links
    .map((l) => l.split('#')[0])
    .filter((l) => l.startsWith(scope) && !/\.(pdf|jpg|jpeg|png|gif|zip|svg)$/i.test(l));
  return { url, violations: result.violations, passes: result.passes.length, links: sameOrigin };
}

async function crawl(startUrl, maxPages) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const queue = [startUrl];
  const seen = new Set();
  const results = [];
  // Only follow links under the start URL's directory, so a subsite audit stays on that subsite.
  const scope = startUrl.replace(/[^/]*$/, '');
  while (queue.length && results.length < maxPages) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const r = await auditPage(page, url, scope);
      results.push(r);
      console.log(`[${results.length}/${maxPages}] ${url}: ${r.violations.length} rule violations`);
      for (const l of r.links) if (!seen.has(l)) queue.push(l);
    } catch (err) {
      console.warn(`skip ${url}: ${err.message.split('\n')[0]}`);
    }
  }
  await browser.close();
  return results;
}

// Merge violations across pages by rule id.
function summarize(results) {
  const byRule = new Map();
  for (const r of results) {
    for (const v of r.violations) {
      const entry = byRule.get(v.id) || {
        id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl,
        tags: v.tags.filter((t) => t.startsWith('wcag') && /\d/.test(t)),
        pages: new Set(), count: 0, examples: [],
      };
      entry.pages.add(r.url);
      entry.count += v.nodes.length;
      for (const n of v.nodes) {
        if (entry.examples.length < 3) entry.examples.push({ page: r.url, html: n.html, target: n.target.join(' ') });
      }
      byRule.set(v.id, entry);
    }
  }
  return [...byRule.values()].sort(
    (a, b) => IMPACT_ORDER.indexOf(a.impact) - IMPACT_ORDER.indexOf(b.impact) || b.count - a.count
  );
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderHtml(site, results, rules) {
  const totals = Object.fromEntries(IMPACT_ORDER.map((i) => [i, 0]));
  for (const r of rules) totals[r.impact] += r.count;
  const totalIssues = Object.values(totals).reduce((a, b) => a + b, 0);
  const date = new Date().toISOString().slice(0, 10);
  const rows = rules.map((r) => `
    <section class="rule ${r.impact}">
      <h3><span class="badge">${r.impact}</span> ${esc(r.help)}</h3>
      <p>${r.count} instance(s) on ${r.pages.size} page(s) · WCAG: ${esc(r.tags.join(', ') || 'best practice')} ·
        <a href="${esc(r.helpUrl)}">rule reference</a></p>
      ${r.examples.map((e) => `<pre><b>${esc(e.page)}</b>\n${esc(e.html)}</pre>`).join('')}
    </section>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Accessibility Audit – ${esc(site)}</title>
<style>
:root{--bg:#fff;--fg:#1a1a1a;--muted:#555;--card:#f5f6f8;--crit:#b00020;--ser:#c25400;--mod:#8a6d00;--min:#3a5a8c}
@media (prefers-color-scheme:dark){:root{--bg:#121417;--fg:#e8e8e8;--muted:#aaa;--card:#1d2126}}
body{background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;max-width:960px;margin:0 auto;padding:24px 16px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
.kpi{background:var(--card);padding:12px;border-radius:8px}.kpi b{font-size:28px;display:block}
.rule{background:var(--card);border-left:4px solid var(--min);padding:8px 16px;margin:12px 0;border-radius:6px}
.rule.critical{border-color:var(--crit)}.rule.serious{border-color:var(--ser)}.rule.moderate{border-color:var(--mod)}
.badge{text-transform:uppercase;font-size:12px;padding:2px 6px;border-radius:4px;background:var(--fg);color:var(--bg)}
pre{white-space:pre-wrap;word-break:break-all;font-size:13px;color:var(--muted)}
.note{color:var(--muted);font-size:14px}
</style></head><body>
<h1>Website Accessibility Audit</h1>
<p><b>${esc(site)}</b> · ${date} · Standard: WCAG 2.1 Level AA · Pages scanned: ${results.length}</p>
<div class="kpis">
  <div class="kpi"><b>${totalIssues}</b>issues found</div>
  ${IMPACT_ORDER.map((i) => `<div class="kpi"><b>${totals[i]}</b>${i}</div>`).join('')}
</div>
<h2>Issues by rule</h2>
${rows || '<p>No automatically detectable issues found.</p>'}
<h2>Pages scanned</h2>
<ul>${results.map((r) => `<li>${esc(r.url)} – ${r.violations.length} rule violation(s)</li>`).join('')}</ul>
<p class="note">Automated testing detects roughly a third to a half of WCAG issues. A full conformance review also needs
manual checks (keyboard navigation, screen reader behaviour, meaningful alt text, captions). This report is a technical
assessment, not legal advice.</p>
</body></html>`;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const host = new URL(args.url).hostname;
  const outDir = args.out || path.join(__dirname, 'reports', host);
  fs.mkdirSync(outDir, { recursive: true });
  const results = await crawl(args.url, args.pages);
  const rules = summarize(results);
  const json = rules.map((r) => ({ ...r, pages: [...r.pages] }));
  fs.writeFileSync(path.join(outDir, 'audit.json'), JSON.stringify({ site: args.url, results: results.map(({ links, ...r }) => r), rules: json }, null, 2));
  fs.writeFileSync(path.join(outDir, 'report.html'), renderHtml(host, results, rules));
  console.log(`\n${rules.length} distinct rules violated. Report: ${path.join(outDir, 'report.html')}`);
})();
