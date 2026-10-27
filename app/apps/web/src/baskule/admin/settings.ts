// baskule: each admin page saves only its own settings, on top of the latest saved ones.
import { baskuleApi, type BaskuleProductSettings } from "../api";

export async function saveSettingsPart(
  part: Partial<BaskuleProductSettings> & {
    readonly apiKey?: string;
    readonly transcriptionApiKey?: string;
  },
) {
  const { organizationName, idleMinutes, ai, transcription, googleSignupDomains } =
    await baskuleApi.adminSettings();
  return baskuleApi.saveSettings({
    organizationName,
    idleMinutes,
    ai,
    transcription,
    googleSignupDomains,
    ...part,
  });
}
