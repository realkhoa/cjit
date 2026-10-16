// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { analyzeSource } from '@/lang/analyze';
import { execute } from '@/lang/runtime/interpreter';

describe('Fstream Module (<fstream>) & Virtual Filesystem', () => {
  it('writes to ofstream and reads back using ifstream and getline', () => {
    const code = `using namespace std;
int main() {
    ofstream outFile("demo.txt");
    outFile << "Hello from C++ fstream!\\n";
    outFile << 42 << " " << 3.14159 << "\\n";
    outFile.close();

    ifstream inFile("demo.txt");
    string line;
    cout << "Reading file contents:\\n";
    while (getline(inFile, line)) {
        cout << line << "\\n";
    }
    inFile.close();
    return 0;
}
`;
    const analysis = analyzeSource(code, 'main.cpp');
    expect(analysis.errorCount).toBe(0);
    const exec = execute(analysis.unit);
    if (exec.status !== 'ok') {
      console.log('FSTREAM ERROR:', exec.detail, exec.diagnostics);
    }
    expect(exec.status).toBe('ok');
    expect(exec.stdout).toBe(
      'Reading file contents:\n' +
      'Hello from C++ fstream!\n' +
      '42 3.14159\n'
    );
  });
});
