export declare function withBootScheduler<A>(run: () => A, signal?: AbortSignal): A;
export declare function bindBootScheduler(): (task: () => void) => () => void;
