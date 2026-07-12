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
