/**
 * Bundled sample project.
 *
 * The default workspace is this whole list, not one file, so a first-time visitor
 * lands in a project: `main.cpp` (the C++ tour), `util.h` (a module the tour
 * includes, carrying `#pragma once`) and `hello.c` (printf in a loop - the case the
 * realtime watch pane is built for).
 *
 * `main.cpp` deliberately touches every container and algorithm the fast engine
 * simulates, so the pane on the right is a checklist rather than a claim: set,
 * map, pair, queue, stack, priority_queue, deque, the algorithms over a vector,
 * string helpers, and a function template.
 */
export const SAMPLE_MAIN_CPP = `#include <iostream>
#include <vector>
#include <string>
#include <set>
#include <map>
#include <queue>
#include <stack>
#include <deque>
#include <numeric>
#include <algorithm>

#include "util.h"

int main() {
    // --- vector + algorithms
    std::vector<int> nums{3, 1, 4, 1, 5, 9, 2, 6};
    std::sort(nums.begin(), nums.end());
    std::cout << "sorted: ";
    printAll(nums);
    std::cout << "sum = " << std::accumulate(nums.begin(), nums.end(), 0) << '\\n';
    std::cout << "min = " << *std::min_element(nums.begin(), nums.end())
              << ", max = " << *std::max_element(nums.begin(), nums.end()) << '\\n';
    std::cout << "has 5: " << std::binary_search(nums.begin(), nums.end(), 5) << '\\n';

    std::vector<int> counter;
    counter.resize(4);
    std::iota(counter.begin(), counter.end(), 10);
    std::reverse(counter.begin(), counter.end());
    std::cout << "iota+reverse: ";
    printAll(counter);

    // --- set: sorted, unique
    std::set<int> unique;
    for (const auto& value : nums) {
        unique.insert(value);
    }
    std::cout << "distinct = " << unique.size() << '\\n';

    // --- map: counts, ordered by key
    std::vector<std::string> words{"red", "blue", "red", "green", "red"};
    std::map<std::string, int> counts;
    for (const auto& word : words) {
        counts[word] = counts[word] + 1;
    }
    std::cout << "red appears " << counts["red"] << " times\\n";

    // --- pair
    std::pair<std::string, int> best{"green", 1};
    std::cout << "best = " << best.first << ':' << best.second << '\\n';

    // --- queue (FIFO), stack (LIFO), priority_queue (largest first)
    std::queue<int> fifo;
    fifo.push(1);
    fifo.push(2);
    fifo.push(3);
    std::cout << "fifo front = " << fifo.front() << ", size = " << fifo.size() << '\\n';

    std::stack<int> lifo;
    lifo.push(1);
    lifo.push(2);
    std::cout << "lifo top = " << lifo.top() << '\\n';

    std::priority_queue<int> largest;
    largest.push(7);
    largest.push(2);
    largest.push(9);
    std::cout << "largest = " << largest.top() << '\\n';

    // --- deque: both ends
    std::deque<int> both;
    both.push_back(2);
    both.push_front(1);
    both.push_back(3);
    std::cout << "deque front = " << both.front() << ", back = " << both.back() << '\\n';

    // --- string helpers
    std::string line = "sum = " + std::to_string(21) + " and " + std::to_string(21);
    std::cout << line << '\\n';
    std::cout << "atoi(" << std::stoi("42abc") << "), pi = " << std::stod("3.5") << '\\n';
    std::cout << "substr = " << line.substr(0, 5) << ", find = " << line.find("and") << '\\n';

    // --- the template from util.h ran twice above: printAll(sorted) and
    // printAll(counter), both instantiated for int.

    return 0;
}
`;

/** A module with no `main`, included by the tour - the shape a team file has. */
export const SAMPLE_UTIL_H = `#pragma once

#include <iostream>
#include <vector>

/*
 * Prints a container the way the watch pane shows it: [a, b, c].
 *
 * Walks the range rather than calling values.size() or values[i]: the fast engine
 * has not resolved member calls on a const-reference template parameter yet, and a
 * sample that half-runs is worse than one that stays inside what works.
 */
template <typename T>
void printAll(const std::vector<T>& values) {
    std::cout << '[';
    bool first = true;
    for (const auto& value : values) {
        if (!first) std::cout << ", ";
        first = false;
        std::cout << value;
    }
    std::cout << "]\\n";
}

/*
 * Note for the next fix: a template function *returning* T does not work yet.
 * A template returning void, like this one, is fine.
 */
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
    note: 'the STL tour: containers, algorithms, string helpers, a template',
  },
  {
    path: 'util.h',
    language: 'cpp',
    code: SAMPLE_UTIL_H,
    note: 'a module with #pragma once and no main - the shape a new file gets',
  },
  {
    path: 'hello.c',
    language: 'c',
    code: SAMPLE_HELLO_C,
    note: 'printf in a loop - the case the realtime watch pane is built for',
  },
];

export const DEFAULT_EXAMPLE: ExampleFile = EXAMPLES[0] as ExampleFile;

/**
 * The bundled project in the two shapes the engine takes.
 *
 * The samples include each other (`main.cpp` includes `util.h`), so analysing one
 * of them without the rest produces a "cannot find" warning that is an artefact of
 * the caller, not of the sample. `SourceUnit.files` is a list of files; the
 * preprocessor wants a map.
 */
export function exampleFiles(): { readonly path: string; readonly code: string }[] {
  return EXAMPLES.map((file) => ({ path: file.path, code: file.code }));
}

export function exampleFileMap(): Map<string, string> {
  return new Map(EXAMPLES.map((file) => [file.path, file.code]));
}

export function languageForPath(path: string): 'c' | 'cpp' {
  return path.toLowerCase().endsWith('.c') ? 'c' : 'cpp';
}

export function monacoLanguageId(language: 'c' | 'cpp'): string {
  return language === 'c' ? 'c' : 'cpp';
}
