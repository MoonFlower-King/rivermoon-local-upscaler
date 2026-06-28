import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const [, , url, target, totalArg, chunkArg = "268435456", concurrencyArg = "6"] = process.argv;

if (!url || !target || !totalArg) {
  console.error("Usage: node scripts/range-download.mjs <url> <target> <totalBytes> [chunkBytes] [concurrency]");
  process.exit(1);
}

const totalBytes = Number(totalArg);
const chunkBytes = Number(chunkArg);
const concurrency = Number(concurrencyArg);
const targetPath = path.resolve(target);
const partsDir = `${targetPath}.parts`;

await fsp.mkdir(path.dirname(targetPath), { recursive: true });
await fsp.mkdir(partsDir, { recursive: true });

let existingPrefix = 0;
try {
  existingPrefix = (await fsp.stat(targetPath)).size;
} catch {
  existingPrefix = 0;
}

const ranges = [];
for (let start = existingPrefix; start < totalBytes; start += chunkBytes) {
  const end = Math.min(totalBytes - 1, start + chunkBytes - 1);
  ranges.push({ start, end, file: path.join(partsDir, `${start}-${end}.part`) });
}

console.log(`target=${targetPath}`);
console.log(`existing=${existingPrefix} total=${totalBytes} chunks=${ranges.length} concurrency=${concurrency}`);

let cursor = 0;
let done = 0;
let downloaded = 0;

async function worker(id) {
  while (cursor < ranges.length) {
    const range = ranges[cursor++];
    const expectedSize = range.end - range.start + 1;
    try {
      const stat = await fsp.stat(range.file);
      if (stat.size === expectedSize) {
        done += 1;
        downloaded += stat.size;
        console.log(`worker=${id} reuse ${range.start}-${range.end} done=${done}/${ranges.length}`);
        continue;
      }
    } catch {
      // Need download.
    }

    console.log(`worker=${id} download ${range.start}-${range.end}`);
    const response = await fetch(url, {
      headers: { Range: `bytes=${range.start}-${range.end}` }
    });
    if (response.status !== 206 && response.status !== 200) {
      throw new Error(`HTTP ${response.status} for ${range.start}-${range.end}`);
    }
    if (!response.body) throw new Error(`Empty body for ${range.start}-${range.end}`);
    const tempFile = `${range.file}.tmp-${process.pid}-${id}`;
    await pipeline(response.body, fs.createWriteStream(tempFile));
    const size = (await fsp.stat(tempFile)).size;
    if (size !== expectedSize) {
      await fsp.rm(tempFile, { force: true });
      throw new Error(`Bad chunk size for ${range.start}-${range.end}: ${size}, expected ${expectedSize}`);
    }
    await fsp.rename(tempFile, range.file);
    done += 1;
    downloaded += size;
    console.log(`worker=${id} done ${range.start}-${range.end} done=${done}/${ranges.length} downloaded=${downloaded}`);
  }
}

await Promise.all(Array.from({ length: Math.max(1, concurrency) }, (_, index) => worker(index + 1)));

const tempTarget = `${targetPath}.complete-${process.pid}`;
const out = fs.createWriteStream(tempTarget);
if (existingPrefix > 0) {
  await pipeline(fs.createReadStream(targetPath, { start: 0, end: existingPrefix - 1 }), out, { end: false });
}
for (const range of ranges) {
  await pipeline(fs.createReadStream(range.file), out, { end: false });
}
await new Promise((resolve, reject) => {
  out.end((error) => (error ? reject(error) : resolve()));
});

const finalSize = (await fsp.stat(tempTarget)).size;
if (finalSize !== totalBytes) {
  throw new Error(`Final size mismatch: ${finalSize}, expected ${totalBytes}`);
}
await fsp.rename(tempTarget, targetPath);
await fsp.rm(partsDir, { recursive: true, force: true });
console.log(`complete ${targetPath} ${finalSize}`);
