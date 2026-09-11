/**
 * PE(Windows exe) **Authenticode 서명 테이블** 읽기 · 걷어내기 — Windows SDK(`signtool remove /s`) 없이 JS 로.
 *
 * 2026-09-11 (C-30): `scripts/build-server.mjs` 는 `node.exe` 사본에 postject 로 SEA blob 을 주입한다. 그런데
 * node.exe 는 서명돼 있고, 주입 · rcedit 이 파일을 고친 뒤에도 **서명 테이블은 그대로 남아** 배포 exe 에 깨진
 * 서명이 붙어 있었다(`release/SCAVANGER/SCAVANGER-Server.exe`: offset 89,920,000 에 15,872 B, 그 뒤에 236 KB).
 * postject 도 `The signature seems corrupted!` 경고를 냈다. 깨진 서명은 서명이 없는 것보다 나쁘다 — 백신 ·
 * SmartScreen 이 "변조된 서명 파일" 로 본다. 그래서 주입 **전에** 사본의 서명을 걷어내 깨끗한 무서명 exe 로 만든다.
 *
 * 방법(PE/COFF 규격): Optional Header 의 DataDirectory[4] = Certificate Table 이고, 이 항목의 VirtualAddress 는
 * 예외적으로 RVA 가 아니라 **파일 오프셋**이다. 그 두 필드(주소 · 크기)를 0 으로 쓰고, 테이블이 파일 끝에 있으면
 * 그 자리에서 파일을 자른다. CheckSum 은 사용자 모드 exe 에서 검사되지 않으므로 0(= 없음)으로 둔다.
 */
import { closeSync, fstatSync, ftruncateSync, openSync, readSync, writeSync } from 'node:fs';

const DATA_DIR_SECURITY = 4;

/** Read `len` bytes at `pos`. */
function readAt(fd, pos, len) {
  const buf = Buffer.alloc(len);
  const n = readSync(fd, buf, 0, len, pos);
  if (n !== len) throw new Error(`PE: short read at ${pos} (${n}/${len})`);
  return buf;
}

/** Field offsets of the security directory for an open PE file. Throws for anything that is not a PE32/PE32+ image. */
function locate(fd) {
  const dos = readAt(fd, 0, 0x40);
  if (dos.readUInt16LE(0) !== 0x5a4d) throw new Error('PE: no MZ header');
  const peOff = dos.readUInt32LE(0x3c);
  const nt = readAt(fd, peOff, 24 + 2);
  if (nt.readUInt32LE(0) !== 0x00004550) throw new Error('PE: no PE signature');
  const opt = peOff + 24;
  const magic = nt.readUInt16LE(24);
  const plus = magic === 0x20b;
  if (!plus && magic !== 0x10b) throw new Error(`PE: unknown optional header magic 0x${magic.toString(16)}`);
  const numRva = readAt(fd, opt + (plus ? 108 : 92), 4).readUInt32LE(0);
  if (numRva <= DATA_DIR_SECURITY) return { checksumAt: opt + 64, dirAt: -1 };
  return { checksumAt: opt + 64, dirAt: opt + (plus ? 112 : 96) + DATA_DIR_SECURITY * 8 };
}

/** `{ offset, size }` of the certificate table (both 0 when the exe is unsigned). */
export function securityDirectory(path) {
  const fd = openSync(path, 'r');
  try {
    const { dirAt } = locate(fd);
    if (dirAt < 0) return { offset: 0, size: 0 };
    const d = readAt(fd, dirAt, 8);
    return { offset: d.readUInt32LE(0), size: d.readUInt32LE(4) };
  } finally {
    closeSync(fd);
  }
}

/**
 * Remove the Authenticode signature in place. Returns what was done:
 * `{ removed: false }` for an unsigned file, else `{ removed: true, bytes, truncated }` — `truncated` is false when
 * the table was not at the end of the file (the bytes are then left as dead data; the directory is still cleared).
 */
export function stripSignature(path) {
  const fd = openSync(path, 'r+');
  try {
    const { dirAt, checksumAt } = locate(fd);
    if (dirAt < 0) return { removed: false };
    const d = readAt(fd, dirAt, 8);
    const offset = d.readUInt32LE(0);
    const size = d.readUInt32LE(4);
    if (offset === 0 && size === 0) return { removed: false };
    const fileSize = fstatSync(fd).size;
    writeSync(fd, Buffer.alloc(8), 0, 8, dirAt);          // DataDirectory[4] = { 0, 0 }
    writeSync(fd, Buffer.alloc(4), 0, 4, checksumAt);     // CheckSum = 0 (not verified for user-mode images)
    // Certificate entries are 8-byte aligned, so up to 7 bytes of padding may follow the declared size.
    const atEnd = offset > 0 && offset + size <= fileSize && fileSize - (offset + size) < 8;
    if (atEnd) ftruncateSync(fd, offset);
    return { removed: true, bytes: size, truncated: atEnd };
  } finally {
    closeSync(fd);
  }
}
