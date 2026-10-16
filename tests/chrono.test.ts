// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { analyzeSource } from '@/lang/analyze';
import { execute } from '@/lang/runtime/interpreter';

describe('Chrono Module (<chrono>)', () => {
  it('measures elapsed time with steady_clock::now(), duration subtraction, and duration_cast', () => {
    const code = `using namespace std;
int main() {
    auto start = chrono::steady_clock::now();
    volatile long long sum = 0;
    for (int i = 0; i < 1000; ++i) {
        sum += i;
    }
    auto end = chrono::steady_clock::now();
    auto elapsed = chrono::duration_cast<chrono::microseconds>(end - start);
    cout << "Elapsed non-negative: " << (elapsed.count() >= 0) << "\\n";
    return 0;
}
`;
    const analysis = analyzeSource(code, 'main.cpp');
    expect(analysis.errorCount).toBe(0);
    const exec = execute(analysis.unit);
    if (exec.status !== 'ok') {
      console.log('CHRONO ERROR:', exec.detail, exec.diagnostics);
    }
    expect(exec.status).toBe('ok');
    expect(exec.stdout).toBe('Elapsed non-negative: 1\n');
  });
});
