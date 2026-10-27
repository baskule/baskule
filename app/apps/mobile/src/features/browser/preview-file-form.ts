export function appendPreviewFile(
  form: FormData,
  input: { readonly file: Blob; readonly name: string; readonly mimeType?: string },
) {
  const { file } = input;
  form.set(PREVIEW_UPLOAD_FILENAME_ENCODING_FIELD, "uri");
  const part = {
    name: input.name,
    type: input.mimeType || file.type || "application/octet-stream",
    size: file.size,
    bytes: () => file.bytes(),
    arrayBuffer: () => file.arrayBuffer(),
    stream: () => file.stream(),
    text: () => file.text(),
    slice: (start?: number, end?: number, contentType?: string) =>
      file.slice(start, end, contentType),
  } satisfies Blob & { readonly name: string };
  form.append("file", part);
}
import { PREVIEW_UPLOAD_FILENAME_ENCODING_FIELD } from "@t3tools/contracts";
