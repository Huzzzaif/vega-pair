// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 vega-pair contributors

import React, { useMemo } from 'react';
// @amazon-devices/react-native-qrcode-svg@3.0.0 breaks Yarn 4 installs
// (a "+build" suffix in a dependency range), so we draw the QR ourselves.
import Svg, { Path, Rect } from '@amazon-devices/react-native-svg';
import { qrToPath } from './qrPath.ts';

export type PairingQrCodeProps = {
  /** What the QR encodes: the `joinUrl` from usePairing. */
  value: string;
  /** Width and height in dp. */
  size: number;
  color?: string;
  background?: string;
};

export function PairingQrCode({ value, size, color = '#000000', background = '#ffffff' }: PairingQrCodeProps) {
  const { path, count } = useMemo(() => qrToPath(value), [value]);
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${count} ${count}`}>
      <Rect x={0} y={0} width={count} height={count} fill={background} />
      <Path d={path} fill={color} />
    </Svg>
  );
}
