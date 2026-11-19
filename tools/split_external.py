# CPU 모델과 그래픽카드(GPU) 모델이 함께 쓰는 가중치를 파일 하나(rec_w.bin)로 빼서 HTML 크기를 줄임
# 사용: python3 tools/split_external.py models/rec_small_int8.onnx 그래픽카드용.onnx models/
#  → models/rec_cpu.onnx, models/rec_gpu.onnx, models/rec_w.bin  (두 모델 모두 rec_w.bin 을 외부 가중치로 참조)
import sys, os, onnx
cpu, gpu = onnx.load(sys.argv[1]), onnx.load(sys.argv[2]); out = sys.argv[3]
A = {t.name: t for t in cpu.graph.initializer}; B = {t.name: t for t in gpu.graph.initializer}
shared = [n for n in A if n in B and A[n].raw_data and A[n].raw_data == B[n].raw_data and len(A[n].raw_data) >= 1024]
blob = bytearray(); off = {}
for n in sorted(shared):
    while len(blob) % 64: blob.append(0)
    off[n] = (len(blob), len(A[n].raw_data)); blob += A[n].raw_data
def ext(m):
    for t in m.graph.initializer:
        if t.name in off:
            o, l = off[t.name]; t.ClearField('raw_data'); t.data_location = onnx.TensorProto.EXTERNAL
            del t.external_data[:]
            for k, v in (('location', 'rec_w.bin'), ('offset', str(o)), ('length', str(l))): e = t.external_data.add(); e.key = k; e.value = v
ext(cpu); ext(gpu)
open(os.path.join(out, 'rec_w.bin'), 'wb').write(blob)
onnx.save(cpu, os.path.join(out, 'rec_cpu.onnx')); onnx.save(gpu, os.path.join(out, 'rec_gpu.onnx'))
print('공유 가중치', len(shared), '개', len(blob), 'bytes')
