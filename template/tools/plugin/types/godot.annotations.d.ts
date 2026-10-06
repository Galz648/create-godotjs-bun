// Type-checker stand-in. The real binder is the engine module, kept external.
export interface ClassBinder {
  (...args: unknown[]): unknown;
  export(type: number, options?: object): unknown;
  array?(clazz: unknown): unknown;
  object?(clazz: unknown): unknown;
  signal(): unknown;
  onready(evaluator: unknown): unknown;
  tool(): unknown;
}

export function createClassBinder(): ClassBinder;
