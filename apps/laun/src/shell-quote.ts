/** POSIX single-quote one data value without evaluating shell punctuation. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
