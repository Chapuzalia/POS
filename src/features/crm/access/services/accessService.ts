import { isValidTaxRate } from "../../../../lib/tax";
import { normalizeDayChangeTime } from "../../../../lib/operationalDay";
import {
  getFunctionInvokeErrorMessage,
  requireSupabase,
} from "../../shared/services/crmServiceSupport";
import {
  type CatalogProfile,
  type CrmAccessUser,
  type CrmDevice,
  type CrmDeviceAccount,
  type CrmVenue,
  type DeviceMode,
  type TenantContext,
} from "../../../../types";

export type CrmAccessData = {
  venues: CrmVenue[];
  devices: CrmDevice[];
  users: CrmAccessUser[];
};

export const CRM_USER_PASSWORD_MIN_LENGTH = 8;

type CrmDeviceAccountRow = CrmDeviceAccount & {
  deviceId: string;
  venueId: string;
};

export async function loadCrmAccessData(
  context: TenantContext,
): Promise<CrmAccessData> {
  const client = requireSupabase();
  const [
    { data: venueRows, error: venuesError },
    { data: deviceRows, error: devicesError },
    accessResult,
  ] = await Promise.all([
    client
      .from("venues")
      .select(
        "id, name, address, day_change_time, legal_name, tax_id, sort_order, is_active, inventory_enabled, tables_enabled, default_tax_rate, timezone, catalog_profile",
      )
      .eq("tenant_id", context.tenantId)
      .order("sort_order"),
    client
      .from("devices")
      .select(
        "id, venue_id, name, is_active, device_mode, default_cash_register_id",
      )
      .eq("tenant_id", context.tenantId)
      .neq("device_mode", "kds")
      .order("name"),
    client.functions.invoke<{
      allowedVenueIds: string[] | null;
      deviceAccounts: CrmDeviceAccountRow[];
      users: CrmAccessUser[];
    }>("manage-pos-users", {
      body: { action: "list", tenantId: context.tenantId },
    }),
  ]);

  if (venuesError || devicesError || accessResult.error) {
    throw venuesError ?? devicesError ?? accessResult.error;
  }

  const functionError = (accessResult.data as { error?: string } | null)?.error;
  if (functionError) {
    throw new Error(functionError);
  }

  const accountByDeviceId = new Map(
    (accessResult.data?.deviceAccounts ?? []).map((account) => [
      account.deviceId,
      {
        email: account.email,
        fullName: account.fullName,
        hasActiveLogin: account.hasActiveLogin,
        isActive: account.isActive,
        loginExpiresAt: account.loginExpiresAt,
        loginHeartbeatAt: account.loginHeartbeatAt,
        userId: account.userId,
      },
    ]),
  );
  const allowedVenueIds = accessResult.data?.allowedVenueIds;
  const canAccessVenue = (venueId: string) => context.role === "owner"
    || (Array.isArray(allowedVenueIds) && allowedVenueIds.includes(venueId));

  return {
    venues: (venueRows ?? []).filter((venue) => canAccessVenue(venue.id as string)).map((venue) => ({
      id: venue.id as string,
      name: venue.name as string,
      catalogProfile: venue.catalog_profile as CatalogProfile,
      address: (venue.address as string | null) ?? "",
      dayChangeTime: normalizeDayChangeTime(
        venue.day_change_time as string | null,
      ),
      legalName: (venue.legal_name as string | null) ?? "",
      taxId: (venue.tax_id as string | null) ?? "",
      sortOrder: venue.sort_order as number,
      isActive: venue.is_active as boolean,
      inventoryEnabled: venue.inventory_enabled as boolean,
      tablesEnabled: venue.tables_enabled as boolean,
      defaultTaxRate: Number(venue.default_tax_rate),
      timeZone: venue.timezone as string,
    })),
    devices: (deviceRows ?? []).filter((device) => canAccessVenue(device.venue_id as string)).map((device) => ({
      id: device.id as string,
      venueId: device.venue_id as string,
      name: device.name as string,
      isActive: device.is_active as boolean,
      deviceMode: device.device_mode as DeviceMode,
      defaultCashRegisterId: device.default_cash_register_id as string | null,
      account: accountByDeviceId.get(device.id as string) ?? null,
    })),
    users: accessResult.data?.users ?? [],
  };
}

