export interface Options {
  value: number;
}
export function calculate(value: number): number {
  return value + 1;
}
export class Calculator {
  run(value: number): number {
    return calculate(value);
  }
  static create(): Calculator {
    return new Calculator();
  }
}
