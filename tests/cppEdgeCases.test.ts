/**
 * @file cppEdgeCases.test.ts
 * @brief Regression tests for real-world C++ edge cases discovered in TheAlgorithms-CPP.
 */

import { describe, expect, it } from 'vitest';
import { analyzeSource } from '../src/lang/analyze';
import { execute } from '../src/lang/runtime/interpreter';

describe('C++ edge cases from real-world repositories', () => {
  it('concatenates adjacent string literals (translation phase 6)', () => {
    const code = `
#include <iostream>
int main() {
    std::cout << "Hello, " "World" "!" << "\\n";
    return 0;
}
`;
    const analysis = analyzeSource(code, 'main.cpp');
    expect(analysis.diagnostics).toEqual([]);
    const result = execute(analysis.unit);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('Hello, World!\n');
  });

  it('resolves <cstddef> without unknown header warnings', () => {
    const code = `
#include <cstddef>
int main() {
    size_t x = 10;
    return 0;
}
`;
    const analysis = analyzeSource(code, 'main.cpp');
    expect(analysis.diagnostics).toEqual([]);
  });

  it('handles non-type template parameters without corrupting typedefs', () => {
    const code = `
#include <iostream>
#include <array>

template <typename T, size_t size>
int checkSize(std::array<T, size> arr) {
    if (size <= 1) {
        return 1;
    }
    return 0;
}

int main() {
    return 0;
}
`;
    const analysis = analyzeSource(code, 'main.cpp');
    expect(analysis.diagnostics).toEqual([]);
  });

  it('correctly distinguishes parenthesized functional casts from C-style casts', () => {
    const code = `
#include <iostream>
int main() {
    int x = 10;
    int y = 20;
    float avg = (float(x) + float(y)) / 2.0f;
    std::cout << avg << "\\n";
    return 0;
}
`;
    const analysis = analyzeSource(code, 'main.cpp');
    expect(analysis.diagnostics).toEqual([]);
  });

  it('supports explicit constructors, = default, and member initializer lists', () => {
    const code = `
#include <iostream>

struct ListNode {
    int val{0};
    ListNode* next{nullptr};
    ListNode() = default;
    explicit ListNode(int x) : val(x), next(nullptr) {}
    ListNode(int x, ListNode* n) : val(x), next(n) {}
};

int main() {
    ListNode n1;
    ListNode n2(42);
    ListNode n3(99, &n2);
    std::cout << n1.val << " " << n2.val << " " << n3.val << "\\n";
    return 0;
}
`;
    const analysis = analyzeSource(code, 'main.cpp');
    expect(analysis.diagnostics).toEqual([]);
    const result = execute(analysis.unit);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('0 42 99');
  });

  it('supports member template methods inside classes', () => {
    const code = `
#include <iostream>

class Logger {
public:
    template <typename T>
    void log(T msg) {
        std::cout << msg << "\\n";
    }
};

int main() {
    Logger logger;
    logger.log("Hello from template method");
    return 0;
}
`;
    const analysis = analyzeSource(code, 'main.cpp');
    expect(analysis.diagnostics).toEqual([]);
  });

  it('supports out-of-class method definitions with qualified names', () => {
    const code = `
#include <iostream>

class Calculator {
public:
    int add(int a, int b);
};

int Calculator::add(int a, int b) {
    return a + b;
}

int main() {
    Calculator calc;
    std::cout << calc.add(3, 4) << "\\n";
    return 0;
}
`;
    const analysis = analyzeSource(code, 'main.cpp');
    expect(analysis.diagnostics).toEqual([]);
    const result = execute(analysis.unit);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('7\n');
  });

  it('supports parenthesized array reference parameters T (&arr)[N]', () => {
    const code = `
#include <iostream>

template <typename T, size_t N>
void printArray(T (&arr)[N]) {
    for (size_t i = 0; i < N; ++i) {
        std::cout << arr[i] << " ";
    }
    std::cout << "\\n";
}

int main() {
    int nums[3] = {1, 2, 3};
    printArray(nums);
    return 0;
}
`;
    const analysis = analyzeSource(code, 'main.cpp');
    expect(analysis.diagnostics).toEqual([]);
  });

  it('supports out-of-class constructor definitions and std::size_t parameters', () => {
    const code = `
#include <iostream>
#include <cstddef>

class VectorWrapper {
public:
    int capacity;
    explicit VectorWrapper(std::size_t initCap);
    std::size_t getCap();
};

VectorWrapper::VectorWrapper(std::size_t initCap) : capacity(initCap) {}

std::size_t VectorWrapper::getCap() {
    return capacity;
}

int main() {
    VectorWrapper vw(42);
    std::cout << vw.getCap() << "\\n";
    return 0;
}
`;
    const analysis = analyzeSource(code, 'main.cpp');
    expect(analysis.diagnostics).toEqual([]);
    const result = execute(analysis.unit);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('42\n');
  });

  it('handles direct initialization expressions with new keyword without parameter list confusion', () => {
    const code = `
#include <iostream>
#include <memory>

struct Node {
    int val;
    Node() : val(100) {}
};

int main() {
    std::shared_ptr<Node> temp(new Node());
    return 0;
}
`;
    const analysis = analyzeSource(code, 'main.cpp');
    expect(analysis.diagnostics).toEqual([]);
  });

  it('correctly parses compound logical inequality expressions in if conditions', () => {
    const code = `
#include <iostream>

int checkBounds(int idx, int count) {
    if (idx < 0 || idx > count - 1) {
        return -1;
    }
    return idx;
}

int main() {
    std::cout << checkBounds(-1, 10) << " " << checkBounds(5, 10) << " " << checkBounds(12, 10) << "\\n";
    return 0;
}
`;
    const analysis = analyzeSource(code, 'main.cpp');
    expect(analysis.diagnostics).toEqual([]);
    const result = execute(analysis.unit);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('-1 5 -1\n');
  });
});
