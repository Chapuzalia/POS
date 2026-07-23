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

function randomIndex(max: number) {
  const value = new Uint32Array(1)
  crypto.getRandomValues(value)
  return value[0] % max
}

function generateLoginPassword() {
  const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const lowercase = 'abcdefghijklmnopqrstuvwxyz'
  const digits = '0123456789'
  const allCharacters = `${uppercase}${lowercase}${digits}`
  const password = [
    uppercase[randomIndex(uppercase.length)],
    lowercase[randomIndex(lowercase.length)],
    digits[randomIndex(digits.length)],
    ...Array.from({ length: 9 }, () => allCharacters[randomIndex(allCharacters.length)]),
  ]

  for (let index = password.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index + 1)
    const current = password[index]
    password[index] = password[swapIndex]
    password[swapIndex] = current
  }
  return password.join('')
}

function normalizeEmailPart(value: string, separator: '' | '-' = '') {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, separator)
    .replace(/^-+|-+$/g, '')
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

      const [tenantsResult, ownersResult, venuesResult, devicesResult] = await Promise.all([
        adminClient.from('tenants').select('id, name, slug, is_active, max_venues, max_devices, created_at').order('created_at', { ascending: false }),
        adminClient
          .from('tenant_memberships')
          .select('tenant_id, user_id, role, is_active'),
        adminClient.from('venues').select('id, tenant_id, name, is_active').order('sort_order'),
        adminClient.from('devices').select('tenant_id, is_active'),
      ])

      if (tenantsResult.error || ownersResult.error || venuesResult.error || devicesResult.error) {
        throw tenantsResult.error ?? ownersResult.error ?? venuesResult.error ?? devicesResult.error
      }

      const ownerMemberships = (ownersResult.data ?? []).filter((membership) => membership.role === 'owner')
      const ownerIds = new Set(ownerMemberships.map((membership) => membership.user_id))
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
        ownerMemberships.map((membership) => {
          const owner = ownerUserById.get(membership.user_id)
          return [membership.tenant_id, {
            email: owner?.email ?? '',
            fullName: String(owner?.user_metadata?.full_name ?? ''),
            isActive: membership.is_active,
          }]
        }),
      )
      const venueCountByTenant = new Map<string, number>()
      const venuesByTenant = new Map<string, Array<{ id: string; isActive: boolean; name: string }>>()
      for (const venue of venuesResult.data ?? []) {
        venueCountByTenant.set(venue.tenant_id, (venueCountByTenant.get(venue.tenant_id) ?? 0) + 1)
        const tenantVenues = venuesByTenant.get(venue.tenant_id) ?? []
        tenantVenues.push({ id: venue.id, isActive: venue.is_active, name: venue.name })
        venuesByTenant.set(venue.tenant_id, tenantVenues)
      }
      const memberCountByTenant = new Map<string, number>()
      for (const membership of ownersResult.data ?? []) {
        memberCountByTenant.set(membership.tenant_id, (memberCountByTenant.get(membership.tenant_id) ?? 0) + 1)
      }
      const deviceCountByTenant = new Map<string, number>()
      for (const device of devicesResult.data ?? []) {
        if (!device.is_active) continue
        deviceCountByTenant.set(device.tenant_id, (deviceCountByTenant.get(device.tenant_id) ?? 0) + 1)
      }

      return response({
        tenants: (tenantsResult.data ?? []).map((tenant) => ({
          id: tenant.id,
          name: tenant.name,
          slug: tenant.slug,
          isActive: tenant.is_active,
          deviceCount: deviceCountByTenant.get(tenant.id) ?? 0,
          createdAt: tenant.created_at,
          owner: ownerByTenant.get(tenant.id) ?? null,
          memberCount: memberCountByTenant.get(tenant.id) ?? 0,
          venueCount: venueCountByTenant.get(tenant.id) ?? 0,
          venues: venuesByTenant.get(tenant.id) ?? [],
          limits: {
            devices: tenant.max_devices,
            venues: tenant.max_venues,
          },
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
      const maxVenues = Number(body.maxVenues ?? 1)
      const maxDevices = Number(body.maxDevices ?? 5)

      if (
        !tenantName || !venueName || !ownerEmail || !ownerFullName || ownerPassword.length < 8
        || !/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(tenantSlug)
        || !Number.isInteger(maxVenues) || maxVenues < 1
        || !Number.isInteger(maxDevices) || maxDevices < 0
      ) {
        return response({ error: 'Completa todos los campos, usa un slug válido, una contraseña de al menos 8 caracteres y límites de plan válidos' }, 400)
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
          .insert({
            name: tenantName,
            slug: tenantSlug,
            max_venues: maxVenues,
            max_devices: maxDevices,
          })
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

    if (action === 'platform-update-tenant') {
      if (!isSuperadmin) {
        return response({ error: 'Solo un superadmin puede editar negocios' }, 403)
      }

      const targetTenantId = String(body.tenantId ?? '')
      const tenantName = String(body.tenantName ?? '').trim()
      const tenantSlug = String(body.tenantSlug ?? '').trim().toLowerCase()
      const maxVenues = Number(body.maxVenues)
      const maxDevices = Number(body.maxDevices)
      if (
        !targetTenantId || !tenantName || !/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(tenantSlug)
        || !Number.isInteger(maxVenues) || maxVenues < 1
        || !Number.isInteger(maxDevices) || maxDevices < 0
      ) {
        return response({ error: 'Nombre, slug o límites del plan no válidos' }, 400)
      }

      const [venueUsage, deviceUsage] = await Promise.all([
        adminClient.from('venues').select('id', { count: 'exact', head: true }).eq('tenant_id', targetTenantId),
        adminClient.from('devices').select('id', { count: 'exact', head: true }).eq('tenant_id', targetTenantId).eq('is_active', true),
      ])
      const usageError = venueUsage.error ?? deviceUsage.error
      if (usageError) throw usageError
      if (maxVenues < (venueUsage.count ?? 0) || maxDevices < (deviceUsage.count ?? 0)) {
        return response({ error: 'Los límites no pueden ser inferiores al uso actual del negocio' }, 400)
      }

      const { data: conflictingTenant, error: conflictError } = await adminClient
        .from('tenants')
        .select('id')
        .eq('slug', tenantSlug)
        .neq('id', targetTenantId)
        .maybeSingle()
      if (conflictError) throw conflictError
      if (conflictingTenant) {
        return response({ error: 'Ya existe un negocio con ese slug' }, 409)
      }

      const { data: updatedTenant, error: updateError } = await adminClient
        .from('tenants')
        .update({
          name: tenantName,
          slug: tenantSlug,
          max_venues: maxVenues,
          max_devices: maxDevices,
        })
        .eq('id', targetTenantId)
        .select('id, name, slug')
        .maybeSingle()
      if (updateError) throw updateError
      if (!updatedTenant) return response({ error: 'Negocio no encontrado' }, 404)
      return response({ tenant: updatedTenant })
    }

    if (action === 'platform-set-tenant-active') {
      if (!isSuperadmin) {
        return response({ error: 'Solo un superadmin puede cambiar el estado de un negocio' }, 403)
      }

      const targetTenantId = String(body.tenantId ?? '')
      const isActive = body.isActive === true
      if (!targetTenantId) return response({ error: 'Negocio no valido' }, 400)

      const { data: updatedTenant, error: updateError } = await adminClient
        .from('tenants')
        .update({ is_active: isActive })
        .eq('id', targetTenantId)
        .select('id')
        .maybeSingle()
      if (updateError) throw updateError
      if (!updatedTenant) return response({ error: 'Negocio no encontrado' }, 404)
      return response({ ok: true })
    }

    if (action === 'platform-delete-tenant') {
      if (!isSuperadmin) {
        return response({ error: 'Solo un superadmin puede eliminar negocios' }, 403)
      }

      const targetTenantId = String(body.tenantId ?? '')
      if (!targetTenantId) return response({ error: 'Negocio no valido' }, 400)

      const [{ data: targetTenant, error: tenantLookupError }, { data: tenantMembers, error: membersError }] = await Promise.all([
        adminClient.from('tenants').select('id').eq('id', targetTenantId).maybeSingle(),
        adminClient.from('tenant_memberships').select('user_id').eq('tenant_id', targetTenantId),
      ])
      if (tenantLookupError || membersError) throw tenantLookupError ?? membersError
      if (!targetTenant) return response({ error: 'Negocio no encontrado' }, 404)

      const { error: deleteError } = await adminClient.from('tenants').delete().eq('id', targetTenantId)
      if (deleteError) throw deleteError

      for (const member of tenantMembers ?? []) {
        const [{ data: remainingMembership }, { data: memberProfile }] = await Promise.all([
          adminClient.from('tenant_memberships').select('id').eq('user_id', member.user_id).limit(1).maybeSingle(),
          adminClient.from('profiles').select('is_superadmin').eq('id', member.user_id).maybeSingle(),
        ])
        if (!remainingMembership && memberProfile?.is_superadmin !== true) {
          await adminClient.auth.admin.deleteUser(member.user_id, true)
        }
      }

      return response({ ok: true })
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

    if (action === 'tenant-plan') {
      const [tenantResult, venueUsage, deviceUsage] = await Promise.all([
        adminClient
          .from('tenants')
          .select('max_venues, max_devices')
          .eq('id', tenantId)
          .maybeSingle(),
        adminClient.from('venues').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId),
        adminClient.from('devices').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('is_active', true),
      ])
      const planError = tenantResult.error ?? venueUsage.error ?? deviceUsage.error
      if (planError) throw planError
      if (!tenantResult.data) return response({ error: 'Negocio no encontrado' }, 404)

      return response({
        limits: {
          devices: tenantResult.data.max_devices,
          venues: tenantResult.data.max_venues,
        },
        usage: {
          devices: deviceUsage.count ?? 0,
          venues: venueUsage.count ?? 0,
        },
      })
    }

    if (action === 'release-login') {
      if (membership.role !== 'owner') {
        return response({ error: 'Solo el owner puede liberar sesiones de usuario' }, 403)
      }

      const userId = String(body.userId ?? '')
      if (!userId || userId === authData.user.id) {
        return response({ error: 'Usuario no valido' }, 400)
      }

      const { data: targetMembership, error: targetMembershipError } = await adminClient
        .from('tenant_memberships')
        .select('user_id')
        .eq('tenant_id', tenantId)
        .eq('user_id', userId)
        .eq('role', 'cashier')
        .maybeSingle()

      if (targetMembershipError) {
        throw targetMembershipError
      }
      if (!targetMembership) {
        return response({ error: 'El usuario no pertenece a este negocio' }, 404)
      }

      const { error: releaseError } = await adminClient
        .from('user_login_leases')
        .delete()
        .eq('user_id', userId)

      if (releaseError) {
        throw releaseError
      }

      return response({ ok: true })
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
      const { data: leases, error: leasesError } = cashierIds.size
        ? await adminClient
          .from('user_login_leases')
          .select('user_id, heartbeat_at, expires_at')
          .in('user_id', [...cashierIds])
        : { data: [], error: null }

      if (leasesError) {
        throw leasesError
      }

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
      const leaseByUser = new Map((leases ?? []).map((item) => [item.user_id, item]))
      const now = Date.now()

      return response({
        users: users.map((user) => {
          const userMembership = membershipByUser.get(user.id)
          const assignment = assignmentByUser.get(user.id)
          const lease = leaseByUser.get(user.id)
          const hasActiveLogin = Boolean(lease && new Date(lease.expires_at).getTime() > now)

          return {
            id: user.id,
            email: user.email ?? '',
            fullName: String(user.user_metadata?.full_name ?? ''),
            hasActiveLogin,
            isActive: Boolean(userMembership?.is_active && assignment?.is_active),
            hasDeviceAssignment: Boolean(assignment),
            loginExpiresAt: hasActiveLogin ? lease?.expires_at ?? null : null,
            loginHeartbeatAt: hasActiveLogin ? lease?.heartbeat_at ?? null : null,
            venueId: assignment?.venue_id ?? '',
            deviceId: assignment?.device_id ?? '',
          }
        }),
      })
    }

    if (action === 'create-device-with-user') {
      const venueId = String(body.venueId ?? '')
      const deviceName = String(body.deviceName ?? '').trim()
      const deviceMode = String(body.deviceMode ?? '')
      if (!venueId || !deviceName || !['checkout', 'satellite', 'hybrid'].includes(deviceMode)) {
        return response({ error: 'Local, nombre y modo del dispositivo son obligatorios' }, 400)
      }

      const [{ data: venue, error: venueError }, { data: tenant, error: tenantError }] = await Promise.all([
        adminClient.from('venues').select('id, name').eq('tenant_id', tenantId).eq('id', venueId).eq('is_active', true).maybeSingle(),
        adminClient.from('tenants').select('slug').eq('id', tenantId).eq('is_active', true).maybeSingle(),
      ])
      if (venueError || tenantError) throw venueError ?? tenantError
      if (!venue || !tenant) return response({ error: 'El local o el negocio no existen o están desactivados' }, 400)

      const emailDevice = normalizeEmailPart(deviceName) || 'dispositivo'
      const emailVenue = normalizeEmailPart(venue.name, '-') || 'local'
      const emailTenant = normalizeEmailPart(tenant.slug, '-') || 'negocio'
      const password = generateLoginPassword()

      const { data: device, error: deviceError } = await adminClient
        .from('devices')
        .insert({
          tenant_id: tenantId,
          venue_id: venue.id,
          name: deviceName,
          is_active: true,
          device_mode: deviceMode,
          default_cash_register_id: null,
          can_take_orders: true,
          can_take_payments: deviceMode !== 'satellite',
          can_open_cash_session: deviceMode !== 'satellite',
          can_close_cash_session: deviceMode !== 'satellite',
          can_manage_cash: deviceMode !== 'satellite',
        })
        .select('id, venue_id')
        .single()
      if (deviceError) {
        const message = deviceError.code === '23505'
          ? 'Ya existe un dispositivo con ese nombre en el local'
          : deviceError.message || 'No se pudo crear el dispositivo'
        return response({ error: message }, deviceError.code === '23505' || deviceError.code === 'P0001' ? 409 : 500)
      }
      if (!device) throw new Error('No se pudo crear el dispositivo')

      // The stable suffix prevents normalized names such as "Caja 1" and
      // "Caja-1" from attempting to provision the same Auth email.
      const email = `${emailDevice}-${device.id.slice(0, 8)}@${emailVenue}.${emailTenant}`

      const { data: created, error: createError } = await adminClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: deviceName },
      })
      if (createError || !created.user) {
        await adminClient.from('devices').delete().eq('id', device.id)
        return response({ error: createError?.message ?? 'No se pudo crear el usuario del dispositivo' }, 409)
      }

      const userId = created.user.id
      try {
        const { error: membershipSetupError } = await adminClient.from('tenant_memberships').insert({
          tenant_id: tenantId,
          user_id: userId,
          role: 'cashier',
          is_active: true,
        })
        if (membershipSetupError) throw membershipSetupError

        const { error: profileError } = await adminClient.from('profiles').upsert({
          id: userId,
          full_name: deviceName,
        })
        if (profileError) throw profileError

        const { error: assignmentError } = await adminClient.from('device_user_assignments').insert({
          tenant_id: tenantId,
          user_id: userId,
          venue_id: device.venue_id,
          device_id: device.id,
          is_active: true,
        })
        if (assignmentError) throw assignmentError
      } catch (setupError) {
        await adminClient.auth.admin.deleteUser(userId)
        await adminClient.from('devices').delete().eq('id', device.id)
        throw setupError
      }

      return response({ credentials: { email, password }, deviceId: device.id, userId }, 201)
    }

    if (action === 'retire-device') {
      const deviceId = String(body.deviceId ?? '')
      if (!deviceId) return response({ error: 'Dispositivo no válido' }, 400)

      const [{ data: device, error: deviceError }, { data: assignment, error: assignmentError }] = await Promise.all([
        adminClient.from('devices').select('id, is_active').eq('tenant_id', tenantId).eq('id', deviceId).maybeSingle(),
        adminClient.from('device_user_assignments').select('user_id').eq('tenant_id', tenantId).eq('device_id', deviceId).limit(1).maybeSingle(),
      ])
      if (deviceError || assignmentError) throw deviceError ?? assignmentError
      if (!device) return response({ error: 'El dispositivo no existe' }, 404)
      if (assignment) return response({ error: 'El dispositivo tiene un usuario asociado. Elimina o reasigna primero esa cuenta.' }, 409)
      if (!device.is_active) return response({ ok: true })

      const { error: retireError } = await adminClient.from('devices').update({ is_active: false }).eq('tenant_id', tenantId).eq('id', deviceId)
      if (retireError) throw retireError
      return response({ ok: true })
    }

    if (action === 'update') {
      const userId = String(body.userId ?? '')
      const email = String(body.email ?? '').trim().toLowerCase()
      const fullName = String(body.fullName ?? '').trim()
      const password = String(body.password ?? '')
      const deviceId = String(body.deviceId ?? '')
      const deviceMode = String(body.deviceMode ?? '')

      if (!userId || userId === authData.user.id || !email || !fullName || !deviceId || !['checkout', 'satellite', 'hybrid'].includes(deviceMode) || (password && password.length < 8)) {
        return response({ error: 'Nombre, email, dispositivo y modo son obligatorios; la nueva contrasena debe tener al menos 8 caracteres' }, 400)
      }

      const [{ data: userMembership, error: userMembershipError }, { data: device, error: deviceError }, { data: currentAssignment, error: currentAssignmentError }] =
        await Promise.all([
          adminClient
            .from('tenant_memberships')
            .select('is_active')
            .eq('tenant_id', tenantId)
            .eq('user_id', userId)
            .eq('role', 'cashier')
            .maybeSingle(),
          adminClient
            .from('devices')
            .select('id, venue_id, device_mode')
            .eq('tenant_id', tenantId)
            .eq('id', deviceId)
            .eq('is_active', true)
            .maybeSingle(),
          adminClient
            .from('device_user_assignments')
            .select('device_id, venue_id, is_active')
            .eq('tenant_id', tenantId)
            .eq('user_id', userId)
            .maybeSingle(),
        ])

      if (userMembershipError || deviceError || currentAssignmentError) {
        throw userMembershipError ?? deviceError ?? currentAssignmentError
      }
      if (!userMembership) {
        return response({ error: 'El usuario no es un cajero de este negocio' }, 404)
      }
      if (!device) {
        return response({ error: 'El dispositivo seleccionado no existe o esta desactivado' }, 400)
      }

      const { data: occupied, error: occupiedError } = await adminClient
        .from('device_user_assignments')
        .select('user_id')
        .eq('tenant_id', tenantId)
        .eq('device_id', deviceId)
        .eq('is_active', true)
        .neq('user_id', userId)
        .maybeSingle()

      if (occupiedError) {
        throw occupiedError
      }
      if (occupied) {
        return response({ error: 'El dispositivo ya tiene un usuario activo asignado' }, 409)
      }

      const assignmentChanges = !currentAssignment
        || currentAssignment.device_id !== device.id
        || currentAssignment.venue_id !== device.venue_id
      const deviceModeChanges = device.device_mode !== deviceMode

      if (assignmentChanges || (deviceModeChanges && deviceMode === 'satellite')) {
        const [{ data: openSession, error: openSessionError }, { data: openOrder, error: openOrderError }] = await Promise.all([
          adminClient
            .from('cash_sessions')
            .select('id')
            .eq('tenant_id', tenantId)
            .eq('opened_by', userId)
            .eq('status', 'open')
            .limit(1)
            .maybeSingle(),
          adminClient
            .from('orders')
            .select('id')
            .eq('tenant_id', tenantId)
            .eq('opened_by_user_id', userId)
            .eq('status', 'open')
            .limit(1)
            .maybeSingle(),
        ])

        if (openSessionError || openOrderError) {
          throw openSessionError ?? openOrderError
        }
        if (openSession || openOrder) {
          return response({ error: 'Cierra la caja y las comandas abiertas del usuario antes de reasignarlo o cambiarlo a modo satelite' }, 409)
        }
      }

      const authAttributes: { email: string; password?: string; user_metadata: { full_name: string } } = {
        email,
        user_metadata: { full_name: fullName },
      }
      if (password) {
        authAttributes.password = password
      }

      const { error: authUpdateError } = await adminClient.auth.admin.updateUserById(userId, authAttributes)
      if (authUpdateError) {
        return response({ error: authUpdateError.message }, 409)
      }

      const [{ error: profileError }, { error: assignmentError }, { error: deviceUpdateError }] = await Promise.all([
        adminClient.from('profiles').upsert({ id: userId, full_name: fullName }),
        adminClient.from('device_user_assignments').upsert({
          tenant_id: tenantId,
          user_id: userId,
          venue_id: device.venue_id,
          device_id: device.id,
          is_active: userMembership.is_active,
        }, { onConflict: 'tenant_id,user_id' }),
        adminClient.from('devices').update({
          device_mode: deviceMode,
          can_take_orders: true,
          can_take_payments: deviceMode !== 'satellite',
          can_open_cash_session: deviceMode !== 'satellite',
          can_close_cash_session: deviceMode !== 'satellite',
          can_manage_cash: deviceMode !== 'satellite',
        }).eq('tenant_id', tenantId).eq('id', device.id),
      ])

      if (profileError || assignmentError || deviceUpdateError) {
        throw profileError ?? assignmentError ?? deviceUpdateError
      }

      return response({ ok: true })
    }

    if (action === 'delete') {
      const userId = String(body.userId ?? '')
      if (!userId || userId === authData.user.id) {
        return response({ error: 'Usuario no valido' }, 400)
      }

      const { data: targetMemberships, error: targetMembershipsError } = await adminClient
        .from('tenant_memberships')
        .select('tenant_id, role')
        .eq('user_id', userId)

      if (targetMembershipsError) {
        throw targetMembershipsError
      }
      if (!targetMemberships?.some((item) => item.tenant_id === tenantId && item.role === 'cashier')) {
        return response({ error: 'El usuario no es un cajero de este negocio' }, 404)
      }
      if (targetMemberships.length > 1) {
        return response({ error: 'No se puede eliminar una cuenta vinculada a mas de un negocio' }, 409)
      }

      const [{ data: openSession, error: openSessionError }, { data: openOrder, error: openOrderError }] = await Promise.all([
        adminClient
          .from('cash_sessions')
          .select('id')
          .eq('tenant_id', tenantId)
          .eq('opened_by', userId)
          .eq('status', 'open')
          .limit(1)
          .maybeSingle(),
        adminClient
          .from('orders')
          .select('id')
          .eq('tenant_id', tenantId)
          .eq('opened_by_user_id', userId)
          .eq('status', 'open')
          .limit(1)
          .maybeSingle(),
      ])

      if (openSessionError || openOrderError) {
        throw openSessionError ?? openOrderError
      }
      if (openSession || openOrder) {
        return response({ error: 'Cierra la caja y las comandas abiertas del usuario antes de eliminarlo' }, 409)
      }

      const removalResults = await Promise.all([
        adminClient.from('device_user_assignments').delete().eq('tenant_id', tenantId).eq('user_id', userId),
        adminClient.from('tenant_memberships').delete().eq('tenant_id', tenantId).eq('user_id', userId).eq('role', 'cashier'),
        adminClient.from('user_login_leases').delete().eq('user_id', userId),
        adminClient.from('profiles').delete().eq('id', userId),
      ])
      const removalError = removalResults.find((result) => result.error)?.error
      if (removalError) {
        throw removalError
      }

      // El borrado logico conserva las claves foraneas del historico de ventas,
      // pero anonimiza la cuenta Auth y le impide volver a iniciar sesion.
      const { error: deleteAuthError } = await adminClient.auth.admin.deleteUser(userId, true)
      if (deleteAuthError) {
        throw deleteAuthError
      }

      return response({ ok: true })
    }

    if (action === 'set-active') {
      const userId = String(body.userId ?? '')
      const isActive = Boolean(body.isActive)

      if (!userId || userId === authData.user.id) {
        return response({ error: 'Usuario no valido' }, 400)
      }

      const [{ data: targetMembership, error: targetMembershipError }, { data: assignment, error: assignmentError }] = await Promise.all([
        adminClient
          .from('tenant_memberships')
          .select('is_active')
          .eq('tenant_id', tenantId)
          .eq('user_id', userId)
          .eq('role', 'cashier')
          .maybeSingle(),
        adminClient
          .from('device_user_assignments')
          .select('device_id')
          .eq('tenant_id', tenantId)
          .eq('user_id', userId)
          .maybeSingle(),
      ])

      if (targetMembershipError || assignmentError) {
        throw targetMembershipError ?? assignmentError
      }
      if (!targetMembership) {
        return response({ error: 'El usuario no es un cajero de este negocio' }, 404)
      }
      if (isActive && !assignment) {
        return response({ error: 'Edita el usuario y asignale un dispositivo antes de activarlo' }, 409)
      }

      if (isActive && assignment) {
        const { data: occupied, error: occupiedError } = await adminClient
          .from('device_user_assignments')
          .select('user_id')
          .eq('tenant_id', tenantId)
          .eq('device_id', assignment.device_id)
          .eq('is_active', true)
          .neq('user_id', userId)
          .maybeSingle()

        if (occupiedError) {
          throw occupiedError
        }
        if (occupied) {
          return response({ error: 'El dispositivo asignado ya esta ocupado; edita el usuario para elegir otro' }, 409)
        }
      }

      if (!isActive) {
        const [{ data: openSession, error: openSessionError }, { data: openOrder, error: openOrderError }] = await Promise.all([
          adminClient
            .from('cash_sessions')
            .select('id')
            .eq('tenant_id', tenantId)
            .eq('opened_by', userId)
            .eq('status', 'open')
            .limit(1)
            .maybeSingle(),
          adminClient
            .from('orders')
            .select('id')
            .eq('tenant_id', tenantId)
            .eq('opened_by_user_id', userId)
            .eq('status', 'open')
            .limit(1)
            .maybeSingle(),
        ])

        if (openSessionError || openOrderError) {
          throw openSessionError ?? openOrderError
        }
        if (openSession || openOrder) {
          return response({ error: 'Cierra la caja y las comandas abiertas del usuario antes de desactivarlo' }, 409)
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
