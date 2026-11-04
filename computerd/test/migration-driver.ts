import { DockerBackend } from "../src/docker.ts";
import { namesFor } from "../src/policy.ts";
const [space, legacy, image, network, instance] = process.argv.slice(2);
process.env.COMPUTERD_INSTANCE = instance;
const backend = new DockerBackend(undefined, network, "baskule-computerd:local", undefined, legacy);
try {
  await backend.ensureDisk({ disk: namesFor(space, instance).volume, legacyDisk: namesFor(space, "").volume, image, labels: { "baskule.migration-test": space } });
} finally { backend.close(); }
