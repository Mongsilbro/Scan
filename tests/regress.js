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
  await t.fill('#q', '계약'); await t.waitForTimeout(400);
  const allF = await t.$$eval('#chips .chips', e => e.map(x => x.textContent));
  await t.selectOption('#fFile', { label: 'side.pdf' }); await t.waitForTimeout(300);
  const oneF = await t.$$eval('#chips .chips', e => e.map(x => x.textContent));
  check(allF.length === 2 && oneF.length === 1 && /side/.test(oneF[0]) && /^side\.pdf/.test(await t.textContent('#summary')), `파일 하나만 보기: ${allF.length}개 → ${oneF}`);
  await t.selectOption('#fFile', ''); await t.selectOption('#fSort', 'count'); await t.waitForTimeout(300);
  const cnt = await t.$$eval('#hits .hit small', e => e.map(x => parseInt(x.textContent)));
  check(cnt.length > 1 && cnt.every((v, i) => !i || v <= cnt[i - 1]), `많이 나온 순: ${cnt}`);
  await t.selectOption('#fSort', 'page');
  // 찾은 곳 그림: 결과마다 찾은 줄 둘레를 그림으로, 누르면 미리보기, 끄면 사라짐
  await t.fill('#q', '손해 배상'); await t.waitForFunction(() => /"손해 배상"/.test(document.getElementById('summary').textContent)); await t.waitForSelector('#hits .hit').catch(() => {}); await t.$eval('#hits .hit', e => e.scrollIntoView()).catch(() => {}); await t.waitForSelector('#hits canvas.strip', { timeout: 10000 }).catch(() => {});
  const strips = await t.$$eval('#hits canvas.strip', e => e.map(c => [c.width, c.height]));
  const yellow = await t.$eval('#hits canvas.strip', c => { const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < px.length; i += 4) if (px[i] > 200 && px[i + 1] > 150 && px[i + 2] < 120) n++; return n; }).catch(() => 0);
  check(strips.length >= 1 && strips[0][1] > 20 && strips[0][1] < strips[0][0] / 3 && yellow > 50, `찾은 곳 그림: ${strips.map(s => s.join('x'))} (노란 표시 ${yellow}점)`);
  await t.click('#hits canvas.strip'); await t.waitForTimeout(1200);
  check(await t.$eval('#dlg', x => x.open) && /노란 상자/.test(await t.textContent('#pvNote')), '찾은 곳 그림을 누르면 미리보기');
  await t.click('#pvClose');
  await t.uncheck('#fImg'); await t.waitForTimeout(300);
  check(!(await t.$$('#hits canvas.strip')).length, '"찾은 곳 그림 보기"를 끄면 글자만');
  await t.check('#fImg');
  const [dl] = await Promise.all([t.waitForEvent('download'), t.click('#docs .doc button:text("글자 저장")')]);
  const txt = require('fs').readFileSync(await dl.path(), 'utf8');
  check(/===== 2쪽 =====/.test(txt) && txt.length > 100, `인식된 글자 저장 (${txt.length}자)`);
  check(/분석 완료/.test(await t.title()), `탭 제목: ${await t.title()}`);

  console.log('고른 쪽 새 PDF로 저장');
  {
    const { PDFDocument } = require('pdf-lib'), { unzipSync } = require('fflate'), fs = require('fs');
    await t.fill('#q', '계약'); await t.waitForTimeout(400);
    await t.click('#saveRes'); await t.waitForTimeout(200);
    const pre = await t.inputValue('#svPages');
    check(/^1-2$/.test(pre) || /1/.test(pre), `찾은 쪽이 미리 채워짐: "${pre}" (${await t.$eval('#svFile', e => e.selectedOptions[0].textContent)})`);
    await t.selectOption('#svFile', { label: 'scan.pdf (3쪽)' });
    await t.fill('#svPages', '1-2, 3'); await t.check('#svOne');
    let [dl] = await Promise.all([t.waitForEvent('download'), t.click('#svGo')]);
    const one = await PDFDocument.load(fs.readFileSync(await dl.path()));
    check(one.getPageCount() === 3, `한 PDF로: ${one.getPageCount()}쪽`);
    await t.fill('#svPages', '1-2, 3'); await t.check('#svSplit'); await t.waitForTimeout(1600);
    [dl] = await Promise.all([t.waitForEvent('download'), t.click('#svGo')]);
    const zip = unzipSync(fs.readFileSync(await dl.path())), names = Object.keys(zip);
    const counts = await Promise.all(names.map(async n => (await PDFDocument.load(zip[n])).getPageCount()));
    check(names.length === 2 && counts.join() === '2,1', `구역마다 따로(ZIP): ${names.join(' / ')} → ${counts.join(', ')}쪽`);
    await t.fill('#svPages', '0, 9'); await t.waitForTimeout(100);
    check(await t.$eval('#svGo', e => e.disabled) && /알아볼 수 없는/.test(await t.textContent('#svNote')), '잘못 적은 쪽은 알려 주고 저장 안 함');
    await t.click('#svClose');
  }

  console.log('검색 기호·여러 색');
  {
    await t.goto(html + '?nocache=1'); await t.setInputFiles('#file', path.join(FX, 'scan.pdf'));
    await t.waitForFunction(() => /분석 완료|오류/.test(document.getElementById('status').textContent), null, { timeout: 300000 });
    const chips = async q => { await t.fill('#q', q); await t.waitForTimeout(400); return t.$$eval('#chips .chip', e => e.map(x => x.textContent)); };
    const a1 = await chips('계약'), a2 = await chips('계약, -계약기간');
    check(a1.includes('2쪽') && !a2.includes('2쪽') && a2.length === a1.length - 1 && /뺌/.test(await t.textContent('#summary')), `-낱말로 빼기: [${a1}] → [${a2}]`);
    const b1 = await chips('손해를 베상하여야'), b2 = await chips('"손해를 베상하여야"');
    check(b1.some(c => /\?/.test(c)) && b2.length === 0, `"따옴표"는 정확히만: [${b1}] → [${b2}]`);
    check((await chips('-33-')).length >= 0 && !/빼는 말/.test(await t.textContent('#summary')), '-33- 같은 숫자는 빼기로 보지 않음');
    await chips('계약기간, 1월');
    await (await t.$('#hits .term .chip')).click(); await t.waitForTimeout(1500);
    const sw = await t.$$eval('#pvNote .swatch', e => e.length);
    check(sw === 2, `미리보기에서 낱말마다 다른 색: ${(await t.textContent('#pvNote')).slice(0, 60)}`);
    await t.click('#pvClose');
  }

  console.log('이전에 분석한 파일(원본 없이) 찾기');
  {
    await t.goto(html); await t.click('#clearCache'); await t.waitForTimeout(200);
    await t.setInputFiles('#file', [path.join(FX, 'scan.pdf'), path.join(FX, 'side.pdf')]);
    await t.waitForFunction(() => { const s = [...document.querySelectorAll('#docs .doc small')]; return s.length === 2 && s.every(e => /완료/.test(e.textContent)); }, null, { timeout: 600000 });
    await t.goto(html + '?again=1'); await t.waitForSelector('.saved-row button', { timeout: 10000 });
    const label = await t.textContent('.saved-row button'); await t.click('.saved-row button'); await t.waitForTimeout(300);
    const rows = await t.$$eval('#docs .doc small', e => e.map(x => x.textContent));
    check(/2개/.test(label) && rows.length === 2 && rows.every(r => /저장된 결과/.test(r)), `불러오기: ${label} → ${rows.join(' / ')}`);
    await t.fill('#q', '보증금 반환 청구'); await t.waitForTimeout(400);
    const f = await t.$$eval('#chips .chips', e => e.map(x => x.textContent));
    check(f.some(x => /side\.pdf/.test(x) && /1쪽/.test(x)), `원본 없이 찾기: ${f}`);
    await (await t.$('#chips .chip')).click(); await t.waitForTimeout(600);
    check(/원본 PDF 없이/.test(await t.textContent('#pvNote')) && /보증금/.test(await t.textContent('#pvText')), '미리보기는 인식된 글자로');
    await t.click('#pvClose');
    await t.setInputFiles('#file', path.join(FX, 'scan.pdf'));
    await t.waitForFunction(() => [...document.querySelectorAll('#docs .doc small')].some(e => /완료/.test(e.textContent)), null, { timeout: 120000 });
    const rows2 = await t.$$eval('#docs .doc', e => e.map(x => x.textContent));
    check(rows2.length === 2 && rows2.some(r => /scan\.pdf/.test(r) && /완료/.test(r) && /검색되는 PDF/.test(r)), `원본을 넣으면 그 항목을 대신함: ${rows2.length}개`);
    await t.click('#clearCache');
  }

  console.log('검색되는 PDF');
  {
    const os = require('os'), fs = require('fs');
    await t.goto(html + '?nocache=1');
    await t.setInputFiles('#file', [path.join(FX, 'scan.pdf'), path.join(FX, 'side_up.pdf')]);
    await t.waitForFunction(() => { const s = [...document.querySelectorAll('#docs .doc small')]; return s.length === 2 && s.every(e => /완료/.test(e.textContent)); }, null, { timeout: 600000 });
    for (const [i, f, q, pg] of [[1, 'scan', '손해 배상', 3], [2, 'side_up', '보증금 반환 청구', 1]]) {
      const [dl] = await Promise.all([t.waitForEvent('download'), t.click(`#docs .doc:nth-child(${i}) button:text("검색되는 PDF")`)]);
      const out = path.join(os.tmpdir(), `regress-${f}-searchable.pdf`); await dl.saveAs(out);
      const t2 = await ctx.newPage(); await t2.goto(html + '?nocache=1');
      await t2.setInputFiles('#file', out);
      await t2.waitForFunction(() => /분석 완료|오류/.test(document.getElementById('status').textContent), null, { timeout: 300000 });
      const st = await t2.textContent('#status'); await t2.fill('#q', q); await t2.waitForTimeout(400);
      const got = await t2.$$eval('#chips .chip', e => e.map(x => x.textContent));
      await (await t2.$('#chips .chip')).click(); await t2.waitForTimeout(1200);
      check(/OCR 0쪽/.test(st) && got.includes(pg + '쪽') && /노란 상자/.test(await t2.textContent('#pvNote')), `${f}: 저장한 PDF를 다시 열면 OCR 없이 "${q}" → ${got} · 위치 표시`);
      await t2.close(); fs.unlinkSync(out);
    }
  }

  console.log('사용법');
  await t.goto(html); await t.click('.guide summary'); check(/검색되는 PDF/.test(await t.textContent('.guide')), '화면 안 사용법');

  console.log('네트워크');
  check(net === 0, `외부 접속 시도 ${net}건`);
  await b.close();
  console.log(fails ? `실패 ${fails}건` : '모두 통과');
  process.exit(fails ? 1 : 0);
})();
