import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { headers: corsHeaders, status })
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (request.method !== 'POST') {
    return response({ error: 'Metodo no permitido' }, 405)
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const authorization = request.headers.get('Authorization')

    if (!supabaseUrl || !anonKey || !serviceRoleKey || !authorization) {
      return response({ error: 'Configuracion o autorizacion incompleta' }, 401)
    }

    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false },
    })
    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const { data: authData, error: authError } = await authClient.auth.getUser()

    if (authError || !authData.user) {
      return response({ error: 'Sesion no valida' }, 401)
    }

    const body = await request.json()
    const action = String(body.action ?? '')
    const tenantId = String(body.tenantId ?? '')
    const { data: callerProfile, error: callerProfileError } = await adminClient
      .from('profiles')
      .select('is_superadmin')
      .eq('id', authData.user.id)
      .maybeSingle()

    if (callerProfileError) {
      throw callerProfileError
    }

    const isSuperadmin = callerProfile?.is_superadmin === true

    if (action === 'platform-list') {
      if (!isSuperadmin) {
        return response({ error: 'Solo un superadmin puede consultar todos los negocios' }, 403)
      }

      const [tenantsResult, ownersResult, venuesResult] = await Promise.all([
        adminClient.from('tenants').select('id, name, slug, created_at').order('created_at', { ascending: false }),
        adminClient
          .from('tenant_memberships')
          .select('tenant_id, user_id, is_active')
          .eq('role', 'owner'),
        adminClient.from('venues').select('tenant_id'),
      ])

      if (tenantsResult.error || ownersResult.error || venuesResult.error) {
        throw tenantsResult.error ?? ownersResult.error ?? venuesResult.error
      }

      const ownerIds = new Set((ownersResult.data ?? []).map((membership) => membership.user_id))
      const ownerUsers = []
      let page = 1

      while (ownerIds.size) {
        const { data, error } = await adminClient.auth.admin.listUsers({ page, perPage: 1000 })
        if (error) {
          throw error
        }
        ownerUsers.push(...data.users.filter((user) => ownerIds.has(user.id)))
        if (data.users.length < 1000) {
          break
        }
        page += 1
      }

      const ownerUserById = new Map(ownerUsers.map((user) => [user.id, user]))
      const ownerByTenant = new Map(
        (ownersResult.data ?? []).map((membership) => {
          const owner = ownerUserById.get(membership.user_id)
          return [membership.tenant_id, {
            email: owner?.email ?? '',
            fullName: String(owner?.user_metadata?.full_name ?? ''),
            isActive: membership.is_active,
          }]
        }),
      )
      const venueCountByTenant = new Map<string, number>()
      for (const venue of venuesResult.data ?? []) {
        venueCountByTenant.set(venue.tenant_id, (venueCountByTenant.get(venue.tenant_id) ?? 0) + 1)
      }

      return response({
        tenants: (tenantsResult.data ?? []).map((tenant) => ({
          id: tenant.id,
          name: tenant.name,
          slug: tenant.slug,
          createdAt: tenant.created_at,
          owner: ownerByTenant.get(tenant.id) ?? null,
          venueCount: venueCountByTenant.get(tenant.id) ?? 0,
        })),
      })
    }

    if (action === 'platform-create-tenant') {
      if (!isSuperadmin) {
        return response({ error: 'Solo un superadmin puede crear negocios' }, 403)
      }

      const tenantName = String(body.tenantName ?? '').trim()
      const tenantSlug = String(body.tenantSlug ?? '').trim().toLowerCase()
      const venueName = String(body.venueName ?? '').trim()
      const ownerEmail = String(body.ownerEmail ?? '').trim().toLowerCase()
      const ownerPassword = String(body.ownerPassword ?? '')
      const ownerFullName = String(body.ownerFullName ?? '').trim()

      if (
        !tenantName || !venueName || !ownerEmail || !ownerFullName || ownerPassword.length < 8
        || !/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(tenantSlug)
      ) {
        return response({ error: 'Completa todos los campos, usa un slug valido y una contrasena de al menos 8 caracteres' }, 400)
      }

      const { data: existingTenant, error: existingTenantError } = await adminClient
        .from('tenants')
        .select('id')
        .eq('slug', tenantSlug)
        .maybeSingle()

      if (existingTenantError) {
        throw existingTenantError
      }
      if (existingTenant) {
        return response({ error: 'Ya existe un negocio con ese slug' }, 409)
      }

      const { data: createdOwner, error: ownerCreateError } = await adminClient.auth.admin.createUser({
        email: ownerEmail,
        password: ownerPassword,
        email_confirm: true,
        user_metadata: { full_name: ownerFullName },
      })

      if (ownerCreateError || !createdOwner.user) {
        return response({ error: ownerCreateError?.message ?? 'No se pudo crear el usuario owner' }, 409)
      }

      const ownerId = createdOwner.user.id
      let createdTenantId = ''

      try {
        const { data: createdTenant, error: tenantCreateError } = await adminClient
          .from('tenants')
          .insert({ name: tenantName, slug: tenantSlug })
          .select('id, name, slug, created_at')
          .single()

        if (tenantCreateError || !createdTenant) {
          throw tenantCreateError ?? new Error('No se pudo crear el negocio')
        }
        createdTenantId = createdTenant.id

        const setupResults = await Promise.all([
          adminClient.from('profiles').upsert({
            id: ownerId,
            full_name: ownerFullName,
            is_superadmin: false,
          }),
          adminClient.from('tenant_memberships').insert({
            tenant_id: createdTenant.id,
            user_id: ownerId,
            role: 'owner',
            is_active: true,
          }),
          adminClient.from('venues').insert({
            tenant_id: createdTenant.id,
            name: venueName,
            sort_order: 1,
            is_active: true,
          }),
          adminClient.from('sale_formats').insert([
            { tenant_id: createdTenant.id, key: 'cubata', label: 'Cubata', sort_order: 1, is_active: true },
            { tenant_id: createdTenant.id, key: 'copa', label: 'Copa', sort_order: 2, is_active: true },
            { tenant_id: createdTenant.id, key: 'shot', label: 'Chupito', sort_order: 3, is_active: true },
            { tenant_id: createdTenant.id, key: 'beer_bottle', label: 'Botellin cerveza', sort_order: 4, is_active: true },
            { tenant_id: createdTenant.id, key: 'soft_bottle', label: 'Botellin refresco', sort_order: 5, is_active: true },
            { tenant_id: createdTenant.id, key: 'cocktail', label: 'Coctel', sort_order: 6, is_active: true },
          ]),
        ])
        const setupError = setupResults.find((result) => result.error)?.error
        if (setupError) {
          throw setupError
        }

        return response({
          tenant: {
            id: createdTenant.id,
            name: createdTenant.name,
            slug: createdTenant.slug,
            createdAt: createdTenant.created_at,
          },
          ownerId,
        }, 201)
      } catch (setupError) {
        if (createdTenantId) {
          await adminClient.from('tenants').delete().eq('id', createdTenantId)
        }
        await adminClient.auth.admin.deleteUser(ownerId)
        throw setupError
      }
    }

    const { data: membership, error: membershipError } = await adminClient
      .from('tenant_memberships')
      .select('role, is_active')
      .eq('tenant_id', tenantId)
      .eq('user_id', authData.user.id)
      .maybeSingle()

    if (membershipError || !membership?.is_active || !['owner', 'admin'].includes(membership.role)) {
      return response({ error: 'Solo administracion puede gestionar usuarios' }, 403)
    }

    if (action === 'list') {
      const [{ data: memberships, error: membershipsError }, { data: assignments, error: assignmentsError }] =
        await Promise.all([
          adminClient
            .from('tenant_memberships')
            .select('user_id, is_active')
            .eq('tenant_id', tenantId)
            .eq('role', 'cashier'),
          adminClient
            .from('device_user_assignments')
            .select('user_id, venue_id, device_id, is_active')
            .eq('tenant_id', tenantId),
        ])

      if (membershipsError || assignmentsError) {
        throw membershipsError ?? assignmentsError
      }

      const cashierIds = new Set((memberships ?? []).map((item) => item.user_id))
      const users = []
      let page = 1

      while (true) {
        const { data, error } = await adminClient.auth.admin.listUsers({ page, perPage: 1000 })

        if (error) {
          throw error
        }

        users.push(...data.users.filter((user) => cashierIds.has(user.id)))
        if (data.users.length < 1000) {
          break
        }
        page += 1
      }

      const membershipByUser = new Map((memberships ?? []).map((item) => [item.user_id, item]))
      const assignmentByUser = new Map((assignments ?? []).map((item) => [item.user_id, item]))

      return response({
        users: users.map((user) => {
          const userMembership = membershipByUser.get(user.id)
          const assignment = assignmentByUser.get(user.id)

          return {
            id: user.id,
            email: user.email ?? '',
            fullName: String(user.user_metadata?.full_name ?? ''),
            isActive: Boolean(userMembership?.is_active && assignment?.is_active),
            venueId: assignment?.venue_id ?? '',
            deviceId: assignment?.device_id ?? '',
          }
        }),
      })
    }

    if (action === 'create') {
      const email = String(body.email ?? '').trim().toLowerCase()
      const password = String(body.password ?? '')
      const fullName = String(body.fullName ?? '').trim()
      const deviceId = String(body.deviceId ?? '')

      if (!email || password.length < 8 || !fullName || !deviceId) {
        return response({ error: 'Nombre, email, dispositivo y contrasena de al menos 8 caracteres son obligatorios' }, 400)
      }

      const { data: device, error: deviceError } = await adminClient
        .from('devices')
        .select('id, venue_id')
        .eq('tenant_id', tenantId)
        .eq('id', deviceId)
        .eq('is_active', true)
        .single()

      if (deviceError || !device) {
        return response({ error: 'El dispositivo seleccionado no existe o esta desactivado' }, 400)
      }

      const { data: occupied } = await adminClient
        .from('device_user_assignments')
        .select('user_id')
        .eq('tenant_id', tenantId)
        .eq('device_id', deviceId)
        .eq('is_active', true)
        .maybeSingle()

      if (occupied) {
        return response({ error: 'El dispositivo ya tiene un usuario activo asignado' }, 409)
      }

      const { data: created, error: createError } = await adminClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: fullName },
      })

      if (createError || !created.user) {
        throw createError ?? new Error('No se pudo crear el usuario')
      }

      const userId = created.user.id
      const { error: setupError } = await adminClient.from('tenant_memberships').insert({
        tenant_id: tenantId,
        user_id: userId,
        role: 'cashier',
        is_active: true,
      })

      if (!setupError) {
        const { error: profileError } = await adminClient.from('profiles').upsert({
          id: userId,
          full_name: fullName,
        })
        if (profileError) {
          await adminClient.auth.admin.deleteUser(userId)
          throw profileError
        }
      }

      if (!setupError) {
        const { error: assignmentError } = await adminClient.from('device_user_assignments').insert({
          tenant_id: tenantId,
          user_id: userId,
          venue_id: device.venue_id,
          device_id: device.id,
          is_active: true,
        })
        if (assignmentError) {
          await adminClient.auth.admin.deleteUser(userId)
          throw assignmentError
        }
      } else {
        await adminClient.auth.admin.deleteUser(userId)
        throw setupError
      }

      return response({ id: userId }, 201)
    }

    if (action === 'set-active') {
      const userId = String(body.userId ?? '')
      const isActive = Boolean(body.isActive)

      if (!userId || userId === authData.user.id) {
        return response({ error: 'Usuario no valido' }, 400)
      }

      if (!isActive) {
        const { data: assignment, error: assignmentError } = await adminClient
          .from('device_user_assignments')
          .select('device_id')
          .eq('tenant_id', tenantId)
          .eq('user_id', userId)
          .maybeSingle()

        if (assignmentError) {
          throw assignmentError
        }

        if (assignment) {
          const { data: openSession, error: openSessionError } = await adminClient
            .from('cash_sessions')
            .select('id')
            .eq('tenant_id', tenantId)
            .eq('device_id', assignment.device_id)
            .eq('status', 'open')
            .maybeSingle()

          if (openSessionError) {
            throw openSessionError
          }

          if (openSession) {
            return response({ error: 'Cierra la caja del dispositivo antes de desactivar su usuario' }, 409)
          }
        }
      }

      const { error: membershipUpdateError } = await adminClient
        .from('tenant_memberships')
        .update({ is_active: isActive })
        .eq('tenant_id', tenantId)
        .eq('user_id', userId)
        .eq('role', 'cashier')

      const { error: assignmentUpdateError } = await adminClient
        .from('device_user_assignments')
        .update({ is_active: isActive })
        .eq('tenant_id', tenantId)
        .eq('user_id', userId)

      if (membershipUpdateError || assignmentUpdateError) {
        if (!membershipUpdateError && assignmentUpdateError) {
          await adminClient
            .from('tenant_memberships')
            .update({ is_active: !isActive })
            .eq('tenant_id', tenantId)
            .eq('user_id', userId)
            .eq('role', 'cashier')
        }
        throw membershipUpdateError ?? assignmentUpdateError
      }

      return response({ ok: true })
    }

    return response({ error: 'Accion no valida' }, 400)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error interno'
    return response({ error: message }, 500)
  }
})
