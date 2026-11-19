// 시험용 스캔 PDF 생성 (tests/fixtures/table2.pdf, .json 키워드, .gt.json 정답 글자). npm install 뒤 node tests/gen_table.js
// 사용자가 보여준 문서 느낌의 시험 스캔: 굵은 고딕, 테두리 표, 좁은 칸에서 줄바꿈, 흑백 2값화 + 잡티 + 약간 기울어짐
const { chromium } = require('playwright'); const path = require('path');
const NM = path.resolve(__dirname, '../node_modules'), FX = path.join(__dirname, 'fixtures'); const fs = require('fs');
const A = ['로봇산업','바이오산업','인공지능','의료기기','국가로봇','반도체','지능형','이차전지','수소연료','미래자동차','디스플레이','항공우주','탄소중립','스마트공장','양자기술','첨단소재'];
const B = ['기술개발','생태계조성','인력양성','실증지원','기반구축','밸리데이션','공정용 소재개발','표준화지원','사업화촉진','국제협력'];
const ACC = ['반도체산업 경쟁력강화 특별회계','일반회계','일반회계','에너지및자원사업 특별회계','소재부품장비 경쟁력강화 특별회계','정보통신진흥기금','일반회계','과학기술진흥기금'];
const DEPT = ['산업통상자원부','과학기술정보통신부','중소벤처기업부','보건복지부','국토교통부'];
const DESC = ['핵심 부품 국산화와 수요기업 연계 실증을 지원', '지역 거점 센터 구축 및 전문인력 양성 과정 운영', '시험·인증 장비 확충과 공동 활용 체계 마련', '해외 공동연구 및 표준 선점을 위한 협력 사업 추진', '초기 시장 창출을 위한 공공 조달 연계 시범사업'];
const setHtml = async (p, html) => { fs.writeFileSync(path.join(FX, '_gen.html'), '<meta charset="utf-8">' + html); await p.goto('file://' + path.join(FX, '_gen.html')); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(300); await p.evaluate(() => document.fonts.ready); };
(async () => {
  const PAGES = 6, ROWS = 11; let seed = 11; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const combos = []; for (const a of A) for (const b of B) combos.push([a, b]);
  for (let i = combos.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [combos[i], combos[j]] = [combos[j], combos[i]]; }
  const KEY = [];
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1654, height: 2339 } }); // A4 200dpi
  const imgs = [], GT = [];
  for (let pg = 0; pg < PAGES; pg++) {
    const keys = []; let rows = '';
    for (let r = 0; r < ROWS; r++) {
      const [a, bb] = combos[pg * ROWS + r]; const amt = (Math.floor(rnd() * 90000) + 300).toLocaleString('en-US');
      keys.push(a + ' ' + bb); if (r % 4 === 0) keys.push('(' + amt + ')');
      rows += `<tr><td>${ACC[Math.floor(rnd() * ACC.length)]}</td><td>${a}<br>${bb}<br>(${amt})</td><td>${DEPT[Math.floor(rnd() * DEPT.length)]}</td><td class="l">${DESC[Math.floor(rnd() * DESC.length)]}하고, ${DESC[Math.floor(rnd() * DESC.length)]}</td></tr>`;
    }
    KEY.push(keys);
    await setHtml(p, `<link rel="stylesheet" href="file://${NM}/@fontsource/noto-sans-kr/700.css"><style>body{margin:0;background:#fff}.page{position:absolute;inset:0;padding:150px 120px;transform:rotate(${pg % 2 ? -0.5 : 0.4}deg);font-family:'Noto Sans KR'}
      h2{font-size:34px;text-align:center;margin:0 0 26px}table{border-collapse:collapse;width:100%}
      td,th{border:3px solid #000;padding:10px 8px;font-size:${24 + pg % 3 * 2}px;font-weight:bold;text-align:center;line-height:1.45;}
      th{background:#ddd}td.l{text-align:left}td:nth-child(1){width:17%}td:nth-child(2){width:22%}td:nth-child(3){width:15%}.foot{text-align:center;font-size:22px;margin-top:20px}</style>
      <div class="page"><h2>${2027 + pg}년도 세출예산 사업별 설명자료 (단위: 백만원)</h2><table><tr><th>회계/기금명</th><th>사업명<br>(금액)</th><th>소관</th><th>사업 내용</th></tr>${rows}</table><div class="foot">- ${pg + 31} -</div></div>`);
    // 2값화 + 번짐 + 잡티
    GT.push(await p.evaluate(() => document.body.innerText));
    const png = await p.screenshot();
    const out = await p.evaluate(async ({ src, sd }) => {
      const img = new Image(); img.src = src; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const x = c.getContext('2d');
      x.filter = 'blur(1.1px)'; x.drawImage(img, 0, 0); x.filter = 'none';
      const im = x.getImageData(0, 0, c.width, c.height), d = im.data; let s = sd; const r = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
      for (let i = 0; i < d.length; i += 4) { let v = d[i] < 150 + (r() - .5) * 90 ? 0 : 255; d[i] = d[i + 1] = d[i + 2] = v; }
      x.putImageData(im, 0, 0); x.fillStyle = '#000';
      for (let k = 0; k < c.width * c.height * 0.0007; k++) { const q = r(); x.fillRect(r() * c.width, r() * c.height, q < .7 ? 2 : 3, q < .5 ? 2 : 3); }
      return c.toDataURL('image/png');
    }, { src: 'data:image/png;base64,' + png.toString('base64'), sd: pg + 5 });
    imgs.push(out);
  }
  fs.writeFileSync(path.join(FX, 'table2-p1.png'), Buffer.from(imgs[0].split(',')[1], 'base64'));
  await p.setContent(imgs.map(i => `<img src="${i}" style="width:100%;display:block;page-break-after:always">`).join(''));
  await p.pdf({ path: path.join(FX, 'table2.pdf'), format: 'A4', margin: { top: 0, bottom: 0, left: 0, right: 0 } });
  fs.writeFileSync(path.join(FX, 'table2.json'), JSON.stringify(KEY)); fs.writeFileSync(path.join(FX, 'table2.gt.json'), JSON.stringify(GT)); 
  await b.close();
})();
