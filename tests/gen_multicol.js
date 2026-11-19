// 시험용 스캔 PDF 생성 (tests/fixtures/hard2.pdf, .json 키워드, .gt.json 정답 글자). npm install 뒤 node tests/gen_multicol.js
// 실제 스캔과 비슷한 시험용 PDF 생성: 2단 편집, 작은 글씨, 표, 약간 기울어짐, 흐림, 회색 배경
const { chromium } = require('playwright'); const path = require('path');
const NM = path.resolve(__dirname, '../node_modules'), FX = path.join(__dirname, 'fixtures');
const fs = require('fs');
const S = [
 '본 계약의 당사자는 신의성실의 원칙에 따라 계약상의 의무를 이행하여야 한다.',
 '공급자는 납품 기한 내에 물품을 지정된 장소에 인도하여야 하며 지연 시 지체상금을 부담한다.',
 '대금은 검수 완료일로부터 삼십 일 이내에 지정 계좌로 지급한다.',
 '당사자 일방이 의무를 위반한 경우 상대방은 서면으로 시정을 요구할 수 있다.',
 '불가항력으로 인한 이행 지연에 대하여는 책임을 지지 아니한다.',
 '본 계약과 관련하여 취득한 영업비밀은 제삼자에게 누설하여서는 아니 된다.',
 '분쟁이 발생한 경우 관할 법원은 서울중앙지방법원으로 한다.',
 'The supplier shall deliver the goods within the agreed period.',
 '하자가 발견된 때에는 지체 없이 통지하고 보수 또는 교환을 청구할 수 있다.',
 '계약의 변경은 양 당사자의 서면 합의에 의하여만 효력이 있다.',
 '보증 기간은 인도일로부터 일 년으로 하며 소모품은 제외한다.',
 'Payment terms and invoicing procedures are described in the appendix.',
];
const KEY = [
 ['손해배상의 범위', '지식재산권 귀속', 'confidential information', '검수 기준표', '각주 참조 번호', '연대보증인'],
 ['계약 해지 사유', '개인정보 처리 위탁', 'termination notice', '납품 일정표', '부속 합의서', '이행보증보험'],
 ['하도급 제한', '비밀유지 의무 기간', 'force majeure', '단가 산정 내역', '검사 성적서', '선급금 반환'],
 ['유지보수 범위', '양도 금지 조항', 'governing law', '위약금 산정', '기성 검사원', '지연이자율'],
 ['재판 관할 합의', '품질 보증 책임', 'indemnification clause', '공정 진행표', '설계 변경 요청서', '부가가치세 별도'],
 ['권리 의무의 승계', '안전 관리 계획', 'limitation of liability', '자재 반입 목록', '준공 검사 조서', '물가 변동 조정'],
 ['통지 방법과 효력', '산업재해 보상', 'entire agreement', '투입 인력 명세', '하자 보수 보증금', '잔금 지급 조건'],
 ['계약 기간의 연장', '기술 자료 임치', 'severability provision', '월별 청구 금액', '인수인계 확인서', '원상회복 의무'],
];
const setHtml = async (p, html) => { fs.writeFileSync(path.join(FX, '_gen.html'), '<meta charset="utf-8">' + html); await p.goto('file://' + path.join(FX, '_gen.html')); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(300); await p.evaluate(() => document.fonts.ready); };
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1240, height: 1754 } }); // A4 150dpi
  const imgs = [], GT = [];
  for (let pg = 0; pg < KEY.length; pg++) {
    let seed = pg * 7 + 3; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const para = () => Array.from({ length: 4 }, () => S[Math.floor(rnd() * S.length)]).join(' ');
    const k = KEY[pg];
    const body = `<h2>제${pg + 5}장 ${k[0]}</h2><div class="cols">
      <p>${para()}</p><h3>${k[1]}</h3><p>${para()} 이 조항에서 ${k[1]}에 관한 사항을 정한다.</p><p>${para()}</p>
      <p>${para()} ${k[2]} shall be handled as follows.</p><p>${para()}</p><p>${para()}</p></div>
      <table><tr><th>구분</th><th>${k[3]}</th><th>비고</th></tr><tr><td>1</td><td>${S[2]}</td><td>필수</td></tr><tr><td>2</td><td>${S[10]}</td><td>선택</td></tr></table>
      <p class="fn">주) ${k[4]}: ${S[5]} 또한 ${k[5]} 관련 사항은 별지에 따른다.</p><div class="foot">- ${pg + 1} -</div>`;
    await setHtml(p, `<link rel="stylesheet" href="file://${NM}/@fontsource/nanum-myeongjo/400.css"><link rel="stylesheet" href="file://${NM}/@fontsource/nanum-myeongjo/700.css"><style>body{margin:0;background:#cfcabb}
      .page{position:absolute;inset:0;padding:110px 100px;font:${15 + pg % 4 * 1.5}px/1.75 'Nanum Myeongjo';color:#2a2a2a;transform:rotate(${pg % 2 ? -0.8 : 0.7}deg);filter:blur(${pg % 3 === 2 ? .8 : .5}px)}
      h2{font-size:24px;margin:0 0 14px}h3{font-size:18px;margin:8px 0}.cols{column-count:2;column-gap:44px;text-align:justify}p{margin:0 0 10px}
      table{border-collapse:collapse;width:100%;margin-top:18px}td,th{border:1px solid #444;padding:5px 8px;font-size:15px}.fn{font-size:13px;margin-top:14px}.foot{text-align:center;margin-top:20px}</style><div class="page">${body}</div>`);
    GT.push(await p.evaluate(() => document.body.innerText));
    imgs.push((await p.screenshot({ type: 'jpeg', quality: 55 })).toString('base64'));
  }
  await p.setContent(imgs.map(i => `<img src="data:image/jpeg;base64,${i}" style="width:100%;display:block;page-break-after:always">`).join(''));
  await p.pdf({ path: path.join(FX, 'hard2.pdf'), format: 'A4', margin: { top: 0, bottom: 0, left: 0, right: 0 } });
  fs.writeFileSync(path.join(FX, 'hard2.json'), JSON.stringify(KEY)); fs.writeFileSync(path.join(FX, 'hard2.gt.json'), JSON.stringify(GT));
  const v = await b.newPage({ viewport: { width: 1240, height: 1754 } });
  await v.setContent(`<img src="data:image/jpeg;base64,${imgs[0]}" style="width:100%">`); await v.screenshot({ path: path.join(FX, 'hard2-p1.png') });
  await b.close();
})();
