const zlib = require('zlib');

// Table CRC32 standard pour la spécification PNG
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const KEYWORD = 'jdrstate';

/**
 * Injecte l'état JSON (compressé + base64) dans un chunk PNG `tEXt` standard juste avant `IEND`.
 * Permet à Render (Free Tier sans disque persistant) de restaurer automatiquement les tables
 * et les votes directement depuis la dernière image publiée sur Discord après un redémarrage !
 */
function embedStateInPng(pngBuffer, stateObj) {
  try {
    const jsonStr = JSON.stringify(stateObj);
    const compressedBase64 = zlib.deflateSync(Buffer.from(jsonStr, 'utf8')).toString('base64');
    const dataBuf = Buffer.from(`${KEYWORD}\0${compressedBase64}`, 'ascii');

    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(dataBuf.length, 0);

    const typeBuf = Buffer.from('tEXt', 'ascii');
    const crcVal = crc32(Buffer.concat([typeBuf, dataBuf]));
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crcVal, 0);

    const textChunk = Buffer.concat([lenBuf, typeBuf, dataBuf, crcBuf]);

    // Tout fichier PNG se termine par les 12 octets du chunk IEND
    const iendOffset = pngBuffer.length - 12;
    const iendType = pngBuffer.subarray(iendOffset + 4, iendOffset + 8).toString('ascii');
    if (iendType !== 'IEND') {
      return pngBuffer;
    }

    return Buffer.concat([
      pngBuffer.subarray(0, iendOffset),
      textChunk,
      pngBuffer.subarray(iendOffset)
    ]);
  } catch {
    return pngBuffer;
  }
}

/**
 * Extrait l'état JSON depuis le chunk PNG `tEXt` d'une image téléchargée sur Discord.
 */
function extractStateFromPng(pngBuffer) {
  try {
    let offset = 8; // Signature PNG (8 octets)
    while (offset + 8 <= pngBuffer.length) {
      const length = pngBuffer.readUInt32BE(offset);
      const type = pngBuffer.subarray(offset + 4, offset + 8).toString('ascii');
      const dataStart = offset + 8;
      const dataEnd = dataStart + length;
      if (dataEnd > pngBuffer.length) break;

      if (type === 'tEXt') {
        const chunkData = pngBuffer.subarray(dataStart, dataEnd).toString('ascii');
        const prefix = `${KEYWORD}\0`;
        if (chunkData.startsWith(prefix)) {
          const b64 = chunkData.slice(prefix.length);
          const jsonStr = zlib.inflateSync(Buffer.from(b64, 'base64')).toString('utf8');
          return JSON.parse(jsonStr);
        }
      }
      if (type === 'IEND') break;
      offset = dataEnd + 4; // +4 pour le CRC
    }
  } catch {
    // Ignore
  }
  return null;
}

module.exports = {
  embedStateInPng,
  extractStateFromPng
};
