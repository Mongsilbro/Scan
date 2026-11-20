# 사용: python3 tools/build.py [출력 경로]   (기본: dist/pdf-page-finder.html)
# 먼저 `npm ci`로 package.json에 고정된 라이브러리를 설치해야 합니다.
import base64, gzip, json, os, glob, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
out = sys.argv[1] if len(sys.argv) > 1 else 'dist/pdf-page-finder.html'
head = open('src/head.html', encoding='utf-8').read()
def rep(a, b, s):
    assert s.count(a) == 1, a
    return s.replace(a, b)
head = rep('<div class="row" style="color:var(--muted)">띄어쓰기와 영문 대소문자는 무시하고 찾습니다. 분석 중에도 검색할 수 있고 결과는 계속 갱신됩니다.</div>',
 '<div class="row"><label><input type="checkbox" id="fuzzy" checked> 글자가 조금 틀리게 인식된 비슷한 표현도 찾기</label></div>\n    <div class="row" style="color:var(--muted);margin-top:4px">띄어쓰기와 영문 대소문자는 무시하고 찾습니다. 여러 낱말은 쉼표(,)로 나누면 따로 찾고 모두 들어 있는 쪽도 보여줍니다. 파일을 여러 개 넣으면 모든 파일에서 찾습니다. 분석 중에도 검색할 수 있고 결과는 계속 갱신됩니다.</div>', head)
head = rep('<label><input type="checkbox" id="force"> 글자 정보가 있어도 항상 OCR 사용</label>',
 '<label><input type="checkbox" id="force"> 글자 정보가 있어도 항상 OCR 사용</label>\n      <label><input type="checkbox" id="fine"> 정밀 인식 (2배쯤 느리지만 작은 글씨·흐린 스캔에 강함)</label>', head)
i = head.index('      <label>문서 언어'); j = head.index('</label>', head.index('</select>', i)) + len('</label>\n')
head = head[:i] + head[j:]
head = rep('<label><input type="checkbox" id="fine"> 정밀 인식 (2배쯤 느리지만 작은 글씨·흐린 스캔에 강함)</label>', '<label><input type="checkbox" id="fine" checked> 정밀 판독 (1차 판독 뒤 신경망 엔진으로 한 번 더 읽음. 끄면 2배쯤 빠르지만 덜 정확)</label>', head)
head = rep('<progress id="bar"', '<div class="row" style="color:var(--muted);font-size:.85rem;margin-top:6px">한 번 분석한 파일은 이 브라우저에 결과가 저장되어, 다시 열면 바로 검색됩니다. <button id="clearCache" style="font-size:.85rem;padding:3px 10px">저장된 결과 지우기</button></div>\n    <progress id="bar"', head)
head = rep('<canvas id="pv"></canvas>', '<div id="pvNote" style="font-size:.9rem;color:var(--muted);margin:0 0 8px"></div></div><canvas id="pv"></canvas>', head)
head = rep('<div class="dlg-head">', '<div class="dlg-top"><div class="dlg-head">', head)
head = rep('  #pv {', '  .dlg-top { position: sticky; top: -14px; z-index: 1; background: var(--card); margin: -14px -14px 0; padding: 14px 14px 2px; }\n  #pv {', head)
head = rep('  dialog::backdrop', '  dialog { max-height: 92vh; overflow: auto; }\n  dialog::backdrop', head)
head = rep('  .hit {', '  .chip.fz { border-style: dashed; color: var(--muted); border-color: var(--muted); }\n  .hit {', head)
N = 'node_modules/'
def gz64(b): return base64.b64encode(gzip.compress(b, 9, mtime=0)).decode()   # mtime=0: 같은 입력이면 같은 결과
rd = lambda p: open(p, 'rb').read()
cmaps = {os.path.basename(f)[:-6]: base64.b64encode(rd(f)).decode() for f in glob.glob(N+'pdfjs-dist/cmaps/*.bcmap')}
w = rd(N+'tesseract.js/dist/worker.min.js').decode()
bug = 'return"string"==typeof t?t:t.data})).join("+")'
assert w.count(bug) == 1
w = w.replace(bug, 'return"string"==typeof t?t:t.code})).join("+")')  # tesseract.js 5.1.1~7.0.0: 내장 언어 데이터 사용 시 언어 이름 버그 수정
assets = {
 'a-pdf': gz64(rd(N+'pdfjs-dist/build/pdf.min.js')),
 'a-pdfworker': gz64(rd(N+'pdfjs-dist/build/pdf.worker.min.js')),
 'a-tess': gz64(rd(N+'tesseract.js/dist/tesseract.min.js')),
 'a-tessworker': gz64(w.encode()),
 'a-core': gz64(rd(N+'tesseract.js-core/tesseract-core-simd-lstm.wasm.js')),
 'a-cmaps': gz64(json.dumps(cmaps).encode()),
 'a-lang-kor': gz64(rd('models/kor.traineddata')),
 'a-ort': gz64(rd(N+'onnxruntime-web/dist/ort.wasm.min.js')),                          # CPU용
 'a-ortmjs': gz64(rd(N+'onnxruntime-web/dist/ort-wasm-simd-threaded.mjs')),
 'a-ortwasm': gz64(rd(N+'onnxruntime-web/dist/ort-wasm-simd-threaded.wasm')),
 'a-ortgpu': gz64(rd(N+'onnxruntime-web/dist/ort.webgpu.min.js')),                      # 그래픽카드용 (CPU에 쓰면 느림)
 'a-ortgpumjs': gz64(rd(N+'onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs')),
 'a-ortgpuwasm': gz64(rd(N+'onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm')),
 'a-recworker': gz64(rd('src/recworker.js')),
 'a-prepworker': gz64(rd('src/prepworker.js')),
 'a-recmodel': gz64(rd(os.environ.get('REC_MODEL', 'models/rec_cpu.onnx'))),   # CPU용(8비트 행렬곱)
 'a-recgpu': gz64(rd('models/rec_gpu.onnx')),                                       # 그래픽카드용(실수 행렬곱)
 'a-recw': gz64(rd('models/rec_w.bin')),                                            # 두 모델이 함께 쓰는 가중치
 'a-recdict': gz64(rd('models/dict_small.txt')),
}
blocks = '\n'.join(f'<script type="application/octet-stream" id="{k}">{v}</script>' for k, v in assets.items())
main = open('src/imgproc.js', encoding='utf-8').read() + '\n' + open('src/main.js', encoding='utf-8').read()   # 그림 처리 함수는 화면 쪽과 준비 작업자가 함께 씀
assert '</script' not in main
s = head + '<!-- 내장 라이브러리: pdf.js 3.11.174 (Apache-2.0), tesseract.js 7.0.0 / tesseract.js-core (Apache-2.0), tessdata_fast kor (Apache-2.0), onnxruntime-web 1.31.1 (MIT), korean-handwriting-rec · PP-OCRv5 한국어 인식 모델 (Apache-2.0; 출력층을 상용 한글 2,350자·영문·기호로 줄이고 8비트로 경량화) -->\n' + blocks + '\n<script>\n' + main + '</script>\n</body>\n</html>\n'
open(out, 'w', encoding='utf-8').write(s)
print(round(len(s)/1e6, 2), 'MB')
