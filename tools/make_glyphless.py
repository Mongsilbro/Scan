# 숨은 글자용 글꼴(글자 모양은 모두 같은 네모 하나, 숨은 글자로만 씀) models/glyphless.ttf 를 만듦. '검색되는 PDF' 의 숨은 글자층에 씀
# (OCRmyPDF·Tesseract 의 GlyphLessFont 와 같은 방식: 모든 글자를 빈 글리프 하나로, 글자 정보는 ToUnicode 로)
# 사용: pip install fonttools && python3 tools/make_glyphless.py
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
fb = FontBuilder(1000, isTTF=True)
fb.setupGlyphOrder(['.notdef', 'blank'])
fb.setupCharacterMap({0x20: 'blank'})
empty = TTGlyphPen(None).glyph()
pen = TTGlyphPen(None)          # 글자 높이만큼의 네모: 숨은 글자로 그려 보이지 않지만, PDF 보기 프로그램이 찾은 곳을 글자 높이로 칠함
pen.moveTo((0, 0)); pen.lineTo((0, 1000)); pen.lineTo((500, 1000)); pen.lineTo((500, 0)); pen.closePath()
fb.setupGlyf({'.notdef': empty, 'blank': pen.glyph()})
fb.setupHorizontalMetrics({'.notdef': (500, 0), 'blank': (500, 0)})
fb.setupHorizontalHeader(ascent=1000, descent=0)
fb.setupNameTable({'familyName': 'GlyphLessFont', 'styleName': 'Regular'})
fb.setupOS2(sTypoAscender=1000, sTypoDescender=0, usWinAscent=1000, usWinDescent=0)
fb.setupPost()
fb.save('models/glyphless.ttf')
print(open('models/glyphless.ttf', 'rb').read().__len__(), 'bytes')
