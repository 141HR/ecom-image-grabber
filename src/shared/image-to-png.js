/**
 * 图片 -> PNG 转换。
 * 关键点：跨域图片必须在"扩展源"（结果页 / Service Worker）里取，内容脚本取不了。
 */
(function (root) {
  'use strict';
  const EIG = (root.EIG = root.EIG || {});
  if (EIG.png) return;

  /** 解码 blob 为可绘制的图像源 */
  async function decode(blob) {
    if (typeof createImageBitmap === 'function') {
      try {
        return { kind: 'bitmap', value: await createImageBitmap(blob) };
      } catch (e) {
        // 部分格式（如带透明通道的 webp / gif）在个别环境下 createImageBitmap 会失败，回落到 <img>
      }
    }
    const objectUrl = URL.createObjectURL(blob);
    try {
      const img = await new Promise(function (resolve, reject) {
        const el = new Image();
        el.onload = function () { resolve(el); };
        el.onerror = function () { reject(new Error('图片解码失败（可能不是有效图片）')); };
        el.src = objectUrl;
      });
      return { kind: 'image', value: img, objectUrl: objectUrl };
    } catch (e) {
      URL.revokeObjectURL(objectUrl);
      throw e;
    }
  }

  /**
   * @param {Blob} blob 原图数据
   * @returns {Promise<{blob:Blob, width:number, height:number}>} PNG 数据
   */
  async function blobToPngBlob(blob) {
    if (!blob || !blob.size) throw new Error('图片数据为空');
    const decoded = await decode(blob);
    const source = decoded.value;
    const width = source.width || source.naturalWidth || 0;
    const height = source.height || source.naturalHeight || 0;
    if (!width || !height) {
      if (decoded.objectUrl) URL.revokeObjectURL(decoded.objectUrl);
      throw new Error('图片尺寸无效');
    }

    let png;
    try {
      if (typeof OffscreenCanvas === 'function') {
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(source, 0, 0);
        png = await canvas.convertToBlob({ type: 'image/png' });
      } else {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(source, 0, 0);
        png = await new Promise(function (resolve, reject) {
          canvas.toBlob(function (b) {
            if (b) resolve(b);
            else reject(new Error('PNG 编码失败'));
          }, 'image/png');
        });
      }
    } catch (e) {
      throw new Error('PNG 编码失败：' + ((e && e.message) || e));
    } finally {
      if (decoded.kind === 'bitmap' && source.close) {
        try { source.close(); } catch (e) { /* ignore */ }
      }
      if (decoded.objectUrl) URL.revokeObjectURL(decoded.objectUrl);
    }

    if (!png) throw new Error('PNG 编码失败');
    return { blob: png, width: width, height: height };
  }

  EIG.png = { blobToPngBlob: blobToPngBlob };
})(globalThis);
