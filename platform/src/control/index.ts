// ControlCell: the singleton DO (name "control") holding identity, spaces, invitations (E6).
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { ControlService } from "./service";

export class ControlCell extends DurableObject<Env> {
  private service: ControlService;
  private ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.service = new ControlService(ctx.storage, env, (spaceId, path, init) =>
      env.SPACE.getByName(spaceId).fetch(new Request(`http://space${path}`, init)),
    );
    // Migrations + bootstrap before any request (blockConcurrencyWhile: ≤30 s on celld).
    this.ready = ctx.blockConcurrencyWhile(() => this.service.init());
  }

  async fetch(req: Request): Promise<Response> {
    await this.ready;
    return this.service.handle(req);
  }
}
