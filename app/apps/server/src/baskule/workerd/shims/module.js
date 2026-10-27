// celld has no createRequire. T3 modules call it at top level for optional native packages
// (keyring, fff, node-pty, playwright); the stub defers any failure to the first real use.
const stub = (id) =>
  new Proxy(function () {}, {
    get: (_t, k) =>
      k === "__esModule"
        ? false
        : k === Symbol.toPrimitive
          ? () => `[unavailable ${id}]`
          : k === "then"
            ? undefined
            : stub(`${id}.${String(k)}`),
    apply: () => {
      throw new Error(`${id}() is unavailable in a space cell`);
    },
    construct: () => {
      throw new Error(`new ${id}() is unavailable in a space cell`);
    },
  });
export const createRequire = () => (id) => stub(id);
export const builtinModules = [];
export const isBuiltin = () => false;
export default { createRequire, builtinModules, isBuiltin };
