// No raw TCP in a cell. BlockList is constructed at module top level by T3's html render proxy.
export class BlockList {
  addSubnet() {}
  addAddress() {}
  addRange() {}
  check() {
    return false;
  }
}
export const isIP = (s) => (/^\d+\.\d+\.\d+\.\d+$/.test(s) ? 4 : String(s).includes(":") ? 6 : 0);
export const isIPv4 = (s) => isIP(s) === 4;
export const isIPv6 = (s) => isIP(s) === 6;
const unavailable = (name) => () => {
  throw new Error(`node:net.${name} is unavailable in a space cell`);
};
export const createServer = unavailable("createServer");
// baskule(wp-h): client sockets are refused asynchronously, like a closed port, instead of throwing: upstream port
// probes (RemoteOpenTargets' sshd check in loadServerConfig) treat a refusal as "no listener"; a throw was an
// unhandled defect that broke `subscribeServerConfig`, so the web client never left "Opening your spaces…".
class RefusedSocket {
  #handlers = new Map();
  constructor(options) {
    const port = typeof options === "object" && options !== null ? options.port : options;
    queueMicrotask(() => {
      const err = Object.assign(
        new Error(`connect ECONNREFUSED (no raw TCP in a space cell, port ${port})`),
        {
          code: "ECONNREFUSED",
        },
      );
      this.#emit("error", err);
      this.#emit("close", true);
    });
  }
  #emit(event, ...args) {
    for (const fn of this.#handlers.get(event) ?? []) fn(...args);
    this.#handlers.delete(event);
  }
  on(event, fn) {
    this.#handlers.set(event, [...(this.#handlers.get(event) ?? []), fn]);
    return this;
  }
  once(event, fn) {
    return this.on(event, fn);
  }
  off(event) {
    this.#handlers.delete(event);
    return this;
  }
  removeListener(event) {
    return this.off(event);
  }
  removeAllListeners() {
    this.#handlers.clear();
    return this;
  }
  setTimeout() {
    return this;
  }
  setNoDelay() {
    return this;
  }
  setKeepAlive() {
    return this;
  }
  unref() {
    return this;
  }
  ref() {
    return this;
  }
  write() {
    return false;
  }
  end() {
    return this;
  }
  destroy() {
    return this;
  }
}
export const connect = (options) => new RefusedSocket(options);
export const createConnection = connect;
export function Socket() {
  throw new Error("node:net.Socket is unavailable in a space cell");
}
export function Server() {
  throw new Error("node:net.Server is unavailable in a space cell");
}
export default {
  BlockList,
  isIP,
  isIPv4,
  isIPv6,
  createServer,
  connect,
  createConnection,
  Socket,
  Server,
};
