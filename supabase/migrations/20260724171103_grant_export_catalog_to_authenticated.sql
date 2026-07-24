-- Allow authenticated CRM users to call the export RPC.
-- export_catalog remains SECURITY DEFINER and validates that auth.uid()
-- is an active owner/admin of the venue tenant before returning data.
REVOKE ALL ON FUNCTION public.export_catalog(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.export_catalog(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.export_catalog(uuid) TO service_role;
