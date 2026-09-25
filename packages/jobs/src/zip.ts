import { createHash } from "node:crypto";
import { type FileHandle, open } from "node:fs/promises";
import { crc32 } from "node:zlib";

/**
 * A minimal ZIP writer that streams entries straight to a file.
 *
 * Entries are stored without compression: invoice originals (PDF, PNG, JPEG)
 * are already compressed, and storing keeps memory to one entry at a time.
 * ZIP64 is not written, so an archive is limited to 4 GiB and 65,535 entries;
 * exceeding either fails the build instead of producing a corrupt file.
 */

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const VERSION = 20;
/** Bit 11: file names are UTF-8. */
const UTF8_FLAG = 0x0800;
const MAX_UINT32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;

export class ZipLimitError extends Error {}

type Entry = {
  name: Buffer;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
};

const dosDateTime = (value: Date) => {
  const year = Math.max(1980, value.getUTCFullYear());
  return {
    time:
      (value.getUTCHours() << 11) |
      (value.getUTCMinutes() << 5) |
      Math.floor(value.getUTCSeconds() / 2),
    date:
      ((year - 1980) << 9) |
      ((value.getUTCMonth() + 1) << 5) |
      value.getUTCDate(),
  };
};

export class ZipFileWriter {
  private readonly entries: Entry[] = [];
  private readonly names = new Set<string>();
  private readonly hash = createHash("sha256");
  private offset = 0;

  private constructor(private readonly handle: FileHandle) {}

  /** Creates (or truncates) the archive file, readable only by its owner. */
  static async create(path: string) {
    return new ZipFileWriter(await open(path, "w", 0o600));
  }

  private async write(chunk: Uint8Array) {
    let written = 0;
    while (written < chunk.byteLength) {
      const { bytesWritten } = await this.handle.write(
        chunk,
        written,
        chunk.byteLength - written,
      );
      written += bytesWritten;
    }
    this.hash.update(chunk);
    this.offset += chunk.byteLength;
  }

  /** Adds one stored entry. Names must be unique relative paths. */
  async addFile(name: string, data: Uint8Array, modified = new Date()) {
    if (!name || name.startsWith("/") || name.split("/").includes("..")) {
      throw new Error(`Invalid archive entry name: ${name}`);
    }
    if (this.names.has(name)) {
      throw new Error(`Duplicate archive entry name: ${name}`);
    }
    if (this.entries.length >= MAX_ENTRIES) {
      throw new ZipLimitError("The export has too many files for one archive");
    }
    const nameBytes = Buffer.from(name, "utf8");
    const header = 30 + nameBytes.byteLength;
    if (this.offset + header + data.byteLength > MAX_UINT32) {
      throw new ZipLimitError("The export is larger than 4 GiB");
    }

    const { time, date } = dosDateTime(modified);
    const entry: Entry = {
      name: nameBytes,
      crc: crc32(data) >>> 0,
      size: data.byteLength,
      offset: this.offset,
      time,
      date,
    };

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(entry.crc, 14);
    local.writeUInt32LE(entry.size, 18);
    local.writeUInt32LE(entry.size, 22);
    local.writeUInt16LE(nameBytes.byteLength, 26);
    local.writeUInt16LE(0, 28);

    await this.write(local);
    await this.write(nameBytes);
    await this.write(data);

    this.names.add(name);
    this.entries.push(entry);
  }

  /** Writes the central directory and closes the file. */
  async close() {
    try {
      const directoryOffset = this.offset;
      for (const entry of this.entries) {
        const central = Buffer.alloc(46);
        central.writeUInt32LE(CENTRAL_HEADER, 0);
        central.writeUInt16LE(VERSION, 4);
        central.writeUInt16LE(VERSION, 6);
        central.writeUInt16LE(UTF8_FLAG, 8);
        central.writeUInt16LE(0, 10);
        central.writeUInt16LE(entry.time, 12);
        central.writeUInt16LE(entry.date, 14);
        central.writeUInt32LE(entry.crc, 16);
        central.writeUInt32LE(entry.size, 20);
        central.writeUInt32LE(entry.size, 24);
        central.writeUInt16LE(entry.name.byteLength, 28);
        // Extra field, comment, disk number, attributes: all zero.
        central.writeUInt32LE(entry.offset, 42);
        await this.write(central);
        await this.write(entry.name);
      }
      const directorySize = this.offset - directoryOffset;
      if (this.offset + 22 > MAX_UINT32) {
        throw new ZipLimitError("The export is larger than 4 GiB");
      }

      const end = Buffer.alloc(22);
      end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
      end.writeUInt16LE(this.entries.length, 8);
      end.writeUInt16LE(this.entries.length, 10);
      end.writeUInt32LE(directorySize, 12);
      end.writeUInt32LE(directoryOffset, 16);
      await this.write(end);

      return {
        size: this.offset,
        sha256: this.hash.digest("hex"),
        entries: this.entries.length,
      };
    } finally {
      await this.handle.close();
    }
  }

  /** Closes the file without finishing it (the caller removes it). */
  async abort() {
    await this.handle.close().catch(() => undefined);
  }
}

/**
 * Reads a stored-only archive written by `ZipFileWriter` back into entries.
 * Used by tests and the export verifier to prove completeness.
 */
export function readStoredZip(archive: Uint8Array) {
  const buffer = Buffer.from(
    archive.buffer,
    archive.byteOffset,
    archive.byteLength,
  );
  const endOffset = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endOffset < 0) throw new Error("Not a ZIP archive");
  const count = buffer.readUInt16LE(endOffset + 10);
  let cursor = buffer.readUInt32LE(endOffset + 16);
  const entries = new Map<string, Buffer>();

  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_HEADER) {
      throw new Error("Corrupt central directory");
    }
    const crc = buffer.readUInt32LE(cursor + 16);
    const size = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(start, start + size);
    if (crc32(data) >>> 0 !== crc) {
      throw new Error(`CRC mismatch for ${name}`);
    }
    entries.set(name, data);
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}
