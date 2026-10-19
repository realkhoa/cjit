/**
 * @file studentCast.test.ts
 * @brief Regression tests for parsing and executing C-style casts to user struct tags and sizeof(Struct).
 */

import { describe, expect, it } from 'vitest';
import { analyzeSource } from '../src/lang/analyze';

describe('student cast bug reproduction', () => {
  it('parses user full program without syntax errors', () => {
    const code = `
#include <iostream>
#include <cstdlib>
#include <cstring>
using namespace std;

struct Student {
    int id;
    char name[50];
    float gpa;
};

int main() {
    int n;

    cout << "Nhap so luong sinh vien: ";
    cin >> n;

    if (n <= 0) {
        cout << "So luong khong hop le!\\n";
        return 1;
    }

    // Cap phat bo nho bang calloc
    Student* students = (Student*)calloc(n, sizeof(Student));

    if (students == nullptr) {
        cout << "Cap phat bo nho that bai!\\n";
        return 1;
    }

    // Nhap thong tin sinh vien
    for (int i = 0; i < n; i++) {
        cout << "\\nSinh vien " << i + 1 << ":\\n";

        cout << "ID: ";
        cin >> students[i].id;

        cin.ignore(10000, '\\n');

        cout << "Ho ten: ";
        cin.getline(students[i].name, 50);

        cout << "GPA: ";
        cin >> students[i].gpa;
    }

    // Cap phat them bo nho bang malloc
    Student* backup = (Student*)malloc(n * sizeof(Student));

    if (backup == nullptr) {
        free(students);
        cout << "Cap phat bo nho that bai!\\n";
        return 1;
    }

    // Sao chep du lieu
    memcpy(backup, students, n * sizeof(Student));

    // In danh sach
    cout << "\\n===== DANH SACH SINH VIEN =====\\n";

    for (int i = 0; i < n; i++) {
        cout << "ID: " << backup[i].id << '\\n';
        cout << "Ho ten: " << backup[i].name << '\\n';
        cout << "GPA: " << backup[i].gpa << "\\n\\n";
    }

    // Giai phong bo nho
    free(students);
    free(backup);

    return 0;
}
`;
    const result = analyzeSource(code, 'main.cpp');
    expect(result.diagnostics).toEqual([]);
  });

  it('executes user program with calloc, malloc, memcpy and free successfully', async () => {
    const { execute } = await import('../src/lang/runtime/interpreter');
    const code = `
#include <iostream>
#include <cstdlib>
#include <cstring>
using namespace std;

struct Student {
    int id;
    char name[50];
    float gpa;
};

int main() {
    int n = 1;

    // Cap phat bo nho bang calloc
    Student* students = (Student*)calloc(n, sizeof(Student));
    if (students == nullptr) return 1;

    students[0].id = 101;
    strcpy(students[0].name, "Nguyen Van A");
    students[0].gpa = 3.8f;

    // Cap phat them bo nho bang malloc
    Student* backup = (Student*)malloc(n * sizeof(Student));
    if (backup == nullptr) {
        free(students);
        return 1;
    }

    // Sao chep du lieu
    memcpy(backup, students, n * sizeof(Student));

    cout << "ID: " << backup[0].id << "\\n";
    cout << "Ho ten: " << backup[0].name << "\\n";

    free(students);
    free(backup);
    return 0;
}
`;
    const analysis = analyzeSource(code, 'main.cpp');
    expect(analysis.diagnostics).toEqual([]);
    const execResult = execute(analysis.unit);
    expect(execResult.exitCode).toBe(0);
    expect(execResult.stdout).toContain('ID: 101');
    expect(execResult.stdout).toContain('Ho ten: Nguyen Van A');
  });

  it('supports standard Legacy C code with struct keywords in main.c', async () => {
    const { execute } = await import('../src/lang/runtime/interpreter');
    const code = `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct Student {
    int id;
    char name[50];
    float gpa;
};

int main(void) {
    int n = 1;
    struct Student* students = (struct Student*)calloc(n, sizeof(struct Student));
    if (students == NULL) return 1;
    students[0].id = 42;
    strcpy(students[0].name, "Legacy C");
    students[0].gpa = 3.9f;

    struct Student* backup = (struct Student*)malloc(n * sizeof(struct Student));
    if (backup == NULL) {
        free(students);
        return 1;
    }
    memcpy(backup, students, n * sizeof(struct Student));
    printf("ID: %d, Name: %s, GPA: %.1f\\n", backup[0].id, backup[0].name, backup[0].gpa);

    free(students);
    free(backup);
    return 0;
}
`;
    const analysis = analyzeSource(code, 'main.c');
    expect(analysis.diagnostics).toEqual([]);
    const execResult = execute(analysis.unit);
    expect(execResult.exitCode).toBe(0);
    expect(execResult.stdout).toContain('ID: 42, Name: Legacy C, GPA: 3.9');
  });

  it('supports permissive C code using bare struct tag in main.c', async () => {
    const { execute } = await import('../src/lang/runtime/interpreter');
    const code = `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct Student {
    int id;
    char name[50];
    float gpa;
};

int main(void) {
    int n = 1;
    // Permissive bare tag cast and sizeof in .c file without typedef
    Student* students = (Student*)calloc(n, sizeof(Student));
    if (students == NULL) return 1;
    students[0].id = 99;
    strcpy(students[0].name, "Permissive C");
    students[0].gpa = 4.0f;

    printf("ID: %d, Name: %s\\n", students[0].id, students[0].name);
    free(students);
    return 0;
}
`;
    const analysis = analyzeSource(code, 'main.c');
    expect(analysis.diagnostics).toEqual([]);
    const execResult = execute(analysis.unit);
    expect(execResult.exitCode).toBe(0);
    expect(execResult.stdout).toContain('ID: 99, Name: Permissive C');
  });

  it('supports Legacy C typedef struct patterns', async () => {
    const { execute } = await import('../src/lang/runtime/interpreter');
    const code = `
#include <stdio.h>
#include <stdlib.h>

typedef struct Node {
    int val;
    struct Node* next;
} Node;

int main(void) {
    Node* head = (Node*)malloc(sizeof(Node));
    head->val = 10;
    head->next = (Node*)malloc(sizeof(Node));
    head->next->val = 20;
    head->next->next = NULL;

    printf("%d -> %d\\n", head->val, head->next->val);
    free(head->next);
    free(head);
    return 0;
}
`;
    const analysis = analyzeSource(code, 'main.c');
    expect(analysis.diagnostics).toEqual([]);
    const execResult = execute(analysis.unit);
    expect(execResult.exitCode).toBe(0);
    expect(execResult.stdout).toContain('10 -> 20');
  });
});
