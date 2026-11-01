// Files API over exec. Paths are confined to the sandbox root (/sandbox): normalized here (any `..` rejected),
// then resolved with `realpath -m` inside the computer and re-checked, so symlinks cannot escape.
// Every script takes its inputs as positional arguments, never interpolated into the script text.

export class PathError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function normalizePath(root: string, p: string | null): string {
  if (!p) throw new PathError(400, "path is required");
  if (p.includes("\0") || p.includes("\n") || p.includes("\r")) throw new PathError(400, "invalid characters in path");
  if (!p.startsWith("/")) throw new PathError(400, "path must be absolute");
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") throw new PathError(400, "'..' is not allowed in paths");
    parts.push(seg);
  }
  const out = "/" + parts.join("/");
  if (out !== root && !out.startsWith(root + "/")) throw new PathError(403, `path must be under ${root}`);
  if (out.length > 4096) throw new PathError(400, "path too long");
  return out;
}

// $0 = mode (stat | auto), $1 = path, $2 = range start, $3 = range count, $4 = suffix length, $5 = root.
// Output: "<type>\t<size>\t<mtime>\t<mode>\n", then for directories "L\n" + NUL-separated entries
// "<type>\t<size>\t<mtime>\t<mode>\t<name>", for files "R\t<start>\t<count>\n" + the bytes.
export const GET_SCRIPT = `
p=$(realpath -m -- "$1") || exit 64
case "$p" in "$5"|"$5"/*) ;; *) exit 65;; esac
h=$(find "$p" -maxdepth 0 -printf '%y\\t%s\\t%T@\\t%m' 2>/dev/null) || exit 66
[ -n "$h" ] || exit 66
printf '%s\\n' "$h"
[ "$0" = stat ] && exit 0
t=\${h%%\t*}
if [ "$t" = d ]; then
  printf 'L\\n'
  find "$p" -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%m\\t%f\\0' 2>/dev/null
  exit 0
fi
[ "$t" = f ] || exit 0
size=$(printf '%s' "$h" | cut -f2)
start=$2; count=$3
if [ -n "$4" ]; then
  if [ "$4" -ge "$size" ]; then start=0; else start=$((size - $4)); fi
  count=$((size - start))
fi
[ -n "$start" ] || start=0
if [ "$size" -eq 0 ] && [ "$start" -eq 0 ]; then printf 'R\\t0\\t0\\n'; exit 0; fi
[ "$start" -lt "$size" ] || exit 67
max=$((size - start))
if [ -z "$count" ] || [ "$count" -gt "$max" ]; then count=$max; fi
printf 'R\\t%s\\t%s\\n' "$start" "$count"
exec dd if="$p" bs=65536 iflag=skip_bytes,count_bytes skip="$start" count="$count" status=none
`;

// $0 = file | dir, $1 = path, $2 = root, $3 = expected byte count ("" = unknown). Prints the final size.
export const PUT_SCRIPT = `
p=$(realpath -m -- "$1") || exit 64
case "$p" in "$2"/*) ;; *) exit 65;; esac
if [ "$0" = dir ]; then mkdir -p -- "$p" || exit 68; printf '0\\n'; exit 0; fi
d=$(dirname -- "$p")
mkdir -p -- "$d" || exit 68
[ -d "$p" ] && exit 69
t="$d/.baskule-put-$$"
cat > "$t" || { rm -f -- "$t"; exit 70; }
n=$(stat -c %s -- "$t")
if [ -n "$3" ] && [ "$n" != "$3" ]; then rm -f -- "$t"; exit 71; fi
mv -f -- "$t" "$p" || { rm -f -- "$t"; exit 70; }
printf '%s\\n' "$n"
`;

export const EXIT_STATUS: Record<number, [number, string]> = {
  64: [400, "invalid path"],
  65: [403, "path resolves outside the sandbox root"],
  66: [404, "no such file or directory"],
  67: [416, "range not satisfiable"],
  68: [409, "cannot create the parent directory"],
  69: [409, "path is a directory"],
  70: [500, "write failed"],
  71: [400, "body shorter than Content-Length (upload interrupted)"],
};

export const TYPES: Record<string, string> = { f: "file", d: "dir", l: "symlink" };

export interface StatInfo {
  type: string;
  size: number;
  mtime: string;
  mode: string;
}

export function parseStat(line: string): StatInfo {
  const [y, size, mtime, mode] = line.split("\t");
  return {
    type: TYPES[y] ?? "other",
    size: Number(size),
    mtime: new Date(Math.round(Number(mtime) * 1000)).toISOString(),
    mode: mode ?? "",
  };
}

export function parseEntries(buf: Buffer): (StatInfo & { name: string })[] {
  const out: (StatInfo & { name: string })[] = [];
  for (const rec of buf.toString("utf8").split("\0")) {
    if (!rec) continue;
    const i = rec.split("\t", 4).join("\t").length;
    const name = rec.slice(i + 1);
    out.push({ name, ...parseStat(rec.slice(0, i)) });
  }
  out.sort((a, b) => (a.type === "dir" ? 0 : 1) - (b.type === "dir" ? 0 : 1) || a.name.localeCompare(b.name));
  return out;
}

/** Parse a single `Range: bytes=...` header. null = no (usable) range; "invalid" = 416. */
export function parseRange(h: string | undefined): { start?: number; end?: number; suffix?: number } | null | "invalid" {
  if (!h) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m) return h.includes(",") ? null : "invalid";
  if (m[1] === "" && m[2] === "") return "invalid";
  if (m[1] === "") return { suffix: Number(m[2]) };
  const start = Number(m[1]);
  if (m[2] === "") return { start };
  const end = Number(m[2]);
  if (end < start) return "invalid";
  return { start, end };
}
