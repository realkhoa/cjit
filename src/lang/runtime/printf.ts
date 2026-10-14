import type { Memory } from '@/lang/memory';
import { toNumber } from '@/lang/runtime/value';
import type { Value } from '@/lang/runtime/value';

/**
 * `printf` family formatting, with real C conversion rules.
 *
 * Supported: `%%`, `%d %i %u %o %x %X %c %s %f %F %e %E %g %G %p`, the flags
 * `- + space 0 #`, explicit or `*` width and precision, and the length modifiers
 * `hh h l ll L z j t` (which do not change the value here, since a JS number
 * carries the integer either way).
 */

export interface FormatResult {
  readonly text: string;
  /** How many arguments were consumed, so the caller can check for extras. */
  readonly used: number;
}

const FLAGS = new Set(['-', '+', ' ', '0', '#']);
const LENGTH_MODIFIERS = ['hh', 'll', 'h', 'l', 'L', 'z', 'j', 't'];

interface Spec {
  leftAlign: boolean;
  plus: boolean;
  space: boolean;
  zeroPad: boolean;
  alternate: boolean;
  width: number | undefined;
  precision: number | undefined;
}

function pad(text: string, spec: Spec, numeric: boolean): string {
  const width = spec.width ?? 0;
  if (text.length >= width) return text;

  const filler = spec.zeroPad && !spec.leftAlign && numeric ? '0' : ' ';
  const missing = width - text.length;

  if (spec.leftAlign) return text + ' '.repeat(missing);

  if (filler === '0' && (text.startsWith('-') || text.startsWith('+') || text.startsWith(' '))) {
    return text.charAt(0) + '0'.repeat(missing) + text.slice(1);
  }
  return filler.repeat(missing) + text;
}

function toUnsigned(value: number, bits: number): number {
  const safeBits = Number.isFinite(bits) && bits > 0 && bits < 53 ? bits : 32;
  const modulus = 2 ** safeBits;
  return ((Math.trunc(value) % modulus) + modulus) % modulus;
}

function applySign(text: string, spec: Spec, negative: boolean): string {
  if (negative) return `-${text}`;
  if (spec.plus) return `+${text}`;
  if (spec.space) return ` ${text}`;
  return text;
}

function formatFloat(value: number, spec: Spec, conversion: string): string {
  const precision = spec.precision ?? 6;
  const upper = conversion === conversion.toUpperCase();
  let text: string;

  switch (conversion.toLowerCase()) {
    case 'f':
      text = Number.isFinite(value) ? value.toFixed(precision) : `${value}`;
      break;
    case 'e':
      text = Number.isFinite(value) ? value.toExponential(precision) : `${value}`;
      break;
    default: {
      // %g: shortest of %e and %f with the requested significant digits.
      if (!Number.isFinite(value)) {
        text = `${value}`;
      } else {
        const digits = precision === 0 ? 1 : precision;
        text = String(Number(value.toPrecision(digits)));
        if (spec.alternate && !text.includes('.')) text += '.';
      }
      break;
    }
  }

  if (upper) text = text.toUpperCase();
  return text;
}

function formatInteger(value: number, spec: Spec, conversion: string, bits: number): string {
  const lower = conversion.toLowerCase();
  const negative = lower === 'd' || lower === 'i' ? value < 0 : false;
  const magnitude = negative ? -value : value;

  let digits: string;
  if (lower === 'o') {
    digits = toUnsigned(magnitude, bits).toString(8);
    if (spec.alternate && !digits.startsWith('0')) digits = `0${digits}`;
  } else if (lower === 'x' || lower === 'X') {
    digits = toUnsigned(magnitude, bits).toString(16);
    if (conversion === 'X') digits = digits.toUpperCase();
    if (spec.alternate && toUnsigned(magnitude, bits) !== 0) {
      digits = `${conversion === 'X' ? '0X' : '0x'}${digits}`;
    }
  } else if (lower === 'u') {
    digits = `${toUnsigned(magnitude, bits)}`;
  } else {
    digits = `${magnitude}`;
  }

  if (spec.precision !== undefined && digits.length < spec.precision) {
    digits = '0'.repeat(spec.precision - digits.length) + digits;
  }

  // Zero padding is suppressed by an explicit precision, as in C.
  if (spec.precision !== undefined) spec.zeroPad = false;

  return applySign(digits, spec, negative);
}

