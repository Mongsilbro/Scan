// 사용: [WAIT=5000] T=table2 node tests/bench.js dist/pdf-page-finder.html [selector=value ...]
// 네트워크 차단 상태에서 tests/fixtures/<T>.pdf 를 분석해 걸린 시간, 키워드 적중률, 글자 정확도를 잼 (T: table2 | hard2)
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path');
const FX = path.join(__dirname, 'fixtures');
(async () => {
  const KEY = JSON.parse(fs.readFileSync(path.join(FX, (process.env.T || 'table2') + '.json')));
  const b = await chromium.launch(); const ctx = await b.newContext();
  await ctx.route(/^https?:/, r => { console.log('NETWORK', r.request().url()); r.abort(); });
  const t = await ctx.newPage();
  t.on('pageerror', e => console.log('pageerror:', e.message.slice(0, 300)));
  await t.goto('file://' + path.resolve(process.argv[2]) + '?nocache=1');
  for (const a of process.argv.slice(3)) { const [sel, val] = a.split('='); if (val === 'off') await t.uncheck(sel); else if (val === 'on') await t.check(sel); else await t.selectOption(sel, val); }
  if (process.env.WAIT) await t.waitForTimeout(+process.env.WAIT);   // 사용자가 파일을 고르는 시간 흉내 (엔진 미리 준비 효과 측정)
  const t0 = Date.now();
  await t.setInputFiles('#file', path.join(FX, (process.env.T || 'table2') + '.pdf'));
  await t.waitForFunction(() => /분석 완료|오류/.test(document.getElementById('status').textContent), null, { timeout: 600000 });
  const sec = (Date.now() - t0) / 1000;
  console.log('status:', await t.textContent('#status'));
  let ok = 0, n = 0, fz = 0, extra = 0; const miss = [];
  for (let pg = 0; pg < KEY.length; pg++) for (const k of KEY[pg]) {
    n++; await t.fill('#q', k); await t.waitForTimeout(400);
    const chips = await t.$$eval('#chips .chip', els => els.map(e => e.textContent));
    const want = (pg + 1) + '쪽';
    if (chips.includes(want)) ok++; else if (chips.includes(want + ' ?')) { ok++; fz++; } else miss.push(`${k}(기대 ${pg + 1}쪽, 결과 [${chips}])`);
    extra += chips.filter(c => !c.startsWith(want)).length;
  }
  console.log(`오탐(엉뚱한 쪽) ${extra}건, 비슷한 표현으로 찾은 것 ${fz}건`);
  const gtFile = path.join(FX, (process.env.T || 'table2') + '.gt.json');
  if (fs.existsSync(gtFile)) {      // 글자 단위 정확도: 정답의 3글자 조각이 인식 결과에 들어 있는 비율
    const GT = JSON.parse(fs.readFileSync(gtFile)); const got = await t.evaluate(() => window.__pages ? window.__pages() : []);
    const norm = s => (s.normalize('NFC').toLowerCase().match(/[\p{L}\p{N}]/gu) || []).join(''); let hit = 0, tot = 0;
    GT.forEach((g, i) => { const a = norm(g), o = norm(got[i] || ''); for (let k = 0; k + 3 <= a.length; k++) { tot++; if (o.includes(a.substr(k, 3))) hit++; } });
    console.log(`글자 정확도(3글자 조각 재현율) ${(hit / tot * 100).toFixed(1)}%`);
  }
  console.log(`시간 ${sec.toFixed(1)}초 (${KEY.length}쪽), 적중 ${ok}/${n}`); if (miss.length) console.log('실패:', miss.join(' | '));
  await b.close();
})();
