// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { analyzeSource } from '@/lang/analyze';

const USER_CODE = `#include <algorithm>
#include <array>
#include <bitset>
#include <chrono>
#include <cmath>
#include <deque>
#include <forward_list>
#include <fstream>
#include <functional>
#include <iomanip>
#include <iostream>
#include <iterator>
#include <list>
#include <map>
#include <memory>
#include <numeric>
#include <optional>
#include <queue>
#include <random>
#include <regex>
#include <set>
#include <sstream>
#include <stack>
#include <string>
#include <string_view>
#include <tuple>
#include <type_traits>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <variant>
#include <vector>
#include <any>
#include <cstdint>

using namespace std;

// ============================================================
// 1. USER-DEFINED TYPES, C++17 SFINAE CONSTRAINTS
// ============================================================

struct Person {
    string name;
    int age{};

    bool operator<(const Person& other) const {
        return age < other.age;
    }
};

// C++17 thay th? cho C++20 concepts
template <typename T, typename = std::enable_if_t<std::is_arithmetic_v<T>>>
T add(T a, T b) {
    return a + b;
}

struct IsEven {
    bool operator()(int n) const {
        return n % 2 == 0;
    }
};

// ============================================================
// 2. STL CONTAINERS
// ============================================================

void demoContainers() {
    // Sequence containers
    vector<int> vec{5, 2, 8, 1, 3};
    array<int, 4> arr{10, 20, 30, 40};
    deque<int> dq{1, 2, 3};
    list<int> linkedList{4, 5, 6};
    forward_list<int> forwardList{7, 8, 9};

    vec.push_back(100);
    dq.push_front(0);
    linkedList.push_back(7);
    forwardList.push_front(6);

    cout << "Vector size: " << vec.size() << '\\n';
    cout << "Array first: " << arr.front() << '\\n';
    cout << "Deque first: " << dq.front() << '\\n';

    // Ordered associative containers
    set<int> uniqueValues{3, 1, 2, 2};
    multiset<int> repeatedValues{1, 1, 2, 3};

    map<string, int> scores{
        {"Alice", 90},
        {"Bob", 85}
    };

    multimap<string, int> multiScores{
        {"Alice", 90},
        {"Alice", 95}
    };

    uniqueValues.insert(4);
    scores["Charlie"] = 88;

    // C++17 ki?m tra ph?n t? t?n t?i trong set (thay th? C++20 .contains())
    cout << "Set contains 2: "
         << (uniqueValues.find(2) != uniqueValues.end()) << '\\n';

    // Unordered associative containers
    unordered_set<string> tags{"C++", "STL", "Modern C++"};

    unordered_map<string, int> frequencies;
    frequencies["apple"]++;
    frequencies["apple"]++;
    frequencies["banana"]++;

    cout << "Apple count: " << frequencies.at("apple") << '\\n';

    // Container adapters
    stack<int> st;
    st.push(10);
    st.push(20);
    cout << "Stack top: " << st.top() << '\\n';
    st.pop();

    queue<string> q;
    q.push("First");
    q.push("Second");
    cout << "Queue front: " << q.front() << '\\n';
    q.pop();

    priority_queue<int> maxHeap;
    maxHeap.push(10);
    maxHeap.push(30);
    maxHeap.push(20);
    cout << "Priority queue top: " << maxHeap.top() << '\\n';

    priority_queue<int, vector<int>, greater<int>> minHeap;
    minHeap.push(10);
    minHeap.push(3);
    minHeap.push(7);
    cout << "Min heap top: " << minHeap.top() << '\\n';

    bitset<8> bits(42);
    cout << "Bitset: " << bits << '\\n';
    cout << "Bit count: " << bits.count() << '\\n';

    // Structured bindings (C++17)
    for (const auto& [name, score] : scores) {
        cout << name << ": " << score << '\\n';
    }

    (void)repeatedValues;
    (void)multiScores;
    (void)tags;
    (void)arr;
    (void)linkedList;
    (void)forwardList;
}

// ============================================================
// 3. STL ALGORITHMS, ITERATORS, NUMERICS
// ============================================================

void demoAlgorithms() {
    vector<int> values{5, 1, 4, 2, 3, 2, 6};

    sort(values.begin(), values.end());

    auto it = find(values.begin(), values.end(), 4);
    if (it != values.end()) {
        cout << "Found: " << *it << '\\n';
    }

    int evenCount = count_if(
        values.begin(), values.end(), IsEven{}
    );

    cout << "Even count: " << evenCount << '\\n';

    vector<int> squares(values.size());
    transform(
        values.begin(), values.end(),
        squares.begin(),
        [](int x) { return x * x; }
    );

    int total = accumulate(values.begin(), values.end(), 0);
    double average = static_cast<double>(total) / values.size();

    cout << "Sum: " << total << '\\n';
    cout << "Average: " << average << '\\n';

    bool found = binary_search(values.begin(), values.end(), 3);
    cout << "Binary search: " << found << '\\n';

    auto [minIt, maxIt] = minmax_element(
        values.begin(), values.end()
    );

    cout << "Min: " << *minIt << ", Max: " << *maxIt << '\\n';

    auto boundary = partition(
        values.begin(), values.end(),
        [](int x) { return x % 2 == 0; }
    );

    cout << "Even partition size: "
         << distance(values.begin(), boundary) << '\\n';

    vector<int> duplicates{1, 1, 2, 2, 3, 3};
    auto newEnd = unique(duplicates.begin(), duplicates.end());
    duplicates.erase(newEnd, duplicates.end());

    // Iterator utilities
    auto reverseIt = values.rbegin();
    if (reverseIt != values.rend()) {
        cout << "Last in reverse order: " << *reverseIt << '\\n';
    }

    vector<int> copied;
    copy(values.begin(), values.end(), back_inserter(copied));

    // Numeric algorithms
    vector<int> partial(values.size());
    partial_sum(values.begin(), values.end(), partial.begin());

    vector<int> differences(values.size());
    adjacent_difference(
        values.begin(), values.end(), differences.begin()
    );

    cout << "Inner product: "
         << inner_product(
                values.begin(), values.end(),
                values.begin(), 0
            )
         << '\\n';

    cout << "GCD: " << gcd(48, 18) << '\\n';
    cout << "LCM: " << lcm(4, 6) << '\\n';
    cout << "Power: " << pow(2.0, 3.0) << '\\n';

    (void)squares;
    (void)average;
    (void)found;
    (void)duplicates;
    (void)partial;
    (void)differences;
}

// ============================================================
// 4. STRING, STRING_VIEW, STREAMS, REGEX
// ============================================================

void demoStrings() {
    string text = "Modern C++ STL";
    string_view view(text);

    cout << "Text: " << view << '\\n';
    cout << "Length: " << text.length() << '\\n';
    cout << "Substring: " << text.substr(7, 3) << '\\n';

    stringstream ss;
    ss << "Age=" << 25 << ", Score=" << 95.5;

    string parsed = ss.str();
    cout << parsed << '\\n';

    regex numberPattern(R"(\\d+)");
    string input = "Version 20 and year 2026";

    for (sregex_iterator i(input.begin(), input.end(),
                           numberPattern), end;
         i != end; ++i) {
        cout << "Number: " << i->str() << '\\n';
    }

    // C++17 thay th? cho C++20 starts_with / ends_with
    bool startsWithModern = (text.rfind("Modern", 0) == 0);
    bool endsWithSTL = (text.length() >= 3 && text.compare(text.length() - 3, 3, "STL") == 0);

    cout << "Starts with Modern: " << startsWithModern << '\\n';
    cout << "Ends with STL: " << endsWithSTL << '\\n';
}

// ============================================================
// 5. UTILITIES: PAIR, TUPLE, OPTIONAL, VARIANT, ANY
// ============================================================

void demoUtilities() {
    pair<string, int> p{"Alice", 30};
    cout << p.first << ", " << p.second << '\\n';

    tuple<string, int, double> data{"Bob", 25, 88.5};
    auto [name, age, score] = data;
    cout << name << ' ' << age << ' ' << score << '\\n';

    optional<int> maybeValue = 42;
    cout << "Optional: " << maybeValue.value_or(0) << '\\n';

    optional<int> emptyValue;
    if (!emptyValue) {
        cout << "No value available\\n";
    }

    variant<int, string> v = string("Hello variant");
    cout << get<string>(v) << '\\n';

    v = 100;
    cout << get<int>(v) << '\\n';

    any anything = string("Stored in any");
    cout << any_cast<string>(anything) << '\\n';

    anything = 123;
    cout << any_cast<int>(anything) << '\\n';

    // Function, bind, reference_wrapper
    function<int(int, int)> operation = add<int>;
    cout << "Function: " << operation(3, 4) << '\\n';

    auto multiply = [](int a, int b) { return a * b; };
    auto doubleNumber = bind(multiply, placeholders::_1, 2);
    cout << "Bind: " << doubleNumber(5) << '\\n';

    int original = 10;
    reference_wrapper<int> refWrap = std::ref(original);
    refWrap.get() = 20;
    cout << "Reference wrapper: " << original << '\\n';
}

// ============================================================
// 6. SMART POINTERS, RAII
// ============================================================

void demoMemory() {
    auto unique = make_unique<Person>(Person{"Alice", 30});
    cout << "Unique: " << unique->name << '\\n';

    auto shared1 = make_shared<Person>(Person{"Bob", 25});
    shared_ptr<Person> shared2 = shared1;
    weak_ptr<Person> weak = shared1;

    cout << "Shared count: " << shared1.use_count() << '\\n';

    if (auto locked = weak.lock()) {
        cout << "Weak lock: " << locked->name << '\\n';
    }

    shared2.reset();

    cout << "Shared count after reset: "
         << shared1.use_count() << '\\n';
}

// ============================================================
// 7. RANDOM, CHRONO, FILE I/O (FSTREAM TRONG MEMFS)
// ============================================================

void demoSystemUtilities() {
    mt19937 rng(1337);
    uniform_int_distribution<int> distribution(1, 100);

    cout << "Random: " << distribution(rng) << '\\n';

    auto start = chrono::steady_clock::now();

    volatile long long result = 0;
    for (int i = 0; i < 100000; ++i) {
        result = result + i;
    }

    auto end = chrono::steady_clock::now();

    auto elapsed = chrono::duration_cast<
        chrono::microseconds
    >(end - start);

    cout << "Elapsed: " << elapsed.count() << " us\\n";
    cout << "Example filename: sample.txt\\n";

    // File I/O trong h? th?ng t?p ?o WebAssembly (memfs)
    {
        ofstream file("stl_sample.txt");
        if (file) {
            file << "Hello from STL fstream in WebAssembly\\n";
        }
    }

    {
        ifstream file("stl_sample.txt");
        string line;
        if (getline(file, line)) {
            cout << "File content: " << line << '\\n';
        }
    }

    (void)result;
}

// ============================================================
// 8. RANGES / ALGORITHM EQUIVALENT (C++17)
// ============================================================

void demoRanges() {
    vector<int> values{1, 2, 3, 4, 5, 6, 7, 8, 9, 10};

    vector<int> evenSquares;
    for (int x : values) {
        if (x % 2 == 0) {
            evenSquares.push_back(x * x);
        }
    }

    cout << "Even squares: ";
    for (int x : evenSquares) {
        cout << x << ' ';
    }
    cout << '\\n';

    bool allPositive = all_of(
        values.begin(), values.end(), [](int x) { return x > 0; }
    );

    cout << "All positive: " << allPositive << '\\n';
}

// ============================================================
// 9. TYPE TRAITS
// ============================================================

void demoTypeTraits() {
    cout << boolalpha;
    cout << "int is integral: " << is_integral_v<int> << '\\n';
    cout << "double is floating: "
         << is_floating_point_v<double> << '\\n';
}

// ============================================================
// MAIN
// ============================================================

int main() {
    cout << "===== STL CONTAINERS =====\\n";
    demoContainers();

    cout << "\\n===== ALGORITHMS =====\\n";
    demoAlgorithms();

    cout << "\\n===== STRINGS =====\\n";
    demoStrings();

    cout << "\\n===== UTILITIES =====\\n";
    demoUtilities();

    cout << "\\n===== SMART POINTERS =====\\n";
    demoMemory();

    cout << "\\n===== SYSTEM UTILITIES =====\\n";
    demoSystemUtilities();

    cout << "\\n===== RANGES (C++17) =====\\n";
    demoRanges();

    cout << "\\n===== TYPE TRAITS =====\\n";
    demoTypeTraits();

    cout << "\\n===== CONSTRAINED FUNCTION (C++17 SFINAE) =====\\n";
    cout << "Add: " << add(10, 20) << '\\n';

    cout << "\\nAll demos completed.\\n";
    return 0;
}
`;