export async function loadCrmVenues(
  context: TenantContext,
): Promise<CrmVenue[]> {
  const client = requireSupabase();
  const [venuesResult, assignmentsResult] = await Promise.all([
    client
      .from("venues")
      .select(
        "id, name, address, day_change_time, legal_name, tax_id, sort_order, is_active, inventory_enabled, tables_enabled, default_tax_rate, timezone, catalog_profile",
      )
      .eq("tenant_id", context.tenantId)
      .order("sort_order"),
    context.role === "manager"
      ? client
        .from("manager_venue_assignments")
        .select("venue_id")
        .eq("tenant_id", context.tenantId)
        .eq("manager_user_id", context.userId)
      : Promise.resolve({ data: null, error: null }),
  ]);
  const { data, error } = venuesResult;
  const assignmentError = assignmentsResult.error;

  if (error || assignmentError) {
    throw error ?? assignmentError;
  }
  const managerVenueIds = context.role === "manager"
    ? new Set((assignmentsResult.data ?? []).map((item) => item.venue_id as string))
    : null;

  return (data ?? []).filter((venue) => !managerVenueIds || managerVenueIds.has(venue.id as string)).map((venue) => ({
    id: venue.id as string,
    name: venue.name as string,
    catalogProfile: venue.catalog_profile as CatalogProfile,
    address: (venue.address as string | null) ?? "",
    dayChangeTime: normalizeDayChangeTime(
      venue.day_change_time as string | null,
    ),
    legalName: (venue.legal_name as string | null) ?? "",
    taxId: (venue.tax_id as string | null) ?? "",
    sortOrder: venue.sort_order as number,
    isActive: venue.is_active as boolean,
    inventoryEnabled: venue.inventory_enabled as boolean,
    tablesEnabled: venue.tables_enabled as boolean,
    defaultTaxRate: Number(venue.default_tax_rate),
    timeZone: venue.timezone as string,
  }));
}

export async function createCrmVenue(
  context: TenantContext,
  name: string,
  catalogProfile: CatalogProfile,
) {
  const client = requireSupabase();
  const { data, error } = await client.functions.invoke<{
    venue?: { id: string; name: string; catalogProfile: CatalogProfile };
    error?: string;
  }>("manage-pos-users", {
    body: {
      action: "create-venue",
      catalogProfile,
      name: name.trim(),
      tenantId: context.tenantId,
    },
  });

  if (error || data?.error) {
    throw new Error(await getFunctionInvokeErrorMessage(
      data,
      error,
      "No se pudo crear el local.",
    ));
  }
  if (!data?.venue) {
    throw new Error("La funcion no devolvio el local creado.");
  }
  return data.venue;
}

export async function updateCrmVenueDefaultTaxRate(
  context: TenantContext,
  venueId: string,
  defaultTaxRate: number,
) {
  if (!isValidTaxRate(defaultTaxRate)) {
    throw new Error("El tipo de IVA debe estar entre 0 y 100.");
  }

  const { error } = await requireSupabase()
    .from("venues")
    .update({ default_tax_rate: defaultTaxRate })
    .eq("tenant_id", context.tenantId)
    .eq("id", venueId);

  if (error) {
    throw error;
  }
}

export type CrmVenueSettingsInput = {
  address: string;
  name: string;
  dayChangeTime: string | null;
  defaultTaxRate: number;
  legalName: string;
  taxId: string;
};

export async function updateCrmVenueSettings(
  context: TenantContext,
  venueId: string,
  input: CrmVenueSettingsInput,
) {
  if (!isValidTaxRate(input.defaultTaxRate)) {
    throw new Error("El tipo de IVA debe estar entre 0 y 100.");
  }

  const address = input.address.trim();
  const dayChangeTime = normalizeDayChangeTime(input.dayChangeTime);
  const legalName = input.legalName.trim();
  const name = input.name.trim();
  const taxId = input.taxId.trim();

  if (!name || name.length > 80) {
    throw new Error("El nombre del local debe tener entre 1 y 80 caracteres.");
  }
  if (address.length > 300) {
    throw new Error("La direcci\u00f3n no puede superar los 300 caracteres.");
  }
  if (legalName.length > 80) {
    throw new Error("La raz\u00f3n social no puede superar los 80 caracteres.");
  }
  if (taxId.length > 80) {
    throw new Error("El NIF/CIF no puede superar los 80 caracteres.");
  }

  const { error } = await requireSupabase()
    .from("venues")
    .update({
      address: address || null,
      day_change_time: dayChangeTime,
      default_tax_rate: input.defaultTaxRate,
      legal_name: legalName || null,
      name,
      tax_id: taxId || null,
    })
    .eq("tenant_id", context.tenantId)
    .eq("id", venueId);

  if (error) {
    throw error;
  }
}

