# 스캔 PDF 페이지 찾기

스캔한 PDF에서 찾는 내용이 **몇 쪽에, 그 쪽의 어디에** 있는지 알려주는 도구입니다. HTML 파일 하나로 동작하고 **인터넷 연결이 필요 없습니다.** PDF는 컴퓨터 밖으로 나가지 않습니다.

## 쓰는 법

1. [`dist/pdf-page-finder.html`](dist/pdf-page-finder.html)을 내려받아 크롬이나 엣지로 엽니다.
2. PDF를 끌어다 놓고, 찾을 내용을 입력합니다.
3. 쪽 번호를 누르면 미리보기에 찾은 위치가 노란 상자로 표시됩니다.

- **2단계 판독**: 1차 판독(빠른 엔진)이 끝나면 바로 검색할 수 있고, 2차 판독(신경망 엔진)이 이어서 결과를 보강합니다. "정밀 판독"을 끄면 1차만 해서 약 2배 빠릅니다.
- **결과 저장**: 한 번 분석한 파일은 브라우저에 결과가 저장되어, 다시 열면 바로 검색됩니다(최근 30개). "저장된 결과 지우기"로 지울 수 있습니다.
- **검색 방식**: 띄어쓰기·문장부호·영문 대소문자는 무시합니다. 글자가 조금 틀리게 인식된 비슷한 표현도 찾고, 이런 결과는 점선과 `?`로 구분해 보여줍니다.

## 구조

| 경로 | 내용 |
|---|---|
| `src/head.html` | 화면(HTML·CSS) 바탕. 빌드할 때 `tools/build.py`가 일부를 고쳐 씁니다 |
| `src/main.js` | 전체 동작: PDF 읽기, 전처리, 표 칸 찾기, 글줄 찾기, 두 엔진 판독, 검색, 위치 표시, 결과 저장 |
| `src/recworker.js` | 신경망 판독 작업자(onnxruntime-web) |
| `models/` | 내장 모델과 라이선스 (아래 표) |
| `tools/build.py` | 라이브러리·모델을 모두 넣어 `dist/pdf-page-finder.html` 하나로 묶음. 같은 입력이면 같은 결과 |
| `tools/prune_model.py` | 신경망 모델 경량화에 쓴 스크립트 |
| `tools/fold_affine.py` | 모델의 배율·더하기 층을 합성곱에 합치는 스크립트(결과 같고 더 빠름). `models/rec_small_int8.onnx`에 적용됨 |
| `tests/regress.js` | 회귀 테스트: 네트워크를 막은 브라우저에서 쪽 찾기·위치 표시·결과 저장 확인 |
| `tests/bench.js` | 성능 측정: 시간, 키워드 적중률, 글자 정확도 |
| `tests/gen_*.js`, `tests/fixtures/` | 시험용 스캔 PDF와 그 생성기 |

## 빌드와 테스트

```bash
npm ci
```

```bash
python3 tools/build.py
```

```bash
node tests/regress.js dist/pdf-page-finder.html
```

```bash
T=table2 node tests/bench.js dist/pdf-page-finder.html
```

테스트에는 Playwright와 Chromium이 필요합니다(`require('playwright')`). `T`는 `table2`(굵은 고딕 표 6쪽) 또는 `hard2`(명조 2단 편집 8쪽)입니다.

## 내장 구성요소와 라이선스

| 구성요소 | 버전·출처 | 라이선스 |
|---|---|---|
| pdf.js (`pdfjs-dist`) | 3.11.174 | Apache-2.0 |
| tesseract.js, tesseract.js-core | 7.0.0 (빌드 때 내장 언어 데이터 이름 버그 한 줄 수정) | Apache-2.0 |
| 한국어 Tesseract 모델 `models/kor.traineddata` | tesseract-ocr/tessdata_fast (커밋 8741641) | Apache-2.0 |
| onnxruntime-web | 1.16.3 | MIT |
| 한국어 신경망 인식 모델 `models/rec_small_int8.onnx` | VerifiedIdiot/korean-handwriting-rec (커밋 7f974fc, PP-OCRv5 한국어 모델 추가 학습판)을 출력층 축소(상용 한글 2,350자·영문·숫자·기호)하고 8비트 경량화, 배율·더하기 층을 합성곱에 합침 | Apache-2.0 |

## 측정 결과 (4코어, 2026-11-19)

| 시험 문서 | 찾은 키워드 | 글자 정확도 | 걸린 시간 |
|---|---|---|---|
| 표 문서 6쪽 (`table2`) | 84/84 | 97.7% | 약 16~17초 (1차 결과 약 9초) |
| 2단 문서 8쪽 (`hard2`) | 44~45/48 | 96.0% | 약 21~22초 (1차 결과 약 9~10초) |

못 찾는 3~4개는 일부러 가장 흐리게 만든 쪽의 작은 각주에 있습니다.
