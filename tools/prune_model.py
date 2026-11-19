# 모델 출력층 축소 + 8비트 경량화 (models/rec_small_int8.onnx, models/dict_small.txt를 만든 스크립트)
# 입력: korean-handwriting-rec 저장소(커밋 7f974fc)의 model/rec_korean_hw.onnx, model/ppocrv5_korean_dict.txt 를
#       dl/khr/repo/model/ 아래에 두고 실행. 필요: pip install onnx onnxruntime numpy pillow
# 뒤쪽의 속도 비교 부분은 시험용 그림(hard2-p1.png)이 있어야 동작합니다.
import onnx, numpy as np, os, sys
from onnx import numpy_helper
from onnxruntime.quantization import quantize_dynamic, QuantType
chars = open('dl/khr/repo/model/ppocrv5_korean_dict.txt', encoding='utf-8').read().split('\n')
if chars[-1] == '': chars.pop()
def keep(c):
    o = ord(c[0])
    if 0xAC00 <= o <= 0xD7A3:
        try: return len(c.encode('euc-kr')) == 2      # KS X 1001 상용 한글 2,350자 (조합형 확장 시퀀스는 8바이트)
        except UnicodeEncodeError: return False
    return True
kept = [i + 1 for i, c in enumerate(chars) if keep(c)]
idx = [0] + kept + [len(chars) + 1]
print('classes', len(chars) + 2, '->', len(idx))
m = onnx.load('dl/khr/repo/model/rec_korean_hw.onnx')
inits = {i.name: i for i in m.graph.initializer}
W = numpy_helper.to_array(inits['onnx::MatMul_1492']); B = numpy_helper.to_array(inits['head.fc.bias'])
inits['onnx::MatMul_1492'].CopyFrom(numpy_helper.from_array(np.ascontiguousarray(W[:, idx]), 'onnx::MatMul_1492'))
inits['head.fc.bias'].CopyFrom(numpy_helper.from_array(np.ascontiguousarray(B[idx]), 'head.fc.bias'))
for o in m.graph.output:
    d = o.type.tensor_type.shape.dim
    if len(d) == 3 and d[2].HasField('dim_value'): d[2].dim_value = len(idx)
onnx.save(m, 'dl/rec_small_fp32.onnx')
quantize_dynamic('dl/rec_small_fp32.onnx', 'dl/rec_small_int8.onnx', weight_type=QuantType.QUInt8, op_types_to_quantize=['MatMul', 'Gemm'])
open('dl/dict_small.txt', 'w', encoding='utf-8').write('\n'.join(chars[i - 1] for i in kept) + '\n')
print('size', os.path.getsize('dl/rec_small_int8.onnx'))
import onnxruntime as ort, time
from PIL import Image
so = ort.SessionOptions(); so.intra_op_num_threads = 1
a = ort.InferenceSession('dl/rec_int8.onnx', so); b = ort.InferenceSession('dl/rec_small_int8.onnx', so)
img = Image.open('hard2-p1.png').convert('RGB').crop((100, 170, 620, 200)); w, h = img.size; nw = int(48 * w / h)
x = ((np.asarray(img.resize((nw, 48)), dtype=np.float32)[:, :, ::-1] / 255 - .5) / .5).transpose(2, 0, 1)[None]
full = ['<b>'] + chars + [' ']; small = ['<b>'] + [chars[i - 1] for i in kept] + [' ']
def dec(o, cs):
    s = ''; p = 0
    for i in o.argmax(1):
        if i != p and i != 0: s += cs[i]
        p = i
    return s
for name, s, cs in (('orig', a, full), ('small', b, small)):
    s.run(None, {'x': x}); t = time.time()
    for _ in range(10): o = s.run(None, {'x': x})[0]
    print(name, o.shape, f'{(time.time() - t) * 100:.1f}ms/줄', dec(o[0], cs))