export function formatC(format: string, args: readonly Value[], memory: Memory): FormatResult {
  let output = '';
  let used = 0;
  let index = 0;

  const nextArg = (): Value | undefined => {
    const value = args[used];
    used += 1;
    return value;
  };

  while (index < format.length) {
    const char = format.charAt(index);
    if (char !== '%') {
      output += char;
      index += 1;
      continue;
    }

    index += 1;
    const spec: Spec = {
      leftAlign: false,
      plus: false,
      space: false,
      zeroPad: false,
      alternate: false,
      width: undefined,
      precision: undefined,
    };

    while (index < format.length && FLAGS.has(format.charAt(index))) {
      const flag = format.charAt(index);
      if (flag === '-') spec.leftAlign = true;
      else if (flag === '+') spec.plus = true;
      else if (flag === ' ') spec.space = true;
      else if (flag === '0') spec.zeroPad = true;
      else if (flag === '#') spec.alternate = true;
      index += 1;
    }

    if (format.charAt(index) === '*') {
      index += 1;
      const widthValue = nextArg();
      const width = Math.trunc(toNumber(widthValue ?? { kind: 'int', type: { kind: 'int', name: 'int', size: 4, signed: true, bits: 32 }, value: 0 }));
      if (width < 0) {
        spec.leftAlign = true;
        spec.width = -width;
      } else {
        spec.width = width;
      }
    } else {
      let widthText = '';
      while (index < format.length && /\d/.test(format.charAt(index))) {
        widthText += format.charAt(index);
        index += 1;
      }
      if (widthText.length > 0) spec.width = Number.parseInt(widthText, 10);
    }

    if (format.charAt(index) === '.') {
      index += 1;
      if (format.charAt(index) === '*') {
        index += 1;
        const precisionValue = nextArg();
        const precision = Math.trunc(toNumber(precisionValue ?? { kind: 'void', type: { kind: 'void', name: 'void', size: 0, signed: false, bits: 0 } }));
        spec.precision = precision < 0 ? undefined : precision;
      } else {
        let precisionText = '';
        while (index < format.length && /\d/.test(format.charAt(index))) {
          precisionText += format.charAt(index);
          index += 1;
        }
        spec.precision = precisionText.length > 0 ? Number.parseInt(precisionText, 10) : 0;
      }
    }

    const modifier = LENGTH_MODIFIERS.find((candidate) => format.startsWith(candidate, index));
    if (modifier) index += modifier.length;

    const conversion = format.charAt(index);
    index += 1;

    if (conversion === '') {
      output += '%';
      break;
    }

    if (conversion === '%') {
      output += '%';
      continue;
    }

    const argument = nextArg() ?? { kind: 'int', type: { kind: 'int', name: 'int', size: 4, signed: true, bits: 32 }, value: 0 };
    const bits = argument.type.bits > 0 ? argument.type.bits : 32;

    switch (conversion) {
      case 'd':
      case 'i':
      case 'u':
      case 'o':
      case 'x':
      case 'X':
        output += pad(
          formatInteger(toNumber(argument), spec, conversion, bits),
          spec,
          true,
        );
        break;

      case 'c': {
        const code = Math.trunc(toNumber(argument));
        output += pad(String.fromCharCode(code & 0xff), spec, false);
        break;
      }

      case 's': {
        let text: string;
        if (argument.kind === 'pointer') {
          text = argument.address === 0 ? '(null)' : memory.readCString(argument.address, 1 << 16);
        } else if (argument.kind === 'aggregate' && argument.type.kind === 'array') {
          text = memory.readCString(argument.address, 1 << 16);
        } else {
          text = '(invalid)';
        }
        if (spec.precision !== undefined) text = text.slice(0, spec.precision);
        output += pad(text, spec, false);
        break;
      }

      case 'f':
      case 'F':
      case 'e':
      case 'E':
      case 'g':
      case 'G': {
        const text = formatFloat(toNumber(argument), spec, conversion);
        const signed = !text.startsWith('-') ? applySign(text, spec, false) : text;
        output += pad(signed, spec, true);
        break;
      }

      case 'p': {
        const address = toNumber(argument);
        const text = address === 0 ? '(nil)' : `0x${toUnsigned(address, 53).toString(16)}`;
        output += pad(text, spec, false);
        break;
      }

      default:
        output += `%${conversion}`;
        break;
    }
  }

  return { text: output, used };
}