export async function createCrmDevice(
  context: TenantContext,
  venueId: string,
  name: string,
  deviceMode: DeviceMode,
) {
  const client = requireSupabase();
  const { data, error } = await client.functions.invoke<{
    credentials?: { email: string; password: string };
    error?: string;
  }>("manage-pos-users", {
    body: {
      action: "create-device-with-user",
      deviceMode,
      deviceName: name.trim(),
      tenantId: context.tenantId,
      venueId,
    },
  });

  if (error || data?.error || !data?.credentials) {
    throw new Error(
      await getFunctionInvokeErrorMessage(
        data,
        error,
        "No se pudieron crear el dispositivo y su usuario. Revisa la conexión e inténtalo de nuevo.",
      ),
    );
  }
  return data.credentials;
}

export async function createCrmUser(
  context: TenantContext,
  input: {
    email: string;
    password: string;
    role: CrmAccessUser["role"];
    venueIds: string[];
  },
) {
  const email = input.email.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Introduce un email válido.");
  }
  if (
    input.password.length < CRM_USER_PASSWORD_MIN_LENGTH ||
    input.password.length > 72
  ) {
    throw new Error(
      `La contraseña debe tener entre ${CRM_USER_PASSWORD_MIN_LENGTH} y 72 caracteres.`,
    );
  }
  if (!["owner", "manager"].includes(input.role)) {
    throw new Error("Selecciona un rol válido.");
  }

  const client = requireSupabase();
  const { data, error } = await client.functions.invoke<{
    error?: string;
    user?: CrmAccessUser;
  }>("manage-pos-users", {
    body: {
      action: "create-crm-user",
      email,
      password: input.password,
      role: input.role,
      tenantId: context.tenantId,
      venueIds: input.venueIds,
    },
  });

  if (error || data?.error || !data?.user) {
    throw new Error(
      await getFunctionInvokeErrorMessage(
        data,
        error,
        "No se pudo crear el usuario CRM.",
      ),
    );
  }
  return data.user;
}

export async function updateManagerVenueAssignments(
  context: TenantContext,
  managerUserId: string,
  venueIds: string[],
) {
  if (context.role !== "owner") throw new Error("Solo el owner puede asignar locales a managers.");
  if (!venueIds.length) throw new Error("Selecciona al menos un local.");

  const { data, error } = await requireSupabase().functions.invoke<{ error?: string; venueIds?: string[] }>(
    "manage-pos-users",
    {
      body: {
        action: "set-manager-venues",
        managerUserId,
        tenantId: context.tenantId,
        venueIds,
      },
    },
  );
  if (error || data?.error) {
    throw new Error(await getFunctionInvokeErrorMessage(data, error, "No se pudieron actualizar los locales del manager."));
  }
  return data?.venueIds ?? venueIds;
}

export async function updateCrmDevice(
  context: TenantContext,
  deviceId: string,
  input: {
    deviceMode: DeviceMode;
    name: string;
    password?: string;
  },
) {
  const client = requireSupabase();
  const { data, error } = await client.functions.invoke<{
    credentials?: { email: string };
    error?: string;
  }>(
    "manage-pos-users",
    {
      body: {
        action: "update-device",
        deviceId,
        deviceMode: input.deviceMode,
        deviceName: input.name.trim(),
        password: input.password ?? "",
        tenantId: context.tenantId,
      },
    },
  );

  if (error || data?.error) {
    throw new Error(
      await getFunctionInvokeErrorMessage(
        data,
        error,
        "No se pudo actualizar el dispositivo.",
      ),
    );
  }
  return data?.credentials;
}

export async function deleteCrmDevice(
  context: TenantContext,
  deviceId: string,
) {
  const client = requireSupabase();
  const { data, error } = await client.functions.invoke<{ error?: string }>(
    "manage-pos-users",
    {
      body: { action: "delete-device", deviceId, tenantId: context.tenantId },
    },
  );

  if (error || data?.error) {
    throw new Error(
      await getFunctionInvokeErrorMessage(
        data,
        error,
        "No se pudo eliminar el dispositivo.",
      ),
    );
  }
}

export async function releaseCrmDeviceLogin(
  context: TenantContext,
  userId: string,
) {
  const client = requireSupabase();
  const { data, error } = await client.functions.invoke<{ error?: string }>(
    "manage-pos-users",
    {
      body: { action: "release-login", tenantId: context.tenantId, userId },
    },
  );

  if (error) {
    throw error;
  }

  if (data?.error) {
    throw new Error(data.error);
  }
}
