// 오프라인 시험: node tests/offline.js dist/pdf-page-finder.html
// 인터넷을 끊은 브라우저에서 모든 기능(분석·여러 파일·검색·미리보기·결과 복사·쪽 저장·글자 저장·그래픽카드 판독)을 써 보고,
// 파일 밖(file:·blob:·data: 아닌 곳)으로 나간 요청이 하나라도 있으면 실패. 그래픽카드는 소프트웨어 WebGPU로 강제로 켜서 시험.
const { chromium } = require('playwright');
const path = require('path'), fs = require('fs');
const FX = path.join(__dirname, 'fixtures');
const html = 'file://' + path.resolve(process.argv[2] || 'dist/pdf-page-finder.html');
let fails = 0;
const check = (ok, msg) => { console.log((ok ? '  ✓ ' : '  ✗ ') + msg); if (!ok) fails++; };

async function run(label, args, query) {
  console.log(label);
  const b = await chromium.launch({ args });
  const ctx = await b.newContext({ acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
  await ctx.setOffline(true);                                   // 인터넷 끊음
  const outside = [];
  const note = u => { if (!/^(file|blob|data|about|chrome-error):/.test(u)) outside.push(u); };
  ctx.on('request', r => note(r.url()));                        // 쪽과 작업자(백그라운드)의 요청 모두
  await ctx.route(/^(https?|wss?|ftp):/, r => { note(r.request().url()); r.abort(); });
  const t = await ctx.newPage();
  const errs = []; t.on('pageerror', e => errs.push(e.message));
  t.on('console', m => { if (m.type() === 'error' && !/WebGPU|webgpu|GPU/.test(m.text())) errs.push(m.text().slice(0, 200)); });

  await t.goto(html + '?nocache=1' + query);
  if (/force/.test(query)) {
    await t.waitForFunction(() => /사용함|안 씀/.test((document.getElementById('gpuNote') || {}).textContent || ''), null, { timeout: 300000 });
    check(/사용함/.test(await t.textContent('#gpuNote')), '그래픽카드 엔진 준비: ' + (await t.textContent('#gpuNote')).replace(/^.*그래픽카드: /, ''));
  }
  await t.setInputFiles('#file', ['scan.pdf', 'side.pdf', 'text.pdf'].map(f => path.join(FX, f)));
  await t.waitForFunction(() => { const s = [...document.querySelectorAll('#docs .doc small')]; return s.length === 3 && s.every(e => /완료|오류/.test(e.textContent)); }, null, { timeout: 900000 });
  const states = await t.$$eval('#docs .doc small', els => els.map(e => e.textContent));
  check(states.every(s => /완료/.test(s)), '파일 3개 분석: ' + states.join(' / '));
  check(!/신경망 엔진을 쓸 수 없어/.test(await t.textContent('#status')), '정밀 판독(신경망) 동작');

  await t.fill('#q', '계약기간, 보증금'); await t.waitForTimeout(500);
  const heads = await t.$$eval('#hits .term-head', els => els.map(e => e.textContent));
  check(heads.length === 3 && !heads.slice(1).some(h => /없음/.test(h)), '여러 낱말·여러 파일 검색: ' + heads.slice(1).join(' | '));
  await t.click('#copyRes'); await t.waitForTimeout(200);
  check(/쪽/.test(await t.evaluate(() => navigator.clipboard.readText())), '결과 복사');

  await (await t.$('#hits .chip')).click(); await t.waitForTimeout(1500);
  check(/노란 상자/.test(await t.textContent('#pvNote')), '미리보기·위치 표시');
  await t.keyboard.press('ArrowRight'); await t.waitForTimeout(1200);
  check(/결과 2\//.test(await t.textContent('#pvPos')), '미리보기 다음 결과');
  await t.click('#pvSave'); await t.waitForTimeout(300);
  let [dl] = await Promise.all([t.waitForEvent('download'), t.click('#svGo')]);
  check(fs.readFileSync(await dl.path()).slice(0, 5).toString() === '%PDF-', '이 쪽 새 PDF로 저장 (pdf-lib)');
  await t.selectOption('#svFile', { label: 'scan.pdf (3쪽)' }); await t.fill('#svPages', '1, 2-3'); await t.check('#svSplit'); await t.waitForTimeout(1700);
  [dl] = await Promise.all([t.waitForEvent('download'), t.click('#svGo')]);
  check(fs.readFileSync(await dl.path()).slice(0, 2).toString() === 'PK', '구역마다 따로 ZIP 저장 (fflate)');
  await t.click('#svClose');
  [dl] = await Promise.all([t.waitForEvent('download'), t.click('#docs .doc button:text("글자 저장")')]);
  check(/=====/.test(fs.readFileSync(await dl.path(), 'utf8')), '인식된 글자 저장');

  // 다시 열기(브라우저에 저장된 결과)도 오프라인에서
  await t.goto(html + '?r=1' + query); await t.click('#clearCache');
  await t.setInputFiles('#file', path.join(FX, 'scan.pdf'));
  await t.waitForFunction(() => /분석 완료|오류/.test(document.getElementById('status').textContent), null, { timeout: 600000 });
  await t.goto(html + '?r=1' + query); await t.setInputFiles('#file', path.join(FX, 'scan.pdf'));
  await t.waitForFunction(() => /불러왔습니다|분석 완료|오류/.test(document.getElementById('status').textContent), null, { timeout: 600000 });
  check(/불러왔습니다/.test(await t.textContent('#status')), '저장된 결과 다시 불러오기');
  await t.click('#clearCache');

  check(!errs.length, '오류 없음' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  check(!outside.length, `파일 밖으로 나간 요청 ${outside.length}건` + (outside.length ? ': ' + [...new Set(outside)].slice(0, 5).join(', ') : ''));
  await b.close();
}

(async () => {
  await run('보통 (CPU)', [], '');
  await run('그래픽카드 판독 강제 (소프트웨어 WebGPU)', ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader'], '&gpu=force');
  console.log(fails ? `실패 ${fails}건` : '모두 통과');
  process.exit(fails ? 1 : 0);
})();
