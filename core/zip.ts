// A small ZIP reader for data exports, built on Blob.slice and DecompressionStream so only the
// central directory and the wanted entries are read. A 4 GB Google Takeout archive full of videos
// never has to fit in memory to pull out one subscriptions.csv. Stored and deflated entries,
// ZIP64 sizes and offsets. No encryption. Every size is checked before anything is read.

export interface ZipEntry {
  name: string;
  size: number;
  read: () => Promise<string>;
}

const u16 = (v: DataView, o: number) => v.getUint16(o, true);
const u32 = (v: DataView, o: number) => v.getUint32(o, true);
const u64 = (v: DataView, o: number) => Number(v.getBigUint64(o, true));

async function view(blob: Blob, start: number, end: number): Promise<DataView> {
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

/** True when the blob starts with a ZIP local file header. */
export async function isZip(blob: Blob): Promise<boolean> {
  if (blob.size < 22) return false;
  const v = await view(blob, 0, 4);
  return u32(v, 0) === 0x04034b50 || u32(v, 0) === 0x06054b50;
}

/**
 * List the entries of a ZIP blob that `want` accepts, each with a lazy reader. `maxEntryBytes`
 * caps one entry's uncompressed size; bigger entries are listed with read() rejecting.
 */
export async function listZip(blob: Blob, want: (name: string) => boolean, maxEntryBytes: number): Promise<ZipEntry[]> {
  const tailLen = Math.min(blob.size, 65557);
  const tail = await view(blob, blob.size - tailLen, blob.size);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (u32(tail, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('This ZIP file is damaged or incomplete (no directory at the end).');
  let count = u16(tail, eocd + 10);
  let cdSize = u32(tail, eocd + 12);
  let cdOffset = u32(tail, eocd + 16);
  // ZIP64: the end record points at a ZIP64 end record with the real numbers.
  if ((cdOffset === 0xffffffff || count === 0xffff || cdSize === 0xffffffff) && eocd >= 20 && u32(tail, eocd - 20) === 0x07064b50) {
    const z64 = u64(tail, eocd - 20 + 8);
    const z = await view(blob, z64, z64 + 56);
    if (u32(z, 0) !== 0x06064b50) throw new Error('This ZIP file is damaged (bad ZIP64 record).');
    count = u64(z, 32);
    cdSize = u64(z, 40);
    cdOffset = u64(z, 48);
  }
  if (cdOffset + cdSize > blob.size || cdSize > 64 * 1024 * 1024) throw new Error('This ZIP file is damaged (directory out of range).');
  const cd = await view(blob, cdOffset, cdOffset + cdSize);
  const dec = new TextDecoder();
  const out: ZipEntry[] = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.byteLength; n++) {
    if (u32(cd, p) !== 0x02014b50) break;
    const flags = u16(cd, p + 8);
    const method = u16(cd, p + 10);
    let csize = u32(cd, p + 20);
    let usize = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    let local = u32(cd, p + 42);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    // ZIP64 extra field (id 1): the 64-bit values replace the ones that are 0xffffffff, in order.
    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const id = u16(cd, e);
      const len = u16(cd, e + 2);
      if (id === 1) {
        let q = e + 4;
        if (usize === 0xffffffff && q + 8 <= e + 4 + len) (usize = u64(cd, q)), (q += 8);
        if (csize === 0xffffffff && q + 8 <= e + 4 + len) (csize = u64(cd, q)), (q += 8);
        if (local === 0xffffffff && q + 8 <= e + 4 + len) local = u64(cd, q);
      }
      e += 4 + len;
    }
    p = eEnd + commentLen;
    if (name.endsWith('/') || !want(name)) continue;
    const encrypted = (flags & 1) === 1;
    out.push({
      name,
      size: usize,
      read: async () => {
        if (encrypted) throw new Error(`${name} is encrypted; unzip it first.`);
        if (usize > maxEntryBytes) throw new Error(`${name} is too large to read (${Math.round(usize / 1e6)} MB).`);
        const lh = await view(blob, local, local + 30);
        if (u32(lh, 0) !== 0x04034b50) throw new Error(`${name}: damaged entry.`);
        const start = local + 30 + u16(lh, 26) + u16(lh, 28);
        const data = blob.slice(start, start + csize);
        if (method === 0) return dec.decode(await data.arrayBuffer());
        if (method !== 8) throw new Error(`${name} uses a compression method Aurora cannot read.`);
        // Count while inflating, so an entry that lies about its size cannot fill memory.
        const reader = data.stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
        const parts: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxEntryBytes) {
            await reader.cancel();
            throw new Error(`${name} is too large to read.`);
          }
          parts.push(value);
        }
        const all = new Uint8Array(total);
        let o = 0;
        for (const part of parts) all.set(part, (o += part.byteLength) - part.byteLength);
        return dec.decode(all);
      },
    });
  }
  return out;
}
