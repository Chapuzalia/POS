import { UserFacingError } from '../utils/UserFacingError.ts'
export const PRODUCT_IMAGE_BUCKET = 'product-images'
export const PRODUCT_IMAGE_SIZE = 512
export const PRODUCT_IMAGE_TYPE = 'image/webp'
export const PRODUCT_IMAGE_QUALITY = 0.86
export const PRODUCT_IMAGE_DEFAULT_FILL = '#EFE4C6'

const WEBP_RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46]
const WEBP_FORMAT_SIGNATURE = [0x57, 0x45, 0x42, 0x50]

type LoadedImage = {
  close?: () => void
  height: number
  source: CanvasImageSource
  width: number
}

function isImageFile(file: File) {
  return file.type.startsWith('image/')
}

function loadImageWithElement(file: File): Promise<LoadedImage> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file)
    const image = new window.Image()

    image.onload = () => {
      URL.revokeObjectURL(objectUrl)
      resolve({
        height: image.naturalHeight,
        source: image,
        width: image.naturalWidth,
      })
    }
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('No se ha podido leer la imagen seleccionada.'))
    }
    image.src = objectUrl
  })
}

async function loadImageFile(file: File): Promise<LoadedImage> {
  if (!isImageFile(file)) {
    throw new UserFacingError('Selecciona un archivo de imagen válido.')
  }

  if ('createImageBitmap' in window) {
    try {
      const bitmap = await createImageBitmap(file)
      return {
        close: () => bitmap.close(),
        height: bitmap.height,
        source: bitmap,
        width: bitmap.width,
      }
    } catch {
      return loadImageWithElement(file)
    }
  }

  return loadImageWithElement(file)
}

function normalizeColorToHex(color: string, fallback = PRODUCT_IMAGE_DEFAULT_FILL) {
  if (typeof document === 'undefined') {
    return fallback
  }

  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')

  if (!context) {
    return fallback
  }

  context.fillStyle = fallback
  context.fillStyle = color
  return context.fillStyle.startsWith('#') ? context.fillStyle : fallback
}

export function getDefaultProductImageFillColor() {
  return PRODUCT_IMAGE_DEFAULT_FILL
}

function toWebpFileName(fileName: string) {
  const baseName = fileName.replace(/\.[^./\\]+$/, '').trim() || 'document'
  return `${baseName}.webp`
}

function getContainedImageBox(width: number, height: number) {
  const scale = Math.min(PRODUCT_IMAGE_SIZE / width, PRODUCT_IMAGE_SIZE / height)
  const drawWidth = Math.round(width * scale)
  const drawHeight = Math.round(height * scale)

  return {
    height: drawHeight,
    width: drawWidth,
    x: Math.round((PRODUCT_IMAGE_SIZE - drawWidth) / 2),
    y: Math.round((PRODUCT_IMAGE_SIZE - drawHeight) / 2),
  }
}

function tryCanvasToWebp(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob(resolve, PRODUCT_IMAGE_TYPE, PRODUCT_IMAGE_QUALITY)
    } catch {
      resolve(null)
    }
  })
}

export async function isProductImageWebp(blob: Blob) {
  if (blob.type !== PRODUCT_IMAGE_TYPE || blob.size < 12) return false

  const signature = new Uint8Array(await blob.slice(0, 12).arrayBuffer())
  return WEBP_RIFF_SIGNATURE.every((byte, index) => signature[index] === byte)
    && WEBP_FORMAT_SIGNATURE.every((byte, index) => signature[index + 8] === byte)
}

async function encodeCanvasToWebp(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D) {
  const canvasBlob = await tryCanvasToWebp(canvas)
  if (canvasBlob && await isProductImageWebp(canvasBlob)) return canvasBlob

  const { default: encodeWebp } = await import('@jsquash/webp/encode')
  const encoded = await encodeWebp(
    context.getImageData(0, 0, canvas.width, canvas.height),
    { quality: PRODUCT_IMAGE_QUALITY * 100 },
  )
  const fallbackBlob = new Blob([encoded], { type: PRODUCT_IMAGE_TYPE })

  if (!await isProductImageWebp(fallbackBlob)) {
    throw new Error('El navegador no ha podido generar la imagen WebP.')
  }

  return fallbackBlob
}

export async function convertImageFileToWebp(file: File) {
  if (!isImageFile(file)) return file

  if (await isProductImageWebp(file)) {
    return new File([file], toWebpFileName(file.name), {
      lastModified: file.lastModified,
      type: PRODUCT_IMAGE_TYPE,
    })
  }

  const image = await loadImageFile(file)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('No se ha podido preparar la imagen.')

    context.drawImage(image.source, 0, 0, image.width, image.height)
    const blob = await encodeCanvasToWebp(canvas, context)
    return new File([blob], toWebpFileName(file.name), {
      lastModified: file.lastModified,
      type: PRODUCT_IMAGE_TYPE,
    })
  } finally {
    image.close?.()
  }
}

export async function resizeProductImageToWebp(file: File, fillColor = getDefaultProductImageFillColor()) {
  const image = await loadImageFile(file)

  try {
    const canvas = document.createElement('canvas')
    canvas.width = PRODUCT_IMAGE_SIZE
    canvas.height = PRODUCT_IMAGE_SIZE

    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('No se ha podido preparar la imagen.')
    }

    const imageBox = getContainedImageBox(image.width, image.height)
    context.fillStyle = normalizeColorToHex(fillColor)
    context.fillRect(0, 0, PRODUCT_IMAGE_SIZE, PRODUCT_IMAGE_SIZE)
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(
      image.source,
      imageBox.x,
      imageBox.y,
      imageBox.width,
      imageBox.height,
    )

    return encodeCanvasToWebp(canvas, context)
  } finally {
    image.close?.()
  }
}
