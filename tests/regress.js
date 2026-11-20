// 회귀 테스트: node tests/regress.js dist/pdf-page-finder.html
// 네트워크를 모두 차단한 브라우저에서 시험용 PDF를 분석하고, 찾아야 할 쪽·위치 표시·결과 저장을 확인한다.
// 실패가 하나라도 있으면 종료 코드 1.
const { chromium } = require('playwright');
const path = require('path');
const FX = path.join(__dirname, 'fixtures');
const html = 'file://' + path.resolve(process.argv[2] || 'dist/pdf-page-finder.html');

// [파일, [검색어, 기대 결과(쪽 번호 배열, 빈 배열 = 없어야 함)]...]
const CASES = [
  ['scan.pdf', [['계약기간', [2]], ['손해 배상', [3]], ['payment', [2]], ['없는말', []]]],     // 깨끗한 스캔 3쪽
  ['text.pdf', [['텍스트검색', [1]]]],                                                          // 글자 정보가 있는 일반 PDF
  ['side.pdf', [['보증금 반환 청구', [1]], ['deposit', [1]]]],                                  // 옆으로 누운 쪽(위→아래)
  ['side_up.pdf', [['보증금 반환 청구', [1]]]],                                                 // 옆으로 누운 쪽(아래→위)
  ['flip.pdf', [['스마트공장 인력양성', [1]]]],                                                 // 위아래가 뒤집힌 표
];

let fails = 0;
const check = (ok, msg) => { console.log((ok ? '  ✓ ' : '  ✗ ') + msg); if (!ok) fails++; };

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext();
  let net = 0;
  await ctx.route(/^https?:/, r => { net++; r.abort(); });
  const t = await ctx.newPage();
  t.on('pageerror', e => { console.log('  ✗ 페이지 오류: ' + e.message); fails++; });
  const analyze = async (file, query = '') => {
    await t.goto(html + query);
    const t0 = Date.now();
    await t.setInputFiles('#file', path.join(FX, file));
    await t.waitForFunction(() => /분석 완료|불러왔습니다|오류/.test(document.getElementById('status').textContent), null, { timeout: 600000 });
    return { sec: (Date.now() - t0) / 1000, status: await t.textContent('#status') };
  };
  const pagesFor = async q => {
    await t.fill('#q', q); await t.waitForTimeout(400);
    return (await t.$$eval('#chips .chip', els => els.map(e => parseInt(e.textContent, 10))));
  };

  for (const [file, qs] of CASES) {
    console.log(file);
    const r = await analyze(file, '?nocache=1');
    check(!/오류/.test(r.status), `분석 완료 (${r.sec.toFixed(1)}초)`);
    for (const [q, want] of qs) {
      const got = await pagesFor(q);
      check(JSON.stringify(got) === JSON.stringify(want), `"${q}" → [${got}] (기대 [${want}])`);
    }
    // 첫 검색어로 미리보기 위치 표시 확인
    const [q0, w0] = qs[0];
    if (w0.length) {
      await pagesFor(q0);
      await (await t.$('#chips .chip')).click(); await t.waitForTimeout(1200);
      const note = await t.textContent('#pvNote');
      check(/노란 상자/.test(note), `미리보기 위치 표시: ${note.slice(0, 40)}`);
      await t.click('#pvClose');
    }
  }

  console.log('결과 저장');
  await t.goto(html); await t.click('#clearCache'); await t.waitForTimeout(200);
  const first = await analyze('scan.pdf');
  const again = await analyze('scan.pdf');
  check(/불러왔습니다/.test(again.status) && again.sec < 3, `다시 열면 저장된 결과 사용 (${first.sec.toFixed(1)}초 → ${again.sec.toFixed(1)}초)`);
  check(JSON.stringify(await pagesFor('손해 배상')) === '[3]', '저장된 결과로도 검색됨');
  await t.click('#clearCache');

  console.log('여러 파일·여러 낱말');
  await t.goto(html + '?nocache=1');
  await t.setInputFiles('#file', [path.join(FX, 'scan.pdf'), path.join(FX, 'side.pdf')]);
  await t.waitForFunction(() => document.querySelectorAll('#docs .doc').length === 2 && [...document.querySelectorAll('#docs .doc small')].every(e => /완료/.test(e.textContent)), null, { timeout: 600000 });
  check(true, '파일 2개 차례로 분석 완료');
  await t.fill('#q', '보증금 반환 청구'); await t.waitForTimeout(400);
  const f1 = await t.$$eval('#chips .chips', els => els.map(e => e.textContent));
  check(f1.length === 1 && /side\.pdf/.test(f1[0]) && /1쪽/.test(f1[0]), `다른 파일의 낱말도 찾음: ${f1}`);
  await t.fill('#q', '계약기간, 손해 배상'); await t.waitForTimeout(400);
  const terms = await t.$$eval('#hits .term-head', els => els.map(e => e.textContent));
  check(terms.length === 3 && /모두 들어 있는 쪽은 없습니다/.test(terms[0]) && /계약기간/.test(terms[1]) && /손해 배상/.test(terms[2]), `낱말 2개 따로 찾기: ${terms.join(' | ')}`);
  await t.fill('#q', '1,000'); await t.waitForTimeout(400);
  check(!(await t.$$('#hits .term-head')).length, '숫자 사이 쉼표(1,000)는 낱말을 나누지 않음');
  await t.fill('#q', '계약기간, 손해 배상'); await t.waitForTimeout(400);
  await (await t.$('#hits .chip')).click(); await t.waitForTimeout(1200);
  const pos1 = await t.textContent('#pvPos'); await t.keyboard.press('ArrowRight'); await t.waitForTimeout(1200);
  const pos2 = await t.textContent('#pvPos'), title2 = await t.textContent('#pvTitle');
  check(/결과 1\//.test(pos1) && /결과 2\//.test(pos2), `미리보기에서 다음 결과로 넘기기: ${pos1} → ${pos2} (${title2})`);
  await t.click('#pvClose');
  const [dl] = await Promise.all([t.waitForEvent('download'), t.click('#docs .doc button:text("글자 저장")')]);
  const txt = require('fs').readFileSync(await dl.path(), 'utf8');
  check(/===== 2쪽 =====/.test(txt) && txt.length > 100, `인식된 글자 저장 (${txt.length}자)`);
  check(/분석 완료/.test(await t.title()), `탭 제목: ${await t.title()}`);

  console.log('네트워크');
  check(net === 0, `외부 접속 시도 ${net}건`);
  await b.close();
  console.log(fails ? `실패 ${fails}건` : '모두 통과');
  process.exit(fails ? 1 : 0);
})();
