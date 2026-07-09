import zlib from 'node:zlib';

export interface GzipOptions {
  /** zlib compression level (default 6, matching Apple's tools). */
  level?: number;
  /**
   * 'parallel' (default): split the input into chunks compressed concurrently
   * on the libuv threadpool as raw deflate segments terminated with a sync
   * flush, then stitch them into a single standard gzip member (the same
   * technique pigz uses). Output is a plain single-member gzip stream that
   * every decoder — including macOS Installer's payload extractor, which
   * rejects multi-member streams — accepts.
   * 'single': one sequential deflate stream; slower, marginally better
   * compression (the dictionary survives across chunk boundaries).
   */
  strategy?: 'parallel' | 'single';
  /** Bytes per compression chunk in parallel mode. */
  chunkSize?: number;
  /** Maximum concurrent compression jobs in parallel mode. */
  concurrency?: number;
}

const DEFAULT_CHUNK_SIZE = 2 * 1024 * 1024;

function deflateRawChunk(chunk: Buffer, level: number): Promise<Buffer> {
  // finishFlush: Z_SYNC_FLUSH ends the segment byte-aligned with an empty
  // stored block and *without* a BFINAL marker, so segments concatenate into
  // one valid deflate stream.
  return new Promise((resolve, reject) => {
    zlib.deflateRaw(chunk, { level, finishFlush: zlib.constants.Z_SYNC_FLUSH }, (err, out) =>
      err ? reject(err) : resolve(out),
    );
  });
}

const GZIP_HEADER = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03]);
/** An empty final deflate block (BFINAL=1, static Huffman, end-of-block). */
const FINAL_BLOCK = Buffer.from([0x03, 0x00]);

/**
 * Compress an async stream of buffers to a single-member gzip stream.
 * Returns the ordered list of compressed buffers. In parallel mode,
 * compression of earlier chunks overlaps with production (file reads) of
 * later ones.
 */
export async function gzipStream(
  source: AsyncIterable<Buffer>,
  opts: GzipOptions = {},
): Promise<Buffer[]> {
  const level = opts.level ?? 6;
  const strategy = opts.strategy ?? 'parallel';

  if (strategy === 'single') {
    const gz = zlib.createGzip({ level });
    const out: Buffer[] = [];
    gz.on('data', (d: Buffer) => out.push(d));
    const done = new Promise<void>((resolve, reject) => {
      gz.on('end', resolve);
      gz.on('error', reject);
    });
    for await (const chunk of source) {
      if (!gz.write(chunk)) {
        await new Promise<void>((resolve) => gz.once('drain', resolve));
      }
    }
    gz.end();
    await done;
    return out;
  }

  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const concurrency = opts.concurrency ?? 8;

  const jobs: Promise<Buffer>[] = [];
  let pending: Buffer[] = [];
  let pendingSize = 0;
  let crc = 0;
  let totalSize = 0;
  let inFlight = 0;
  let release: (() => void) | null = null;

  const flush = async () => {
    if (pendingSize === 0) return;
    const segment = pending.length === 1 ? pending[0] : Buffer.concat(pending);
    pending = [];
    pendingSize = 0;
    crc = zlib.crc32(segment, crc) >>> 0;
    totalSize += segment.length;
    while (inFlight >= concurrency) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    inFlight++;
    const job = deflateRawChunk(segment, level).finally(() => {
      inFlight--;
      if (release) {
        const r = release;
        release = null;
        r();
      }
    });
    // A rejection must not become an unhandled rejection while the (possibly
    // long) read loop is still producing; Promise.all below still observes
    // the original promise.
    job.catch(() => {});
    jobs.push(job);
  };

  for await (const chunk of source) {
    let offset = 0;
    while (offset < chunk.length) {
      const take = Math.min(chunk.length - offset, chunkSize - pendingSize);
      pending.push(chunk.subarray(offset, offset + take));
      pendingSize += take;
      offset += take;
      if (pendingSize >= chunkSize) {
        await flush();
      }
    }
  }
  await flush();

  const segments = await Promise.all(jobs);
  const trailer = Buffer.alloc(10);
  FINAL_BLOCK.copy(trailer, 0);
  trailer.writeUInt32LE(crc >>> 0, 2);
  trailer.writeUInt32LE(totalSize >>> 0, 6); // ISIZE is mod 2^32 per the spec
  return [GZIP_HEADER, ...segments, trailer];
}
