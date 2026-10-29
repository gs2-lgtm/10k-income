# a11y-audit

Automated WCAG 2.1 AA audit: crawls a site with Playwright, runs axe-core on each page, and writes a client-facing HTML report plus raw JSON.

```bash
npm install
node audit.js https://example.com --pages 20
```

Output goes to `reports/<host>/report.html` and `reports/<host>/audit.json`. Automated checks catch only part of WCAG; pair every report with manual keyboard, screen reader, alt text and contrast review.
