import * as NodeBuffer from "node:buffer";
import { expect, it, vi } from "vite-plus/test";
import { installFormDataPatch } from "expo/src/winter/FormData";
import { convertFormDataAsync } from "expo/src/winter/fetch/convertFormData";
import { appendPreviewFile } from "./preview-file-form";
import { PREVIEW_UPLOAD_FILENAME_ENCODING_FIELD, previewUploadFileName } from "@t3tools/contracts";

class NativeFormData {
  readonly _parts: Array<[string, string | Blob]> = [];
}

const Form = NativeFormData as unknown as typeof FormData;
installFormDataPatch(Form);

async function parseMultipart(request: Request) {
  // React Native declares FormData without the Node parser's lookup methods.
  return request.formData() as unknown as Promise<{
    get(name: string): unknown;
    getAll(name: string): unknown[];
  }>;
}

it("encodes picker filenames, MIME metadata and original binary bytes without native Blob construction", async () => {
  const original = new Uint8Array([0, 255, 1, 254]);
  const file = new Blob([original], { type: "application/octet-stream" });
  class NativeBlob extends Blob {
    constructor(parts: BlobPart[]) {
      if (parts.some((part) => part instanceof ArrayBuffer || ArrayBuffer.isView(part))) {
        throw new Error("Creating blobs from ArrayBuffer is not supported");
      }
      super(parts);
    }
  }
  vi.stubGlobal("Blob", NativeBlob);
  try {
    const form = new Form();
    appendPreviewFile(form, { file, name: "report one.csv", mimeType: "text/csv" });
    appendPreviewFile(form, { file, name: "résumé 文件.bin" });
    appendPreviewFile(form, { file, name: "literal%20.bin" });
    const { body, boundary } = await convertFormDataAsync(form, "native-upload-boundary");
    const encoded = new TextDecoder("latin1").decode(body);
    expect(boundary).toBe("native-upload-boundary");
    expect(encoded).toContain('name="file"; filename="report%20one.csv"\r\ncontent-type: text/csv');
    const parsed = await parseMultipart(
      new Request("https://front.test/upload", {
        method: "POST",
        body: Uint8Array.from(body).buffer,
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      }),
    );
    const files = parsed.getAll("file").map((value) => {
      if (!(value instanceof NodeBuffer.File)) throw new Error("Expected file data");
      return value;
    });
    expect(
      files.map((value) =>
        previewUploadFileName(value.name, parsed.get(PREVIEW_UPLOAD_FILENAME_ENCODING_FIELD)),
      ),
    ).toEqual(["report one.csv", "résumé 文件.bin", "literal%20.bin"]);
    expect(files.map((value) => value.type)).toEqual([
      "text/csv",
      "application/octet-stream",
      "application/octet-stream",
    ]);
    for (const value of files) expect(new Uint8Array(await value.arrayBuffer())).toEqual(original);
    const payloadStarts = [...body.keys()].filter((index) =>
      original.every((byte, offset) => body[index + offset] === byte),
    );
    expect(payloadStarts).toHaveLength(3);
    expect(encoded.endsWith("--native-upload-boundary--\r\n")).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("preserves ordinary browser filenames and rejects malformed native metadata", async () => {
  const form = new FormData();
  form.append("file", new Blob(["hello"], { type: "text/plain" }), "literal%20.txt");
  const parsed = await parseMultipart(
    new Request("https://front.test/upload", {
      method: "POST",
      body: form,
    }),
  );
  const file = parsed.get("file");
  if (!(file instanceof NodeBuffer.File)) throw new Error("Expected a file");
  expect(previewUploadFileName(file.name, parsed.get(PREVIEW_UPLOAD_FILENAME_ENCODING_FIELD))).toBe(
    "literal%20.txt",
  );
  expect(() => previewUploadFileName("bad%zz.txt", "uri")).toThrow();
  expect(() => previewUploadFileName("name.txt", "unknown")).toThrow();
});

it("encodes an empty selection for a cancelled chooser", async () => {
  const form = new Form();
  const { body } = await convertFormDataAsync(form, "cancelled-upload");
  expect(new TextDecoder().decode(body)).toBe("--cancelled-upload--\r\n");
});