describe('user STL demo analysis', () => {
  it('parses the entire user STL demo code with zero syntax errors in fast engine', () => {
    const result = analyzeSource(USER_CODE, 'main.cpp');
    expect(result.errorCount).toBe(0);
  });

  it('parses nested templates with closing >> correctly', () => {
    const code = `using namespace std;
void f() {
    priority_queue<int, vector<int>, greater<int>> minHeap;
    minHeap.push(10);
}`;
    const result = analyzeSource(code, 'main.cpp');
    expect(result.errorCount).toBe(0);
  });

  it('parses direct-initialization with parentheses for objects', () => {
    const code = `using namespace std;
void f() {
    bitset<8> bits(42);
    vector<int> values{1, 2, 3};
    vector<int> squares(values.size());
    string text = "hello";
    string_view view(text);
    ofstream file("out.txt");
    mt19937 rng(1337);
    uniform_int_distribution<int> dist(1, 100);
}`;
    const result = analyzeSource(code, 'main.cpp');
    expect(result.errorCount).toBe(0);
  });

  it('parses temporary object constructors and uniform initialization in expressions', () => {
    const code = `using namespace std;
struct IsEven { bool operator()(int n) const { return n % 2 == 0; } };
struct Person { string name; int age; };
void f() {
    int c = count_if(v.begin(), v.end(), IsEven{});
    auto p = make_unique<Person>(Person{"Alice", 30});
}`;
    const result = analyzeSource(code, 'main.cpp');
    expect(result.errorCount).toBe(0);
  });

  it('parses declaration inside if condition', () => {
    const code = `void f() {
    if (auto locked = weak.lock()) {
        cout << locked->name;
    }
}`;
    const result = analyzeSource(code, 'main.cpp');
    expect(result.errorCount).toBe(0);
  });

  it('parses template expressions followed by operators or semicolons', () => {
    const code = `using namespace std;
template <typename T> T add(T a, T b) { return a + b; }
void f() {
    auto op = add<int>;
    cout << "val: " << is_integral_v<int> << '\\n';
}`;
    const result = analyzeSource(code, 'main.cpp');
    expect(result.errorCount).toBe(0);
  });
});
