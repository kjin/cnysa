/// <reference path="./types.d.ts" />

import * as stringLength from 'string-length';

export function assemble(args: string[][][]): string {
  const columnWidths: number[] = [];
  const rowHeights: number[] = [];
  for (let y = 0; y < args.length; y++) {
    let tallestEntry = 0;
    for (let x = 0; x < args[y].length; x++) {
      if (columnWidths.length === x) {
        columnWidths.push(0);
      }
      const longestEntry = args[y][x].reduce((acc, line) => Math.max(acc, stringLength(line)), 0);
      if (columnWidths[x] < longestEntry) {
        columnWidths[x] = longestEntry;
      }
      tallestEntry = Math.max(tallestEntry, args[y][x].length);
    }
    rowHeights.push(tallestEntry);
  }
  let result = '';
  for (let y = 0; y < args.length; y++) {
    for (let l = 0; l < rowHeights[y]; l++) {
      for (let x = 0; x < args[y].length; x++) {
        result += (args[y][x][l] || '') + ' '.repeat(columnWidths[x] - stringLength(args[y][x][l] || '')) + ' ';
      }
      result = result.trim() + '\n';
    }
    result = result.trim() + '\n\n';
  }
  return result.trim();
}
