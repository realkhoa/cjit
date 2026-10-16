// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { analyzeSource } from '@/lang/analyze';
import { execute } from '@/lang/runtime/interpreter';

describe('Random Module (<random>)', () => {
  it('instantiates mt19937 with seed and uniform_int_distribution and generates bounded random integers', () => {
    const code = `using namespace std;
int main() {
    mt19937 rng(1337);
    uniform_int_distribution<int> distribution(1, 100);
    int r1 = distribution(rng);
    int r2 = distribution(rng);
    int r3 = distribution(rng);
    cout << "R1 in range: " << (r1 >= 1 && r1 <= 100) << "\\n";
    cout << "R2 in range: " << (r2 >= 1 && r2 <= 100) << "\\n";
    cout << "R3 in range: " << (r3 >= 1 && r3 <= 100) << "\\n";
    return 0;
}
`;
    const analysis = analyzeSource(code, 'main.cpp');
    expect(analysis.errorCount).toBe(0);
    const exec = execute(analysis.unit);
    if (exec.status !== 'ok') {
      console.log('RANDOM ERROR:', exec.detail, exec.diagnostics);
    }
    expect(exec.status).toBe('ok');
    expect(exec.stdout).toBe('R1 in range: 1\nR2 in range: 1\nR3 in range: 1\n');
  });

  it('supports direct call operator on mt19937 rng()', () => {
    const code = `using namespace std;
int main() {
    mt19937 rng(42);
    unsigned int val1 = rng();
    unsigned int val2 = rng();
    cout << "Values distinct: " << (val1 != val2) << "\\n";
    return 0;
}
`;
    const analysis = analyzeSource(code, 'main.cpp');
    expect(analysis.errorCount).toBe(0);
    const exec = execute(analysis.unit);
    expect(exec.status).toBe('ok');
    expect(exec.stdout).toBe('Values distinct: 1\n');
  });
});
