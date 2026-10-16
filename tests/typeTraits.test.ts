// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { analyzeSource } from '@/lang/analyze';
import { execute } from '@/lang/runtime/interpreter';

describe('Type Traits (<type_traits>)', () => {
  it('evaluates is_integral_v and is_floating_point_v at runtime', () => {
    const code = `using namespace std;
int main() {
    cout << is_integral_v<int> << " ";
    cout << is_integral_v<double> << " ";
    cout << is_floating_point_v<double> << " ";
    cout << is_floating_point_v<int> << " ";
    cout << is_arithmetic_v<int> << " ";
    cout << is_arithmetic_v<void> << "\\n";
    return 0;
}
`;
    const analysis = analyzeSource(code, 'main.cpp');
    expect(analysis.errorCount).toBe(0);
    const exec = execute(analysis.unit);
    if (exec.status !== 'ok') {
      console.log('TYPE TRAITS ERROR 1:', exec.detail, exec.diagnostics);
    }
    expect(exec.status).toBe('ok');
    expect(exec.stdout).toBe('1 0 1 0 1 0\n');
  });

  it('evaluates is_same_v, is_pointer_v, and is_void_v', () => {
    const code = `using namespace std;
int main() {
    cout << is_same_v<int, int> << " ";
    cout << is_same_v<int, double> << " ";
    cout << is_pointer_v<int*> << " ";
    cout << is_pointer_v<int> << " ";
    cout << is_void_v<void> << "\\n";
    return 0;
}
`;
    const analysis = analyzeSource(code, 'main.cpp');
    expect(analysis.errorCount).toBe(0);
    const exec = execute(analysis.unit);
    if (exec.status !== 'ok') {
      console.log('TYPE TRAITS ERROR 2:', exec.detail, exec.diagnostics);
    }
    expect(exec.status).toBe('ok');
    expect(exec.stdout).toBe('1 0 1 0 1\n');
  });
});
