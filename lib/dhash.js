/**
 * dHash custom — Node.js (sem lib externa, ~30 linhas RT-06 HJXXIII v1.3)
 * Diferença hash perceptual para tolerância a re-encoding EXIF/WhatsApp.
 *
 * Versão Node.js: opera sobre Buffer de pixels RGBA 9×8 (72 pixels, 288 bytes).
 * Compatível com a implementação browser que usa Canvas.
 */

/**
 * Computa dHash a partir de um Buffer de pixels RGBA 9×8 (saída de Canvas ou sharp).
 * @param {Buffer} pixelBuf - Buffer RGBA, 9*8*4 = 288 bytes
 * @returns {string} - 16-char hex (64 bits)
 */
function dhashFromPixels(pixelBuf) {
  const W = 9, H = 8;
  // Grayscale luminance por pixel (BT.601)
  const gray = new Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const r = pixelBuf[i * 4];
    const g = pixelBuf[i * 4 + 1];
    const b = pixelBuf[i * 4 + 2];
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  // Difference hash: compara cada pixel com o vizinho à direita em cada linha
  // 8 linhas × 8 comparações = 64 bits
  let bits = 0n;
  for (let row = 0; row < H; row++) {
    for (let col = 0; col < W - 1; col++) {
      bits = (bits << 1n) | (gray[row * W + col] > gray[row * W + col + 1] ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, '0');
}

/**
 * Hamming distance entre dois hashes hex de 16 chars (64 bits).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function hammingDistance(a, b) {
  let x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let count = 0n;
  while (x) {
    count += x & 1n;
    x >>= 1n;
  }
  return Number(count);
}

module.exports = { dhashFromPixels, hammingDistance };
