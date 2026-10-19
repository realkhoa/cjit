/**
 * @file scan-algorithms.ts
 * @brief Scans and parses C++ files from TheAlgorithms-CPP repository to detect edge cases in the Fast Engine parser.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeSource } from '../src/lang/analyze';

interface ScanStats {
  total: number;
  clean: number;
  withErrors: number;
  errorsByMessage: Map<string, number>;
  examples: { file: string; errors: string[] }[];
}

/**
 * @brief Recursively collects all .cpp files within a directory.
 * @param dir Directory path to scan.
 * @return Array of absolute paths to .cpp files.
 */
function getCppFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        results.push(...getCppFiles(full));
      } else if (entry.endsWith('.cpp')) {
        results.push(full);
      }
    }
  } catch {
    // skip non-existent
  }
  return results;
}

/**
 * @brief Main execution function for scanning algorithms.
 */
function main(): void {
  const argFile = process.argv[2];
  if (argFile && argFile.endsWith('.cpp')) {
    console.log(`Inspecting ${argFile}:`);
    const code = readFileSync(argFile, 'utf8');
    const result = analyzeSource(code, argFile);
    console.log(`Diagnostics count: ${result.diagnostics.length}`);
    for (const d of result.diagnostics) {
      console.log(`[${d.severity}] ${d.source}:${d.startLine}:${d.startColumn} - ${d.message}`);
    }
    return;
  }

  const targetDirs = [
    join('.repos', 'TheAlgorithms-CPP', 'search'),
    join('.repos', 'TheAlgorithms-CPP', 'sorting'),
    join('.repos', 'TheAlgorithms-CPP', 'data_structures'),
    join('.repos', 'TheAlgorithms-CPP', 'strings'),
  ];

  const allFiles: string[] = [];
  for (const dir of targetDirs) {
    allFiles.push(...getCppFiles(dir));
  }

  console.log(`Discovered ${allFiles.length} C++ files to analyze...`);

  const stats: ScanStats = {
    total: allFiles.length,
    clean: 0,
    withErrors: 0,
    errorsByMessage: new Map(),
    examples: [],
  };

  for (const file of allFiles) {
    const code = readFileSync(file, 'utf8');
    const result = analyzeSource(code, file);
    if (result.diagnostics.length === 0) {
      stats.clean++;
    } else {
      stats.withErrors++;
      const errorStrings = result.diagnostics.map((d) => d.message);
      if (stats.examples.length < 15) {
        stats.examples.push({
          file: file.replace(/\\/g, '/'),
          errors: errorStrings.slice(0, 3),
        });
      }
      for (const msg of errorStrings) {
        // Group similar error messages
        const key = msg.replace(/'[^']*'/g, "'...'").replace(/"[^"]*"/g, '"..."');
        stats.errorsByMessage.set(key, (stats.errorsByMessage.get(key) ?? 0) + 1);
      }
    }
  }

  console.log('\n================ Scan Results ================');
  console.log(`Total Files:   ${stats.total}`);
  console.log(`Clean Passes:  ${stats.clean} (${Math.round((stats.clean / stats.total) * 100)}%)`);
  console.log(`With Errors:   ${stats.withErrors} (${Math.round((stats.withErrors / stats.total) * 100)}%)`);
  console.log('\nTop Error Patterns:');
  const sortedErrors = [...stats.errorsByMessage.entries()].sort((a, b) => b[1] - a[1]);
  for (const [msg, count] of sortedErrors.slice(0, 15)) {
    console.log(`  [${count}x] ${msg}`);
  }

  console.log('\nAll Failed Files:');
  for (const ex of stats.examples) {
    console.log(`- ${ex.file}:`);
    for (const err of ex.errors) {
      console.log(`    * ${err}`);
    }
  }
}

main();
