// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 vega-pair contributors

import qrcode from 'qrcode-generator';

/** Modules of empty border that scanners need. */
export const QUIET_ZONE = 2;

/**
 * Builds the whole QR code as one SVG path (one 1x1 square per dark module),
 * so it renders as a single native view instead of hundreds. Pure JS, so it
 * works wherever qrcode-generator does.
 */
export function qrToPath(value: string, quietZone = QUIET_ZONE): { path: string; count: number } {
  const qr = qrcode(0, 'M');
  qr.addData(value);
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (qr.isDark(row, col)) d += `M${col + quietZone} ${row + quietZone}h1v1h-1z`;
    }
  }
  return { path: d, count: n + quietZone * 2 };
}
