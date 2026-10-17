import { formatCents, parseWeightInput } from './calculation';

// Preparatory boundary only: shared UI must stay read-only until the real local
// Auth/PostgREST design gate passes. Never accept JSON numeric weight values.
export function sharedWeightText(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) {
    throw new RangeError('Shared share weight must be exact decimal text.');
  }
  parseWeightInput(value);
  return value;
}

export function sharedOverrideText(value: unknown): string | null {
  return value === null ? null : sharedWeightText(value);
}

// Input syntax follows the existing parser; format only integer hundredth units.
// No Number/parseFloat conversion or fractional arithmetic on the wire boundary.
export function sharedWeightInput(input: string): string {
  return formatCents(parseWeightInput(input));
}

export function sharedOverrideInput(input: string): string | null {
  return input.trim() === '' ? null : sharedWeightInput(input);
}
