export type ScopedProvider<T> = {
  run<R>(value: T, fn: () => R): R;
  get(): T | undefined;
  require(): T;
};

export function createScopedProvider<T>(): ScopedProvider<T> {
  const stack: T[] = [];
  return {
    run<R>(value: T, fn: () => R): R {
      stack.push(value);
      try {
        return fn();
      } finally {
        stack.pop();
      }
    },
    get(): T | undefined {
      return stack.length > 0 ? stack[stack.length - 1] : undefined;
    },
    require(): T {
      const v = stack.length > 0 ? stack[stack.length - 1] : undefined;
      if (v === undefined) {
        throw new Error("ScopedProvider: no value in scope");
      }
      return v;
    },
  };
}
