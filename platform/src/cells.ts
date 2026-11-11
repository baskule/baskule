import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import type { ControlCell as ControlImplementation } from "./control/index";
import type { SpaceCell as SpaceImplementation, SpaceEnv } from "./space/index";

// Keep the public entry small. The implementation receives the same cell context,
// so imports do not create another identity, database, or lifetime.
export class ControlCell extends DurableObject<Env> {
  private implementation: Promise<ControlImplementation> | undefined;

  private load() {
    return this.implementation ??= import("./control/index").then(({ ControlCell }) => new ControlCell(this.ctx, this.env));
  }

  async fetch(request: Request) {
    return (await this.load()).fetch(request);
  }
}

export class SpaceCell extends DurableObject<SpaceEnv> {
  private implementation: Promise<SpaceImplementation> | undefined;

  private load() {
    return this.implementation ??= import("./space/index").then(({ SpaceCell }) => new SpaceCell(this.ctx, this.env));
  }

  async fetch(request: Request) {
    return (await this.load()).fetch(request);
  }

  async alarm() {
    return (await this.load()).alarm();
  }
}
