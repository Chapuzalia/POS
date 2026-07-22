import { createClient } from '@supabase/supabase-js'

export class SupabaseCatalogRepository {
  constructor({ url, key, archive }) {
    if (!url || !key) throw new Error('Faltan URL o clave de Supabase')
    this.client = createClient(url.replace(/\/rest\/v1\/?$/, '').replace(/\/$/, ''), key, { auth: { persistSession: false, autoRefreshToken: false } })
    this.archive = archive
  }
  async countCatalog(venueId) {
    const tables = ['products', 'categories', 'catalog_tabs', 'selection_groups', 'modifier_groups']
    const counts = await Promise.all(tables.map(async (table) => {
      const { count, error } = await this.client.from(table).select('*', { count: 'exact', head: true }).eq('venue_id', venueId)
      if (error && !['42703', '42P01'].includes(error.code)) throw error
      return count ?? 0
    }))
    return counts.reduce((sum, count) => sum + count, 0)
  }
  async importCatalog(plan, { mode }) {
    const uploaded = []
    plan.imagePaths = Object.fromEntries(plan.document.catalog.images.filter((item) => !item.missing).map((item) => [item.ref, `${plan.venueId}/products/${plan.generatedIds.images[item.ref]}.${item.file.split('.').pop().toLowerCase()}`]))
    try {
      for (const image of plan.document.catalog.images.filter((item) => !item.missing)) {
        const path = plan.imagePaths[image.ref]
        const { error } = await this.client.storage.from('product-images').upload(path, this.archive.files[image.file], { contentType: image.mimeType, upsert: false })
        if (error) throw new Error(`No se pudo preparar ${image.ref}: ${error.message}`)
        uploaded.push(path)
      }
      const { data, error } = await this.client.rpc('import_catalog', { p_venue_id: plan.venueId, p_mode: mode, p_plan: plan })
      if (error) throw new Error(`La transacción de catálogo falló: ${error.message}`)
      if (data?.removedImagePaths?.length) await this.client.storage.from('product-images').remove(data.removedImagePaths)
      return data
    } catch (error) {
      if (uploaded.length) await this.client.storage.from('product-images').remove(uploaded)
      throw error
    }
  }
}
