export const PRODUCT_IMAGE_BUCKET = 'product-images'
export const PRODUCT_IMAGE_SIZE = 512
export const PRODUCT_IMAGE_TYPE = 'image/webp'
export const PRODUCT_IMAGE_QUALITY = 0.86
export const PRODUCT_IMAGE_DEFAULT_FILL = '#EFE4C6'

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

async function loadProductImage(file: File): Promise<LoadedImage> {
  if (!isImageFile(file)) {
    throw new Error('Selecciona un archivo de imagen valido.')
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

function canvasToWebp(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob)
          return
        }

        reject(new Error('El navegador no ha podido generar la imagen WebP.'))
      },
      PRODUCT_IMAGE_TYPE,
      PRODUCT_IMAGE_QUALITY,
    )
  })
}

export async function resizeProductImageToWebp(file: File, fillColor = getDefaultProductImageFillColor()) {
  const image = await loadProductImage(file)

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

    return canvasToWebp(canvas)
  } finally {
    image.close?.()
  }
}
