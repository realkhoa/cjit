// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { analyzeSource } from '@/lang/analyze';
import { execute } from '@/lang/runtime/interpreter';

describe('GCC and Clang Built-in Intrinsics', () => {
  it('evaluates popcount, clz, ctz, bswap, expect, and abs', () => {
    const code = `int main() {
    int pc = __builtin_popcount(29); // 29 is 0b11101 -> 4 set bits
    int clz = __builtin_clz(16); // 16 is 0b00000000_00000000_00000000_00010000 -> 27 leading zeros
    int ctz = __builtin_ctz(16); // 4 trailing zeros
    int exp = __builtin_expect(42, 0);
    int ab = __builtin_abs(-55);
    int bs16 = __builtin_bswap16(0x1234);
    int bs32 = __builtin_bswap32(0x12345678);

    printf("%d %d %d %d %d %x %x\\n", pc, clz, ctz, exp, ab, bs16, bs32);
    return 0;
}
`;
    const analysis = analyzeSource(code, 'main.cpp');
    expect(analysis.errorCount).toBe(0);
    const exec = execute(analysis.unit);
    if (exec.status !== 'ok') {
      console.log('BUILTIN ERROR:', exec.detail, exec.diagnostics);
    }
    expect(exec.status).toBe('ok');
    expect(exec.stdout).toBe('4 27 4 42 55 3412 78563412\n');
  });
});
