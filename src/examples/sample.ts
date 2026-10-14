/**
 * Bundled sample programs. Deliberately exercises C++ that only the real
 * clang-wasm engine (M7) can fully run: templates, libc++ containers, iostream.
 */
export const SAMPLE_MAIN_CPP = `#include <iostream>
#include <vector>
#include <string>

template <typename T>
T sum(const std::vector<T>& values) {
    T total{};
    for (const auto& v : values) {
        total += v;
    }
    return total;
}

int main() {
    std::vector<int> nums{3, 1, 4, 1, 5, 9, 2, 6};

    int total = sum(nums);
    std::cout << "sum = " << total << '\\n';
    std::cout << "count = " << nums.size() << '\\n';

    std::string label = "done";
    std::cout << label << '\\n';

    return 0;
}
`;

export const SAMPLE_HELLO_C = `#include <stdio.h>

int main(void) {
    for (int i = 1; i <= 5; i++) {
        printf("i = %d, i*i = %d\\n", i, i * i);
    }
    return 0;
}
`;

export interface ExampleFile {
  readonly path: string;
  readonly language: 'c' | 'cpp';
  readonly code: string;
  readonly note: string;
}

export const EXAMPLES: readonly ExampleFile[] = [
  {
    path: 'main.cpp',
    language: 'cpp',
    code: SAMPLE_MAIN_CPP,
    note: 'libc++ containers + a function template (needs the clang-wasm engine)',
  },
  {
    path: 'hello.c',
    language: 'c',
    code: SAMPLE_HELLO_C,
    note: 'printf in a loop - the case the realtime watch pane is built for',
  },
];

export const DEFAULT_EXAMPLE: ExampleFile = EXAMPLES[0] as ExampleFile;

export function languageForPath(path: string): 'c' | 'cpp' {
  return path.toLowerCase().endsWith('.c') ? 'c' : 'cpp';
}

export function monacoLanguageId(language: 'c' | 'cpp'): string {
  return language === 'c' ? 'c' : 'cpp';
}
