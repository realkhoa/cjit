import { describe, expect, it } from 'vitest';
import { analyzeSource } from '@/lang/analyze';
import { execute } from '@/lang/runtime/interpreter';
import type { ExecutionResult } from '@/lang/runtime/interpreter';

/**
 * `using` declarations.
 *
 * They decide which names resolve, so the engine has to read them: skipping them made
 * `using namespace std;` a warning and then every `cout` an undeclared identifier -
 * rejecting code a native compiler accepts, which is the wrong way round.
 *
 * The other direction matters too: a bare `cout` with no `using` must stay an error,
 * because clang rejects it.
 */

function run(source: string): { result: ExecutionResult; messages: string[] } {
  const analysis = analyzeSource(source, 'main.cpp');
  const result = execute(analysis.unit, { collectWatch: true });
  return {
    result,
    messages: analysis.diagnostics.map((diagnostic) => `${diagnostic.severity}: ${diagnostic.message}`),
  };
}

function program(body: readonly string[], includes: readonly string[] = ['<iostream>']): string {
  return [...includes.map((header) => `#include ${header}`), ...body].join('\n');
}

describe('using namespace std', () => {
  const source = program([
    'using namespace std;',
    'int main() {',
    '    vector<int> v{1, 2, 3};',
    '    cout << v.size() << "\\n";',
    '    string s = "hi";',
    '    cout << s << "\\n";',
    '    return 0;',
    '}',
  ], ['<iostream>', '<vector>', '<string>']);

  it('is accepted without a murmur', () => {
    expect(run(source).messages).toEqual([]);
  });

  it('makes the bare names resolve, and the program runs', () => {
    const { result } = run(source);
    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('3\nhi\n');
    expect(result.vars.find((item) => item.name === 's')?.value).toBe('"hi"');
  });

  it('works for cerr and endl too', () => {
    const { result } = run(
      program(
        [
          'using namespace std;',
          'int main() {',
          '    cerr << "bad" << endl;',
          '    return 0;',
          '}',
        ],
        ['<iostream>'],
      ),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stderr).toContain('bad');
  });

  it('only the namespace it names: a made-up one changes nothing', () => {
    const { result } = run(
      program(
        ['using namespace notstd;', 'int main() {', '    return 0;', '}'],
        ['<iostream>'],
      ),
    );
    expect(result.status, result.detail).toBe('ok');
  });
});

describe('using a single name', () => {
  it('brings that name into scope', () => {
    const { result } = run(
      program(
        [
          'using std::cout;',
          'int main() {',
          '    cout << "hi\\n";',
          '    return 0;',
          '}',
        ],
        ['<iostream>'],
      ),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('hi\n');
  });

  it('works inside a function as well as at file scope', () => {
    const { result } = run(
      program(
        [
          'int main() {',
          '    using std::cout;',
          '    cout << "inside\\n";',
          '    return 0;',
          '}',
        ],
        ['<iostream>'],
      ),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('inside\n');
  });

  it('does not bring in the names it did not mention', () => {
    const { result } = run(
      program(
        [
          'using std::cout;',
          'int main() {',
          '    cerr << "nope";',
          '    return 0;',
          '}',
        ],
        ['<iostream>'],
      ),
    );

    expect(result.status).toBe('runtime-error');
    expect(result.detail).toContain('cerr');
  });
});

describe('using as a type alias', () => {
  it('is a typedef under another spelling', () => {
    const { result, messages } = run(
      program(
        [
          'using ll = long long;',
          'using str = std::string;',
          'int main() {',
          '    ll big = 9000000000;',
          '    str name = "khoa";',
          '    return 0;',
          '}',
        ],
        ['<iostream>', '<string>'],
      ),
    );

    expect(messages).toEqual([]);
    expect(result.status, result.detail).toBe('ok');
    expect(result.vars.find((item) => item.name === 'big')?.value).toBe('9000000000');
    expect(result.vars.find((item) => item.name === 'name')?.value).toBe('"khoa"');
  });
});

describe('what stays an error, as a native compiler would have it', () => {
  it('refuses a bare cout with no using at all', () => {
    const { result } = run(
      program(['int main() {', '    cout << "no using";', '    return 0;', '}'], ['<iostream>']),
    );

    expect(result.status).toBe('runtime-error');
    expect(result.detail).toContain('cout');
  });

  it('refuses a bare standard type name with no using at all', () => {
    const { messages } = run(
      program(['int main() {', '    string s = "x";', '    return 0;', '}'], ['<iostream>', '<string>']),
    );

    expect(messages.some((message) => message.startsWith('error'))).toBe(true);
  });
});
