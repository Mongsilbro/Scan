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
  await t.waitForSelector('#hits .hit').catch(() => {}); await t.$eval('#hits .hit', e => e.scrollIntoView()).catch(() => {}); await t.waitForSelector('#hits canvas.strip', { timeout: 10000 }).catch(() => {});
  check((await t.$$('#hits canvas.strip')).length >= 2, '찾은 곳 그림');
  await t.click('#copyRes'); await t.waitForTimeout(200);
  check(/쪽/.test(await t.evaluate(() => navigator.clipboard.readText())), '결과 복사');

  await (await t.$('#hits .chip')).click(); await t.waitForTimeout(1500);
  check(/노란 상자/.test(await t.textContent('#pvNote')), '미리보기·위치 표시');
  await t.keyboard.press('ArrowRight'); await t.waitForTimeout(1200);
  check(/결과 2\//.test(await t.textContent('#pvPos')), '미리보기 다음 결과');
  await t.keyboard.press('ArrowLeft'); await t.waitForTimeout(1200);       // 쪽이 여럿인 scan.pdf 결과로 돌아감
  const t0 = await t.textContent('#pvTitle'); await t.keyboard.press(/ 1쪽/.test(t0) ? 'PageDown' : 'PageUp'); await t.waitForTimeout(1200);
  const t1 = await t.textContent('#pvTitle');
  check(t0 !== t1 && /\d+쪽/.test(t1), `미리보기 쪽 넘기기: ${t0} → ${t1}`);
  await t.keyboard.press('+'); await t.waitForTimeout(200);
  check(/150%/.test(await t.textContent('#pvZoom')) && await t.$eval('#pv', e => e.clientWidth > e.parentElement.clientWidth), '미리보기 확대: ' + await t.textContent('#pvZoom'));
  await t.keyboard.press('0'); await t.keyboard.press('PageDown'); await t.waitForTimeout(1000);
  await t.click('#pvSave'); await t.waitForTimeout(300);
  let [dl] = await Promise.all([t.waitForEvent('download'), t.click('#svGo')]);
  check(fs.readFileSync(await dl.path()).slice(0, 5).toString() === '%PDF-', '이 쪽 새 PDF로 저장 (pdf-lib)');
  await t.selectOption('#svFile', { label: 'scan.pdf (3쪽)' }); await t.fill('#svPages', '1, 2-3'); await t.check('#svSplit'); await t.waitForTimeout(1700);
  [dl] = await Promise.all([t.waitForEvent('download'), t.click('#svGo')]);
  check(fs.readFileSync(await dl.path()).slice(0, 2).toString() === 'PK', '구역마다 따로 ZIP 저장 (fflate)');
  await t.click('#svClose');
  [dl] = await Promise.all([t.waitForEvent('download'), t.click('#docs .doc button:text("글자 저장")')]);
  check(/=====/.test(fs.readFileSync(await dl.path(), 'utf8')), '인식된 글자 저장');
  [dl] = await Promise.all([t.waitForEvent('download'), t.click('#docs .doc-all button')]);
  const { unzipSync } = require('fflate');
  check(Object.keys(unzipSync(fs.readFileSync(await dl.path()))).length === 3, '모든 파일 글자 한꺼번에 저장(ZIP)');
  await t.fill('#q', '계약기간, 보증금'); await t.waitForTimeout(400);
  [dl] = await Promise.all([t.waitForEvent('download'), t.click('#csvRes')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  check(/^\ufeff찾은 말,파일,쪽/.test(csv) && csv.split('\r\n').length >= 3, `검색 결과 엑셀(CSV) 저장: ${csv.split('\r\n').length - 1}줄`);
  await t.press('#q', 'Enter'); await t.waitForTimeout(200);
  check(await t.$eval('#recentQ', e => [...e.options].some(o => o.value === '계약기간, 보증금')), '최근 검색어 기억');

  // 검색되는 PDF: 옆으로 누운 side.pdf 를 저장해 다시 열면 OCR 없이 글자 정보만으로 찾혀야 함
  [dl] = await Promise.all([t.waitForEvent('download'), t.click('#docs .doc:nth-child(2) button:text("검색되는 PDF")')]);
  const spPath = path.join(require('os').tmpdir(), 'offline-searchable.pdf'); await dl.saveAs(spPath);
  await t.goto(html + '?nocache=1&sp=1' + query); await t.setInputFiles('#file', spPath);
  await t.waitForFunction(() => /분석 완료|오류/.test(document.getElementById('status').textContent), null, { timeout: 300000 });
  const spSt = await t.textContent('#status'); await t.fill('#q', '보증금 반환 청구'); await t.waitForTimeout(400);
  check(/OCR 0쪽/.test(spSt) && (await t.$$eval('#chips .chip', e => e.map(x => x.textContent))).includes('1쪽'), '검색되는 PDF 저장 → 다시 열면 OCR 없이 찾힘');

  // 다시 열기(브라우저에 저장된 결과)도 오프라인에서
  await t.goto(html + '?r=1' + query); await t.click('#clearCache');
  await t.setInputFiles('#file', path.join(FX, 'scan.pdf'));
  await t.waitForFunction(() => /분석 완료|오류/.test(document.getElementById('status').textContent), null, { timeout: 600000 });
  await t.goto(html + '?r=1' + query); await t.setInputFiles('#file', path.join(FX, 'scan.pdf'));
  await t.waitForFunction(() => /불러왔습니다|분석 완료|오류/.test(document.getElementById('status').textContent), null, { timeout: 600000 });
  check(/불러왔습니다/.test(await t.textContent('#status')), '저장된 결과 다시 불러오기');
  await t.goto(html + '?r=2' + query); await t.waitForSelector('.saved-row button', { timeout: 10000 }); await t.click('.saved-row button');
  await t.fill('#q', '손해 배상'); await t.waitForTimeout(400);
  check((await t.$$eval('#chips .chip', e => e.map(x => x.textContent))).includes('3쪽'), '이전에 분석한 파일을 원본 없이 불러와 찾기');
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
