/**
 * Compress a user-selected image before upload: max 1600px on the long edge, JPEG ~0.8.
 * Typical phone photos go from 3–6 MB to 200–400 KB, keeping storage and egress cheap.
 * Re-encoding through a canvas also strips EXIF metadata (including GPS location).
 */
export async function compressImage(file: Blob, maxEdge = 1600, quality = 0.8): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
  const w = Math.round(bitmap.width * scale)
  const h = Math.round(bitmap.height * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Image processing is not supported on this device.')
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not process image.'))), 'image/jpeg', quality),
  )
}

export const ACCEPTED_IMAGE_TYPES = 'image/jpeg,image/png,image/webp,image/heic,image/heif'
