/**
 * POSIX cksum CRC (CRC-32/CKSUM): polynomial 0x04C11DB7, MSB-first, zero
 * initial value, message length appended least-significant-octet first, final
 * complement. This is the checksum Apple's mkbom records for Bom entries.
 */

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i << 24;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

export function cksumUpdate(crc: number, data: Buffer): number {
  let value = crc >>> 0;
  for (let i = 0; i < data.length; i++) {
    value = (((value << 8) >>> 0) ^ TABLE[((value >>> 24) ^ data[i]) & 0xff]) >>> 0;
  }
  return value;
}

export function cksumFinalize(crc: number, length: number): number {
  let value = crc >>> 0;
  let remaining = length;
  while (remaining > 0) {
    value = (((value << 8) >>> 0) ^ TABLE[((value >>> 24) ^ (remaining & 0xff)) & 0xff]) >>> 0;
    remaining = Math.floor(remaining / 256);
  }
  return ~value >>> 0;
}

export function cksum(data: Buffer): number {
  return cksumFinalize(cksumUpdate(0, data), data.length);
}
