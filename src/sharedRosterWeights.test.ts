import { expect, it } from 'vitest';
import { sharedOverrideInput, sharedOverrideText, sharedWeightInput, sharedWeightText } from './sharedRosterWeights';

it.each(['0', '0.01', '1', '100.50', '90071992547409.91'])(
  'preserves exact server text %s without decimal conversion', value => {
    expect(sharedWeightText(value)).toBe(value);
    expect(sharedOverrideText(value)).toBe(value);
  },
);

it.each([
  ['0', '0.00'], ['0.01', '0.01'], ['1', '1.00'], ['100.50', '100.50'],
  ['90071992547409.91', '90071992547409.91'], [' 001.5 ', '1.50'], ['.01', '0.01'], ['1.', '1.00'],
])('canonicalizes input %s to string %s through integer units', (input, wire) => {
  expect(sharedWeightInput(input)).toBe(wire);
  expect(sharedOverrideInput(input)).toBe(wire);
  expect(sharedWeightText(wire)).toBe(wire);
});

it('keeps inherit NULL distinct from explicit zero and rejects required blank weights', () => {
  expect(sharedOverrideInput('')).toBeNull();
  expect(sharedOverrideInput('  ')).toBeNull();
  expect(sharedOverrideText(null)).toBeNull();
  expect(sharedOverrideInput('0')).toBe('0.00');
  expect(sharedOverrideText('0')).toBe('0');
  expect(() => sharedWeightInput('')).toThrow(RangeError);
  expect(() => sharedWeightText(null)).toThrow(RangeError);
});

it.each(['-1', '-0', '+1', 'NaN', 'Infinity', '-Infinity', '1e2', '1.001', '1.000', '90071992547409.92', '.', '1,000', 'abc'])(
  'rejects invalid input and server text %s rather than rounding', value => {
    expect(() => sharedWeightInput(value)).toThrow(RangeError);
    expect(() => sharedOverrideInput(value)).toThrow(RangeError);
    expect(() => sharedWeightText(value)).toThrow(RangeError);
    expect(() => sharedOverrideText(value)).toThrow(RangeError);
  },
);

it.each([0, 0.01, 100.5, NaN, Infinity, undefined, {}, [], true, '', ' 1 ', '01', '.1', '1.'])(
  'fails closed for noncanonical or nontext server value %j', value => {
    expect(() => sharedWeightText(value)).toThrow(RangeError);
    expect(() => sharedOverrideText(value)).toThrow(RangeError);
  },
);
