// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { analyzeSource } from '@/lang/analyze';
import { execute } from '@/lang/runtime/interpreter';

describe('Stream Manipulators (boolalpha, noboolalpha)', () => {
  it('toggles boolean rendering between true/false and 1/0 with boolalpha and noboolalpha', () => {
    const code = `using namespace std;
int main() {
    bool t = true;
    bool f = false;
    cout << t << " " << f << "\\n";
    cout << boolalpha;
    cout << t << " " << f << "\\n";
    cout << noboolalpha;
    cout << t << " " << f << "\\n";
    return 0;
}
`;
    const analysis = analyzeSource(code, 'main.cpp');
    expect(analysis.errorCount).toBe(0);
    const exec = execute(analysis.unit);
    expect(exec.status).toBe('ok');
    expect(exec.stdout).toBe('1 0\ntrue false\n1 0\n');
  });

  it('runs demoTypeTraits with boolalpha and type traits', () => {
    const code = `using namespace std;
void demoTypeTraits() {
    cout << boolalpha;
    cout << "int is integral: " << is_integral_v<int> << '\\n';
    cout << "double is floating: "
         << is_floating_point_v<double> << '\\n';
}
int main() {
    demoTypeTraits();
    return 0;
}
`;
    const analysis = analyzeSource(code, 'main.cpp');
    expect(analysis.errorCount).toBe(0);
    const exec = execute(analysis.unit);
    expect(exec.status).toBe('ok');
    expect(exec.stdout).toBe('int is integral: true\ndouble is floating: true\n');
  });
});
