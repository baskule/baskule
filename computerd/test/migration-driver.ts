import { DockerBackend } from "../src/docker.ts";
import { namesFor } from "../src/policy.ts";
const [space, legacy, image, network, instance] = process.argv.slice(2);
const backend = new DockerBackend(undefined, network, image, undefined, legacy);
try {
  await backend.ensureDisk({ disk: namesFor(space, instance).volume, legacyDisk: namesFor(space, "").volume, image, labels: { "baskule.migration-test": space } });
} finally { backend.close(); }
