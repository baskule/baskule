import * as Crypto from "expo-crypto";
import { customRandom, urlAlphabet } from "nanoid";

export const newThreadId = customRandom(urlAlphabet, 21, Crypto.getRandomBytes);

export const uuidv4 = () => Crypto.randomUUID();

export const randomHex = (byteLength: number): string =>
  Array.from(Crypto.getRandomBytes(byteLength), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
