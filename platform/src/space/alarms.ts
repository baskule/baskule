/** A DO has one physical alarm. Persist each runtime's deadline so neither can cancel the other's work. */
export class SpaceAlarms {
  private queue: Promise<unknown> = Promise.resolve();
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn);
    this.queue = result.catch(() => {});
    return result;
  }
  constructor(private storage: DurableObjectStorage) {}
  private key(owner: string) { return `baskule:alarm:${owner}`; }
  private claim(owner: string) { return `baskule:alarm-running:${owner}`; }
  async get(owner: string): Promise<number | null> { return await this.storage.get<number>(this.key(owner)) ?? null; }
  set(owner: string, time: number | Date) { return this.serial(async () => {
    await this.storage.put(this.key(owner), Number(time));
    await this.flush();
  }); }
  clear(owner: string) { return this.serial(async () => { await this.storage.delete(this.key(owner)); await this.storage.delete(this.claim(owner)); await this.flush(); }); }
  sync() { return this.serial(() => this.flush()); }
  private async flush() {
    const deadlines = await Promise.all([this.get("space"), this.get("agent")]);
    const live = deadlines.filter((n): n is number => n !== null);
    for (const owner of ["space", "agent"]) if (await this.storage.get(this.claim(owner))) live.push(Date.now() + 5000);
    if (live.length) await this.storage.setAlarm(Math.max(Date.now() + 1, Math.min(...live)));
    else await this.storage.deleteAlarm();
  }
  due(): Promise<string[]> { return this.serial(async () => {
    const owners = [];
    for (const owner of ["space", "agent"]) {
      const deadline = await this.get(owner);
      if (await this.storage.get(this.claim(owner)) || (deadline !== null && deadline <= Date.now() + 1000)) {
        owners.push(owner);
        // Persist a claim before removing its deadline, so process loss cannot lose due work.
        await this.storage.put(this.claim(owner), true);
        await this.storage.delete(this.key(owner));
      }
    }
    return owners;
  }); }
  complete(owners: string[]) { return this.serial(async () => {
    for (const owner of owners) await this.storage.delete(this.claim(owner));
    await this.flush();
  }); }
  forAgent(): DurableObjectStorage {
    const self = this;
    return new Proxy(this.storage, { get(target, property) {
      if (property === "getAlarm") return () => self.get("agent");
      if (property === "setAlarm") return (time: number | Date) => self.set("agent", time);
      if (property === "deleteAlarm") return () => self.clear("agent");
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  }
}
