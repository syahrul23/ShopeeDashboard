# ShopeeDashboard

Dashboard PWA percuma untuk monitor prestasi Shopee Affiliate cookies dari fail CSV Ads dan Affiliate Commission.

## Cara guna

1. Buka dashboard.
2. Upload fail CSV Ads dan Affiliate Commission.
3. Semak KPI, ranking ad, isu tracking, dan action recommendation.
4. Simpan snapshot kalau mahu compare report lama vs report baru.

CSV diproses dalam browser sahaja. Jangan commit fail CSV sebenar ke repo.

## Deploy GitHub Pages

1. Push repo ini ke `main`.
2. Di GitHub, buka **Settings > Pages**.
3. Pilih **Deploy from a branch**.
4. Pilih branch `main` dan folder `/root`.
5. URL dijangka: `https://syahrul23.github.io/ShopeeDashboard/`.

## Fail utama

- `index.html` - layout dashboard.
- `styles.css` - styling responsive untuk desktop dan phone.
- `app.js` - parser CSV, KPI engine, decision rules, dan snapshot storage.
- `manifest.webmanifest` - metadata PWA.
- `service-worker.js` - cache app shell untuk offline selepas first load.
