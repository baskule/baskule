#!/usr/bin/env node
// Creates an S3 bucket if missing (SigV4, path-style), for the local RustFS dev store. No dependencies.
//   AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… node dev/s3-mkbucket.mjs http://127.0.0.1:47602 <bucket>
import { createHash, createHmac } from "node:crypto";

const [endpoint, bucket] = process.argv.slice(2);
const key = process.env.AWS_ACCESS_KEY_ID, secret = process.env.AWS_SECRET_ACCESS_KEY, region = process.env.AWS_REGION ?? "us-east-1";
if (!endpoint || !bucket || !key || !secret) { console.error("usage: s3-mkbucket.mjs <endpoint> <bucket> (AWS_* env)"); process.exit(2); }

const sha = (s) => createHash("sha256").update(s).digest("hex");
const hmac = (k, s) => createHmac("sha256", k).update(s).digest();

async function signed(method) {
  const u = new URL(`/${bucket}`, endpoint);
  const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = now.slice(0, 8);
  const payload = sha("");
  const headers = { host: u.host, "x-amz-content-sha256": payload, "x-amz-date": now };
  const names = Object.keys(headers).sort();
  const canonical = [method, u.pathname, "", ...names.map((n) => `${n}:${headers[n]}`), "", names.join(";"), payload].join("\n");
  const scope = `${date}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", now, scope, sha(canonical)].join("\n");
  const kSig = hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), "s3"), "aws4_request");
  const sig = createHmac("sha256", kSig).update(toSign).digest("hex");
  const auth = `AWS4-HMAC-SHA256 Credential=${key}/${scope}, SignedHeaders=${names.join(";")}, Signature=${sig}`;
  const { host: _host, ...rest } = headers;
  return fetch(u, { method, headers: { ...rest, authorization: auth } });
}

const head = await signed("HEAD");
if (head.ok) { console.error(`bucket ${bucket} exists`); process.exit(0); }
const put = await signed("PUT");
if (!put.ok) { console.error(`create bucket ${bucket}: ${put.status} ${await put.text()}`); process.exit(1); }
console.error(`bucket ${bucket} created`);
