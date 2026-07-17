import fs from 'node:fs';

/**
 * Determine the host architectures productbuild advertises in the
 * Distribution file by sniffing the app's main executable. Thin and fat
 * Mach-O headers are supported; anything else falls back to the default
 * productbuild uses ("x86_64,arm64", in that order).
 */

const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const MH_MAGIC = 0xfeedface;
const MH_MAGIC_64 = 0xfeedfacf;

const CPU_ARCH_ABI64 = 0x01000000;
const CPU_TYPE_X86 = 7;
const CPU_TYPE_ARM = 12;

export const DEFAULT_HOST_ARCHITECTURES = 'x86_64,arm64';

const MH_CIGAM = 0xcefaedfe;
const MH_CIGAM_64 = 0xcffaedfe;

/**
 * Per-architecture byte accounting for a file, used for the BomInfo header:
 * mkbom records, per cpu type, the summed slice sizes of every Mach-O file
 * (and everything else under cpu type 0).
 */
export function machOSliceSizes(header: Buffer, fileSize: number): Map<number, number> | null {
  if (header.length < 8) return null;
  const magicBE = header.readUInt32BE(0);
  const sizes = new Map<number, number>();
  if (magicBE === FAT_MAGIC || magicBE === FAT_MAGIC_64) {
    const is64 = magicBE === FAT_MAGIC_64;
    const count = header.readUInt32BE(4);
    const entrySize = is64 ? 32 : 20;
    if (count === 0 || count > 128 || header.length < 8 + count * entrySize) return null;
    const headerEnd = 8 + count * entrySize;
    for (let i = 0; i < count; i++) {
      const base = 8 + i * entrySize;
      const cpuType = header.readUInt32BE(base);
      const offset = is64
        ? Number(header.readBigUInt64BE(base + 8))
        : header.readUInt32BE(base + 8);
      const size = is64
        ? Number(header.readBigUInt64BE(base + 16))
        : header.readUInt32BE(base + 12);
      // Bounds-sanity: every slice must live inside the file after the fat
      // header. This rejects lookalikes such as Java .class files, which
      // share the 0xCAFEBABE magic but carry garbage where the fat_arch
      // table would be.
      if (size === 0 || offset < headerEnd || offset + size > fileSize) return null;
      sizes.set(cpuType, (sizes.get(cpuType) ?? 0) + size);
    }
    return sizes;
  }
  if (magicBE === MH_MAGIC || magicBE === MH_MAGIC_64) {
    sizes.set(header.readUInt32BE(4), fileSize);
    return sizes;
  }
  if (magicBE === MH_CIGAM || magicBE === MH_CIGAM_64) {
    // Little-endian Mach-O read big-endian: cpu type is little-endian.
    sizes.set(header.readUInt32LE(4), fileSize);
    return sizes;
  }
  return null;
}

function cpuTypeName(cpuType: number): string | null {
  switch (cpuType) {
    case CPU_TYPE_X86 | CPU_ARCH_ABI64:
      return 'x86_64';
    case CPU_TYPE_ARM | CPU_ARCH_ABI64:
      return 'arm64'; // arm64e is folded into arm64, matching productbuild
    case CPU_TYPE_X86:
      return 'i386';
    case CPU_TYPE_ARM:
      return 'arm';
    default:
      return null;
  }
}

export async function readHostArchitectures(executablePath: string): Promise<string> {
  let header: Buffer;
  try {
    const fh = await fs.promises.open(executablePath, 'r');
    try {
      header = Buffer.alloc(4096);
      const { bytesRead } = await fh.read(header, 0, header.length, 0);
      header = header.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  } catch {
    return DEFAULT_HOST_ARCHITECTURES;
  }
  if (header.length < 8) return DEFAULT_HOST_ARCHITECTURES;

  const archs = new Set<string>();
  const magicBE = header.readUInt32BE(0);

  if (magicBE === FAT_MAGIC || magicBE === FAT_MAGIC_64) {
    const is64 = magicBE === FAT_MAGIC_64;
    const count = header.readUInt32BE(4);
    const entrySize = is64 ? 32 : 20;
    if (count > 128 || header.length < 8 + count * entrySize) {
      return DEFAULT_HOST_ARCHITECTURES;
    }
    for (let i = 0; i < count; i++) {
      const name = cpuTypeName(header.readUInt32BE(8 + i * entrySize));
      if (name) archs.add(name);
    }
  } else {
    const magicLE = header.readUInt32LE(0);
    if (magicLE === MH_MAGIC || magicLE === MH_MAGIC_64) {
      const name = cpuTypeName(header.readUInt32LE(4));
      if (name) archs.add(name);
    } else if (magicBE === MH_MAGIC || magicBE === MH_MAGIC_64) {
      const name = cpuTypeName(header.readUInt32BE(4));
      if (name) archs.add(name);
    }
  }

  if (archs.size === 0) return DEFAULT_HOST_ARCHITECTURES;
  return [...archs].sort().join(',');
}
