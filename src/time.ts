import { DexcomRangeError, DexcomResponseError } from "./errors.ts";
import type { TimeRange } from "./types.ts";

const OFFSET_SUFFIX = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;

/** Parses an API timestamp; one without offset is UTC (the API's systemTime). */
export function parseApiTime(value: string): Date {
  const date = new Date(OFFSET_SUFFIX.test(value) ? value : `${value}Z`);
  if (Number.isNaN(date.getTime())) throw new DexcomResponseError(`invalid timestamp: ${value}`);
  return date;
}

/** Formats a date as the API's UTC query format (seconds precision, no offset). */
export function formatApiTime(date: Date): string {
  return date.toISOString().slice(0, 19);
}

/** Splits [start, end) into consecutive windows of at most `sizeMs`. */
export function* windows(start: Date, end: Date, sizeMs: number): Generator<[Date, Date]> {
  let cursor = start.getTime();
  while (cursor < end.getTime()) {
    const upper = Math.min(cursor + sizeMs, end.getTime());
    yield [new Date(cursor), new Date(upper)];
    cursor = upper;
  }
}

export function assertRange({ from, to }: TimeRange): void {
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new DexcomRangeError("invalid date in range");
  if (from.getTime() >= to.getTime()) throw new DexcomRangeError("range must end after it starts");
}
