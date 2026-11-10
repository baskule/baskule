export declare function withBootScheduler<A>(run: () => A): A;
export declare function bindBootScheduler(
  fallback?: (task: () => void) => () => void,
): (task: () => void) => () => void;
