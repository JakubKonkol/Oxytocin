import { compute, Calculator, type Options } from '@lib/index.js';
import * as math from '@fixture/math';
export function run(options: Options): number {
  Calculator.create();
  return compute(options.value) + math.twice(2);
}
export function shadow(compute: () => number): number {
  return compute();
}
