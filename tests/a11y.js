// 접근성 시험: node tests/a11y.js dist/pdf-page-finder.html
// axe-core(시험에만 씀, 배포 파일에는 안 넣음)로 처음 화면·검색 결과·미리보기·쪽 저장 창을 밝은/어두운 화면에서 WCAG 2.2 AA 기준으로 점검
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs');
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); let total = 0;
(async () => {
  const b = await chromium.launch(); const t = await b.newPage();
  const run = async (label, scheme) => {
    await t.emulateMedia({ colorScheme: scheme || 'light' });
    await t.addScriptTag({ content: AXE }).catch(() => {});
    const r = await t.evaluate(async () => { const r = await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'] }); return r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, n: v.nodes.length, ex: v.nodes.slice(0, 2).map(n => n.target.join(' ') + ' :: ' + (n.failureSummary || '').split('\n')[1]) })); });
    total += r.length; console.log(`== ${label} (${scheme || 'light'}): 위반 ${r.length}종`); for (const v of r) console.log(` - [${v.impact}] ${v.id} (${v.n}) ${v.help}\n     ${v.ex.join('\n     ')}`);
  };
  await t.goto('file://' + path.resolve(process.argv[2] || 'dist/pdf-page-finder.html') + '?nocache=1'); await t.waitForSelector('#gpuNote');
  await run('처음 화면'); await run('처음 화면', 'dark');
  await t.setInputFiles('#file', [path.join(__dirname, 'fixtures', 'scan.pdf'), path.join(__dirname, 'fixtures', 'side.pdf')]);
  await t.waitForFunction(() => { const s = [...document.querySelectorAll('#docs .doc small')]; return s.length === 2 && s.every(e => /완료/.test(e.textContent)); }, null, { timeout: 300000 });
  await t.fill('#q', '계약, 보증금'); await t.waitForSelector('#hits .hit').catch(() => {}); await t.$eval('#hits .hit', e => e.scrollIntoView()).catch(() => {}); await t.waitForSelector('#hits canvas.strip', { timeout: 10000 }); await t.waitForTimeout(400);
  await run('검색 결과'); await run('검색 결과', 'dark');
  await (await t.$('#hits .chip')).click(); await t.waitForTimeout(1200); await run('미리보기');
  await t.click('#pvClose'); await t.click('#saveRes'); await t.waitForTimeout(300); await run('쪽 저장 창');
  await b.close();
  console.log(total ? `위반 ${total}종` : '모두 통과'); process.exit(total ? 1 : 0);
})();
