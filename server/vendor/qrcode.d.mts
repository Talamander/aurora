// Types for the vendored qrcode-generator 2.0.4 (MIT, Copyright (c) 2009 Kazuhiko Arase).
// Only the parts Aurora uses.
type ErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H';
interface QRCode {
  addData(data: string, mode?: 'Numeric' | 'Alphanumeric' | 'Byte' | 'Kanji'): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
}
declare const qrcode: (typeNumber: number, errorCorrectionLevel: ErrorCorrectionLevel) => QRCode;
export default qrcode;
